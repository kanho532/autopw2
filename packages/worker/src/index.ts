// AutoPW Fixture Worker for M1. The fixture is deterministic, but the durable
// Operation/Run boundary matches the later browser worker implementation.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger, OperationRegistry, RunSnapshot } from "@autopw/operation-registry";
import type { AuditVerticalSlice, CoveragePreview, VerticalResult } from "@autopw/core";
import { DEFAULT_LEASE_POLICY, isLeaseStale, newLease, observeLease, releaseLease, takeoverLease, type LeasePolicy, type RunLease } from "./lease.js";
export type { LeasePolicy, RunLease } from "./lease.js";

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
  state_version: number;
  leased_by: number;
  lease_owner: string;
  lease: RunLease;
  cancel_requested: boolean;
  resume_attempts: number;
  execution_states?: Record<string, { status: string; resumability?: "SAFE_RETRY" | "RESET_REQUIRED" | "NON_RESUMABLE" }>;
}

interface WorkerOptions {
  registry: OperationRegistry;
  budgets?: Partial<{ installation: number; workspace: number; global: number; workspacePerRun: number }>;
  logger?: Logger;
  stepMs?: number;
  runtime?: AuditVerticalSlice;
  leasePolicy?: Partial<LeasePolicy>;
}

interface QueueItem {
  operation_id: string;
  kind: WorkerKind;
  request: Request;
  toolName?: ToolName;
}

function genRun(): string { return RUN_PREFIX + crypto.randomBytes(10).toString("hex"); }
const ACTIVE_WORKER_IDS = new Set<string>();

export class FixtureWorker {
  readonly registry: OperationRegistry;
  readonly runs = new Map<string, RunState>();
  queue: QueueItem[] = [];
  readonly budgets: { installation: number; workspace: number; global: number; workspacePerRun: number };
  readonly running = new Set<string>();
  readonly runningByWorkspace = new Map<string, number>();
  readonly runningByRun = new Map<string, number>();
  readonly inFlight = new Set<Promise<void>>();
  readonly log: Logger;
  readonly stepMs: number;
  readonly runtime?: AuditVerticalSlice;
  readonly workerId: string;
  readonly leasePolicy: LeasePolicy;
  stopped = false;
  readonly crashedRuns = new Set<string>();
  readonly tick: () => Promise<void>;

  constructor({ registry, budgets, logger, stepMs, runtime, leasePolicy }: WorkerOptions) {
    this.registry = registry;
    this.budgets = Object.assign({ installation: 8, workspace: 4, global: 16, workspacePerRun: 2 }, budgets || {});
    this.log = logger || { info: () => {}, warn: () => {}, error: () => {} };
    this.stepMs = stepMs ?? 8;
    this.runtime = runtime;
    this.workerId = "fixture-worker-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
    this.leasePolicy = { ...DEFAULT_LEASE_POLICY, ...(leasePolicy || {}) };
    if (this.leasePolicy.lease_ttl_ms < this.leasePolicy.heartbeat_interval_ms * this.leasePolicy.lease_safety_factor || this.leasePolicy.lease_safety_factor < 4 || this.leasePolicy.takeover_grace_ms < this.leasePolicy.heartbeat_interval_ms * 2) throw new Error("INVALID_LEASE_POLICY");
    ACTIVE_WORKER_IDS.add(this.workerId);
    this.tick = this._tick.bind(this);
    this._resyncFromRegistry();
  }

  private _resyncFromRegistry(): void {
    for (const record of this.registry.byId.values()) {
      if (!record.run_id || record.tombstoned) continue;
      const stored = this.runtime?.storage.readJson<RunState>(record.run_id, "run_state.json");
      const persisted: RunState = stored || {
        state_version: 1,
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
        results_ref: record.results_ref,
        report_ref: record.report_ref,
        gate_summary: record.gate_summary,
        evidence_refs: record.evidence_refs,
        cases: record.cases,
        audit_summary: record.audit_summary,
        leased_by: process.pid,
        lease_owner: this.workerId,
        lease: newLease(this.workerId, process.pid, this.leasePolicy),
        resume_attempts: 0
      };
      if (stored) { persisted.leased_by = stored.lease?.owner_pid || process.pid; persisted.lease_owner = stored.lease?.owner || ""; }
      persisted.state_version = persisted.state_version || 1;
      const current = this.runs.get(record.run_id);
      if (current) Object.assign(current, persisted);
      else this.runs.set(record.run_id, persisted);
      if (["ACCEPTED", "RUNNING"].includes(record.status) && persisted.run_status === "ACTIVE") {
        this.enqueue(record.operation_id, record.kind, record.params, record.tool);
      }
    }
  }

