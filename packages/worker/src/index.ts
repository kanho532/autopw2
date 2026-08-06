// AutoPW Fixture Worker for M1. The fixture is deterministic, but the durable
// Operation/Run boundary matches the later browser worker implementation.
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger, OperationRegistry, RunSnapshot } from "@autopw/operation-registry";

const RUN_PREFIX = "run_";
const PHASE_PATH = [
  "CREATED", "TARGET_READY", "SEED_RESOLVED", "DISCOVERED", "COVERAGE_DERIVED",
  "PLAN_FILLED", "PLAN_FROZEN", "SUITE_GENERATED", "SUITE_FROZEN", "RUNNING",
  "EXECUTION_FINISHED", "RUNTIME_FINALIZED", "AUDITED", "REPORTED"
] as const;

type Request = Record<string, unknown>;
type WorkerKind = "run" | "preview" | "maintenance";
type ToolName = string;

interface RunState extends RunSnapshot {
  leased_by: number;
  lease_owner: string;
  cancel_requested: boolean;
}

interface WorkerOptions {
  registry: OperationRegistry;
  budgets?: Partial<{ installation: number; workspace: number; global: number; workspacePerRun: number }>;
  logger?: Logger;
  stepMs?: number;
}

interface QueueItem {
  operation_id: string;
  kind: WorkerKind;
  request: Request;
  toolName?: ToolName;
}

function genRun(): string { return RUN_PREFIX + crypto.randomBytes(10).toString("hex"); }

export class FixtureWorker {
  readonly registry: OperationRegistry;
  readonly runs = new Map<string, RunState>();
  queue: QueueItem[] = [];
  readonly budgets: { installation: number; workspace: number; global: number; workspacePerRun: number };
  readonly running = new Set<string>();
  readonly runningByWorkspace = new Map<string, number>();
  readonly log: Logger;
  readonly stepMs: number;
  stopped = false;
  readonly tick: () => Promise<void>;

  constructor({ registry, budgets, logger, stepMs }: WorkerOptions) {
    this.registry = registry;
    this.budgets = Object.assign({ installation: 8, workspace: 4, global: 16, workspacePerRun: 2 }, budgets || {});
    this.log = logger || { info: () => {}, warn: () => {}, error: () => {} };
    this.stepMs = stepMs ?? 8;
    this.tick = this._tick.bind(this);
    this._resyncFromRegistry();
  }

  private _resyncFromRegistry(): void {
    for (const record of this.registry.byId.values()) {
      if (!record.run_id || record.tombstoned) continue;
      const persisted: RunState = {
        run_id: record.run_id,
        operation_id: record.operation_id,
        workspace_id: record.workspace_id,
        phase: record.phase || "CREATED",
        run_status: record.run_status || (record.status === "COMPLETED" ? "COMPLETED" : "ACTIVE"),
        audit_status: record.audit_status || null,
        gate: record.gate || null,
        fatal_class: record.fatal_class || null,
        progress_pct: record.progress_pct || 0,
        next_action: record.next_action || "poll get_run_status",
        cancel_requested: Boolean(record.cancel_requested),
        leased_by: process.pid,
        lease_owner: "fixture-worker"
      };
      const current = this.runs.get(record.run_id);
      if (current) Object.assign(current, persisted);
      else this.runs.set(record.run_id, persisted);
      if (["ACCEPTED", "RUNNING"].includes(record.status) && persisted.run_status === "ACTIVE") {
        this.enqueue(record.operation_id, record.kind, record.params, record.tool);
      }
    }
  }

  start(): void { this.stopped = false; this._resyncFromRegistry(); }
  stop(): void { this.stopped = true; this.queue = []; }
  reload(): void { this.start(); }

  createFixtureRun({ workspace_id, operation_id }: { workspace_id: string; operation_id: string }): RunState {
    const run: RunState = {
      run_id: genRun(), operation_id, workspace_id, phase: "CREATED", run_status: "ACTIVE",
      audit_status: null, gate: null, fatal_class: null, progress_pct: 0,
      next_action: "poll get_run_status", cancel_requested: false,
      leased_by: process.pid, lease_owner: "fixture-worker"
    };
    this.runs.set(run.run_id, run);
    return run;
  }

  getRun(run_id: string): RunState | undefined { return this.runs.get(run_id); }

  enqueue(operation_id: string, kind: WorkerKind, request: Request, toolName: ToolName = String(request.tool || "")): void {
    if (this.stopped || this.running.has(operation_id) || this.queue.some((item) => item.operation_id === operation_id)) return;
    this.queue.push({ operation_id, kind, request: request || {}, toolName });
    Promise.resolve().then(this.tick);
  }