  start(): void { this.stopped = false; ACTIVE_WORKER_IDS.add(this.workerId); this._resyncFromRegistry(); }
  async stop(): Promise<void> {
    this.stopped = true;
    ACTIVE_WORKER_IDS.delete(this.workerId);
    this.queue = [];
    await Promise.allSettled([...this.inFlight]);
  }
  reload(): void { this.start(); }

  createFixtureRun({ workspace_id, operation_id }: { workspace_id: string; operation_id: string }): RunState {
    const lease = newLease(this.workerId, process.pid, this.leasePolicy);
    const run: RunState = {
      state_version: 1, run_id: genRun(), operation_id, workspace_id, phase: "CREATED", run_status: "ACTIVE",
      audit_status: null, gate: null, fatal_class: null, progress_pct: 0,
      next_action: "poll get_run_status", cancel_requested: false,
      leased_by: process.pid, lease_owner: this.workerId, lease, resume_attempts: 0
    };
    this.runs.set(run.run_id, run);
    this._writeRunState(run);
    return run;
  }

  getRun(run_id: string): RunState | undefined { return this.runs.get(run_id); }

  inspectLease(run_id: string): RunLease | undefined { return this.runs.get(run_id)?.lease; }

  observeRunLease(run_id: string, timestamp = Date.now(), alive: boolean | "unknown" = "unknown"): RunLease | undefined {
    const run = this.runs.get(run_id); if (!run) return undefined;
    run.lease = observeLease(run.lease, timestamp, { alive }); this._writeRunState(run); return run.lease;
  }

  attemptTakeover(run_id: string, timestamp = Date.now()): boolean {
    const run = this.runs.get(run_id); if (!run) return false;
    const alive = run.lease.owner ? ACTIVE_WORKER_IDS.has(run.lease.owner) : false;
    const next = takeoverLease(run.lease, this.workerId, process.pid, timestamp, { alive });
    if (!next) return false;
    if (!this._commitTakeover(run, next, run.lease.state_version)) return false;
    this.crashedRuns.delete(run_id);
    run.lease_owner = this.workerId; run.leased_by = process.pid; run.run_status = "ACTIVE"; run.next_action = "resumed by " + this.workerId; this._persistRun(run, "RUNNING"); return true;
  }

  simulateWorkerCrash(run_id: string, timestamp = Date.now()): void {
    const run = this.runs.get(run_id); if (!run) return;
    this.crashedRuns.add(run_id); run.run_status = "INTERRUPTED"; run.next_action = "worker crash recovery required"; run.lease = { ...run.lease, heartbeat_at: timestamp - run.lease.policy.lease_ttl_ms - run.lease.policy.takeover_grace_ms - run.lease.policy.clock_skew_tolerance_ms - 1, expires_at: timestamp - 1, stale_confirmations: 0 }; this._writeRunState(run); this.registry.updateRun(run, { operationStatus: "RUNNING" }); ACTIVE_WORKER_IDS.delete(this.workerId);
  }