  private async _tick(): Promise<void> {
    if (this.stopped || this.running.size >= this.budgets.installation || this.running.size >= this.budgets.global) return;
    const slot = this.queue.shift();
    if (!slot) return;
    const workspaceId = String(slot.request.workspace_id || "");
    const workspaceRunning = this.runningByWorkspace.get(workspaceId) || 0;
    if (workspaceRunning >= this.budgets.workspace) {
      this.queue.unshift(slot);
      return;
    }
    this.running.add(slot.operation_id);
    this.runningByWorkspace.set(workspaceId, workspaceRunning + 1);
    this._run(slot.operation_id, slot.kind, slot.request, slot.toolName).finally(() => {
      this.running.delete(slot.operation_id);
      this.runningByWorkspace.set(workspaceId, Math.max(0, (this.runningByWorkspace.get(workspaceId) || 1) - 1));
      Promise.resolve().then(this.tick);
    });
  }

  private async _run(operation_id: string, kind: WorkerKind, request: Request, toolName?: ToolName): Promise<void> {
    const operation = this.registry.get(operation_id);
    if (!operation) return;
    if (toolName === "derive_coverage" || kind === "preview") {
      await sleep(this.stepMs * 2);
      this.registry.update(operation_id, (record) => {
        record.status = "COMPLETED";
        record.result_ref = { handle: "art_cdd_" + operation_id, kind: "cdd.json" };
        record.result_summary = { skeleton_count: 12, blockers: 0, draft: "CDD Draft (fixture)" };
        return record;
      });
      return;
    }
    if (toolName === "cancel_run") {
      const cancelled = this.requestCancel(String(request.run_id));
      this.registry.update(operation_id, (record) => {
        record.status = "COMPLETED";
        record.result_summary = { cancelled, run_id: request.run_id };
        return record;
      });
      return;
    }
    if (toolName === "cleanup_run") {
      const result = this.cleanup(String(request.run_id));
      this.registry.update(operation_id, (record) => {
        record.status = result.ok ? "COMPLETED" : "FAILED";
        record.result_summary = result;
        return record;
      });
      return;
    }

    const run = this.runs.get(operation.run_id || "");
    if (!run) {
      this.registry.update(operation_id, (record) => { record.status = "FAILED"; return record; });
      return;
    }
    if (run.run_status === "COMPLETED" && toolName === "resume_run") {
      this.registry.update(operation_id, (record) => { record.status = "COMPLETED"; record.result_summary = { resumed: false, reason: "run already terminal" }; return record; });
      return;
    }
    if (run.run_status === "ACTIVE" && toolName === "resume_run" && run.operation_id !== operation_id) {
      this.registry.update(operation_id, (record) => { record.status = "COMPLETED"; record.result_summary = { resumed: false, reason: "run already active" }; return record; });
      return;
    }
    if (run.run_status !== "ACTIVE" && run.run_status !== "INTERRUPTED") {
      this.registry.update(operation_id, (record) => { record.status = "FAILED"; return record; });
      return;
    }
    if (toolName === "resume_run" && run.run_status === "INTERRUPTED") {
      run.run_status = "ACTIVE";
      run.next_action = "resumed by fixture-worker";
      this._persistRun(run, "RUNNING");
    }

    const currentIndex = PHASE_PATH.indexOf(run.phase as (typeof PHASE_PATH)[number]);
    const startIndex = currentIndex < 0 ? 0 : currentIndex + 1;
    for (let index = startIndex; index < PHASE_PATH.length; index += 1) {
      if (run.cancel_requested) { this._finalizeCancelled(run); return; }
      run.phase = PHASE_PATH[index];
      run.progress_pct = Math.round(((index + 1) / (PHASE_PATH.length + 1)) * 100);
      run.next_action = "poll get_run_status";
      this._persistRun(run, "RUNNING");
      await sleep(this.stepMs);
    }
    if (run.cancel_requested) { this._finalizeCancelled(run); return; }
    run.phase = "GATED";
    run.run_status = "COMPLETED";
    run.audit_status = "COMPLETE";
    run.gate = "pass";
    run.progress_pct = 100;
    run.next_action = "get_run_result";
    this._persistRun(run, "COMPLETED");
  }

  private _persistRun(run: RunState, operationStatus: "RUNNING" | "COMPLETED"): void {
    this.registry.updateRun(run, { operationStatus });
  }

  requestCancel(run_id: string): boolean {
    const run = this.runs.get(run_id);
    if (!run || run.phase === "GATED" || run.run_status === "FAILED" || run.run_status === "COMPLETED") return false;
    run.cancel_requested = true;
    run.phase = "TERMINALIZING";
    run.next_action = "finalize cancellation";
    this._persistRun(run, "RUNNING");
    if (!this.running.has(run.operation_id)) this._finalizeCancelled(run);
    return true;
  }

  private _finalizeCancelled(run: RunState): void {
    run.phase = "GATED";
    run.run_status = "COMPLETED";
    run.audit_status = "INCOMPLETE";
    run.gate = "incomplete";
    run.next_action = "get_run_result";
    this._persistRun(run, "COMPLETED");
  }

  cleanup(run_id: string): { ok: boolean; cleaned?: string[]; idempotent?: boolean; run_id?: string; code?: string } {
    const run = this.runs.get(run_id);
    if (!run) return { ok: false, code: "RUN_NOT_FOUND" };
    return { ok: true, cleaned: ["seed_data", "temp_browser"], idempotent: true, run_id };
  }
}