  async preflight(request: Request): Promise<CoveragePreview> {
    if (!this.runtime) throw new Error("M3_RUNTIME_NOT_CONFIGURED");
    return this.runtime.preflight({ request });
  }

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
    const operation = this.registry.get(slot.operation_id);
    const runId = operation?.run_id || (typeof slot.request.run_id === "string" ? slot.request.run_id : "");
    const runRunning = runId ? (this.runningByRun.get(runId) || 0) : 0;
    if (runId && runRunning >= this.budgets.workspacePerRun) {
      this.queue.unshift(slot);
      return;
    }
    this.running.add(slot.operation_id);
    this.runningByWorkspace.set(workspaceId, workspaceRunning + 1);
    if (runId) this.runningByRun.set(runId, runRunning + 1);
    const task = this._run(slot.operation_id, slot.kind, slot.request, slot.toolName).finally(() => {
      this.running.delete(slot.operation_id);
      this.runningByWorkspace.set(workspaceId, Math.max(0, (this.runningByWorkspace.get(workspaceId) || 1) - 1));
      if (runId) this.runningByRun.set(runId, Math.max(0, (this.runningByRun.get(runId) || 1) - 1));
      this.inFlight.delete(task);
      Promise.resolve().then(this.tick);
    });
    this.inFlight.add(task);
  }

  private async _run(operation_id: string, kind: WorkerKind, request: Request, toolName?: ToolName): Promise<void> {
    const operation = this.registry.get(operation_id);
    if (!operation) return;
    if (this.runtime && toolName === "run_audit") {
      const run = this.runs.get(operation.run_id || "");
      if (!run) { this.registry.update(operation_id, (record) => { record.status = "FAILED"; return record; }); return; }
      if (run.lease.owner !== this.workerId && !this._prepareResume(run)) return;
      try {
        const result: VerticalResult = await this.runtime.execute({
          run,
          request,
          onPhase: (phase, progress, nextAction) => { if (run.cancel_requested || this.crashedRuns.has(run.run_id)) return; run.phase = phase; run.progress_pct = progress; run.next_action = nextAction; this._persistRun(run, phase === "GATED" ? "COMPLETED" : "RUNNING"); }
        });
        if (this.crashedRuns.has(run.run_id)) return;
        if (run.cancel_requested) return;
        run.run_status = "COMPLETED";
        run.phase = "GATED";
        run.audit_status = result.audit_status;
        run.gate = result.gate;
        run.progress_pct = 100;
        run.next_action = "get_run_result";
        run.results_ref = result.results_ref;
        run.report_ref = result.report_ref;
        run.gate_summary = result.gate_summary;
        run.cases = result.cases;
        run.evidence_refs = result.evidence_refs;
        run.audit_summary = { audit_status: result.audit_status };
        this._persistRun(run, "COMPLETED");
      } catch (error) {
        this.log.error(error);
        if ((error as { code?: string }).code === "PLAN_DEFECT") { this._finalizePlanDefect(run, error instanceof Error ? error.message : String(error)); return; }
        if (this._isInfrastructureError(error)) {
          this._finalizeInfrastructureFailure(run, error instanceof Error ? error.message : String(error));
          return;
        }
        run.run_status = "FAILED";
        run.fatal_class = "STATE_CORRUPTED";
        run.next_action = "inspect failure artifact";
        this._persistRun(run, "FAILED");
      }
      return;
    }
    if (toolName === "derive_coverage" || kind === "preview") {
      await sleep(this.stepMs * 2);
      const preview = this.runtime ? await this.runtime.preview({ request, operationId: operation_id }) : undefined;
      // The retention sweeper may reclaim an expired preview while Discovery
      // is still in flight. A late result must not recreate or mutate a
      // deleted Operation record.
      if (!this.registry.get(operation_id)) return;
      this.registry.update(operation_id, (record) => {
        record.status = "COMPLETED";
        record.result_ref = (preview?.result_ref || { handle: "art_cdd_" + operation_id, kind: "cdd.json" }) as unknown as Record<string, unknown>;
        record.result_summary = preview?.summary || { skeleton_count: 0, blockers: 0, draft: "CDD Draft" };
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
    if (run.run_status !== "ACTIVE" && run.run_status !== "INTERRUPTED") {
      this.registry.update(operation_id, (record) => { record.status = "FAILED"; return record; });
      return;
    }
    if (toolName === "resume_run") {
      if (run.run_status === "ACTIVE" && run.lease.owner === this.workerId) {
        this.registry.update(operation_id, (record) => { record.status = "COMPLETED"; record.result_summary = { resumed: false, reason: "run already active" }; return record; });
        return;
      }
      if (!this._prepareResume(run)) { this.registry.update(operation_id, (record) => { record.status = "COMPLETED"; record.result_summary = { resumed: false, reason: "lease not stale or takeover lost" }; return record; }); return; }
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

  private _persistRun(run: RunState, operationStatus: "RUNNING" | "COMPLETED" | "FAILED"): void {
    if (this.crashedRuns.has(run.run_id)) return;
    if (operationStatus === "RUNNING" && run.lease.owner === this.workerId) {
      const now = Date.now(); run.lease = { ...run.lease, heartbeat_at: now, expires_at: now + run.lease.policy.lease_ttl_ms, state_version: run.lease.state_version + 1, stale_confirmations: 0 };
    }
    if (operationStatus === "COMPLETED" || operationStatus === "FAILED") run.lease = releaseLease(run.lease);
    run.state_version += 1;
    this._writeRunState(run);
    this.registry.updateRun(run, { operationStatus });
  }

  private _writeRunState(run: RunState): void { if (this.runtime) this.runtime.storage.writeJson(run.run_id, "run_state.json", run); }

  private _prepareResume(run: RunState): boolean {
    if (run.resume_attempts >= 3) { this._finalizeResumeExhausted(run); return false; }
    const now = Date.now();
    const alive = run.lease.owner ? ACTIVE_WORKER_IDS.has(run.lease.owner) : false;
    const observedVersion = run.lease.state_version;
    run.lease = observeLease(run.lease, now, { alive });
    if (!isLeaseStale(run.lease, now, { alive })) return false;
    const next = takeoverLease(run.lease, this.workerId, process.pid, now, { alive });
    if (!next) return false;
    if (!this._commitTakeover(run, next, observedVersion)) return false;
    this.crashedRuns.delete(run.run_id);
    run.lease_owner = this.workerId; run.leased_by = process.pid; run.run_status = "ACTIVE"; run.resume_attempts += 1; run.next_action = "resumed by " + this.workerId; this._persistRun(run, "RUNNING");
    return true;
  }

  private _commitTakeover(run: RunState, next: RunLease, expectedVersion: number): boolean {
    if (!this.runtime) { run.lease = next; return true; }
    const committed = this.runtime.storage.compareAndSwapJson<RunState>(run.run_id, "run_state.json", expectedVersion, (current) => ({ ...current, lease: next }));
    if (!committed) return false;
    Object.assign(run, committed); return true;
  }

  private _isInfrastructureError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /(playwright|chromium|browser|executable|econn|eacces|enoent|timeout|target)/i.test(message);
  }

  private _finalizeInfrastructureFailure(run: RunState, message: string): void {
    if (run.phase !== "TERMINALIZING" && run.phase !== "GATED") {
      run.phase = "TERMINALIZING";
      run.next_action = "inspect infrastructure failure";
      this._persistRun(run, "RUNNING");
    }
    if (run.phase === "GATED") return;
    for (const phase of ["RUNTIME_FINALIZED", "AUDITED", "REPORTED", "GATED"] as const) {
      run.phase = phase;
      if (phase === "AUDITED") run.audit_status = "INCOMPLETE";
      if (phase === "GATED") {
        run.run_status = "COMPLETED";
        run.gate = "infra";
        run.gate_summary = { reason: "infrastructure failure", message };
        run.next_action = "get_run_result";
      }
      this._persistRun(run, phase === "GATED" ? "COMPLETED" : "RUNNING");
    }
  }

  private _finalizePlanDefect(run: RunState, message: string): void {
    if (run.phase !== "TERMINALIZING" && run.phase !== "GATED") { run.phase = "TERMINALIZING"; run.next_action = "inspect planner defect"; this._persistRun(run, "RUNNING"); }
    for (const phase of ["RUNTIME_FINALIZED", "AUDITED", "REPORTED", "GATED"] as const) {
      run.phase = phase; if (phase === "AUDITED") run.audit_status = "INCOMPLETE";
      if (phase === "GATED") { run.run_status = "COMPLETED"; run.gate = "incomplete"; run.gate_summary = { reason: "planner defect", message }; run.next_action = "get_run_result"; }
      this._persistRun(run, phase === "GATED" ? "COMPLETED" : "RUNNING");
    }
  }

  private _finalizeResumeExhausted(run: RunState): void {
    if (run.phase !== "TERMINALIZING" && run.phase !== "GATED") { run.phase = "TERMINALIZING"; run.next_action = "resume attempts exhausted"; this._persistRun(run, "RUNNING"); }
    for (const phase of ["RUNTIME_FINALIZED", "AUDITED", "REPORTED", "GATED"] as const) {
      run.phase = phase;
      if (phase === "AUDITED") run.audit_status = "INCOMPLETE";
      if (phase === "GATED") { run.run_status = "COMPLETED"; run.gate = "incomplete"; run.gate_summary = { reason: "resume attempts exhausted", code: "MAX_RESUME_ATTEMPTS" }; run.next_action = "get_run_result"; }
      this._persistRun(run, phase === "GATED" ? "COMPLETED" : "RUNNING");
    }
  }

  requestCancel(run_id: string): boolean {
    const run = this.runs.get(run_id);
    if (!run || run.phase === "GATED" || run.run_status === "FAILED" || run.run_status === "COMPLETED") return false;
    run.cancel_requested = true;
    run.phase = "TERMINALIZING";
    run.next_action = "finalize cancellation";
    this._persistRun(run, "RUNNING");
    if (!this.running.has(run.operation_id) || this.runtime) this._finalizeCancelled(run);
    return true;
  }

  private _finalizeCancelled(run: RunState): void {
    // Cancellation follows the frozen terminalization path; it must not jump
    // directly from TERMINALIZING to GATED.
    for (const phase of ["RUNTIME_FINALIZED", "AUDITED", "REPORTED", "GATED"] as const) {
      run.phase = phase;
      if (phase === "AUDITED") run.audit_status = "INCOMPLETE";
      if (phase === "GATED") {
        run.run_status = "COMPLETED";
        run.gate = "incomplete";
        run.next_action = "get_run_result";
      }
      this._persistRun(run, phase === "GATED" ? "COMPLETED" : "RUNNING");
    }
  }

  cleanup(run_id: string): { ok: boolean; cleaned?: string[]; idempotent?: boolean; run_id?: string; code?: string } {
    const run = this.runs.get(run_id);
    if (!run) return { ok: false, code: "RUN_NOT_FOUND" };
    const cleaned: string[] = [];
    if (this.runtime) {
      const seed = path.join(this.runtime.storage.runDir(run_id), "seed.json");
      if (fs.existsSync(seed)) { fs.rmSync(seed, { force: true }); cleaned.push("seed_data"); }
    }
    if (!cleaned.includes("seed_data")) cleaned.push("seed_data");
    cleaned.push("temp_browser");
    return { ok: true, cleaned, idempotent: true, run_id };
  }
}
