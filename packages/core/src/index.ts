import path from "node:path";
import { auditExecution } from "@autopw/audit";
import { compileFixturePlan, suiteDigest } from "@autopw/compiler";
import { FIXTURE_PLAN, startDemoTarget, type FixtureVariant } from "@autopw/execution-fixture";
import { PlaywrightFixtureRunner } from "@autopw/execution";
import { evaluateGate } from "@autopw/gate";
import { writeReport } from "@autopw/reporting";
import { RunStorage, type ArtifactRef } from "@autopw/run-storage";
import type { RunSnapshot } from "@autopw/operation-registry";

export interface VerticalRun extends RunSnapshot { phase: string; }
export interface VerticalResult { gate: "incomplete" | "infra" | "fail" | "unstable" | "pass"; audit_status: "COMPLETE" | "INCOMPLETE"; results_ref: ArtifactRef; report_ref: ArtifactRef; gate_summary: Record<string, unknown>; cases: Record<string, unknown>[]; evidence_refs: ArtifactRef[]; }
type PhaseCallback = (phase: string, progress: number, nextAction: string) => void;

export class AuditVerticalSlice {
  readonly root: string;
  readonly storage: RunStorage;
  readonly runner = new PlaywrightFixtureRunner();

  constructor({ root, dataRoot }: { root: string; dataRoot: string }) {
    this.root = path.resolve(root);
    this.storage = new RunStorage(dataRoot);
  }

  async execute({ run, request, onPhase }: { run: VerticalRun; request: Record<string, unknown>; onPhase: PhaseCallback }): Promise<VerticalResult> {
    const variant = this.variant(request.fixture_variant);
    const startedAt = new Date().toISOString();
    const commitPhase = (phase: string, progress: number, nextAction: string): void => { this.storage.appendEvent(run.run_id, { kind: "PHASE_COMMITTED", phase, detail: { progress, next_action: nextAction } }); onPhase(phase, progress, nextAction); };
    this.storage.runDir(run.run_id);
    this.storage.writeJson(run.run_id, "request.json", request);
    this.storage.writeJson(run.run_id, "host-context.json", { workspace_id: run.workspace_id, trust_mode: "trusted", root: this.root });
    this.storage.appendEvent(run.run_id, { kind: "RUN_CREATED", phase: "CREATED", detail: { variant } });
    commitPhase("TARGET_READY", 8, "poll get_run_status");
    const target = await startDemoTarget(variant);
    try {
      this.storage.writeJson(run.run_id, "target.json", { base_url: "loopback", health: "ready", started_at: startedAt });
      commitPhase("SEED_RESOLVED", 15, "poll get_run_status");
      this.storage.writeJson(run.run_id, "seed.json", { result: "SKIPPED", reset_capable: true, idempotent: true, at: new Date().toISOString() });
      commitPhase("DISCOVERED", 24, "poll get_run_status");
      this.storage.writeJson(run.run_id, "discovery.json", { schema_version: "2.1", observations: [{ kind: "fixture_target", value: "demo form" }], candidates: [{ id: "candidate_demo_form" }], scenario_observations: FIXTURE_PLAN.cases.map((item) => ({ feature_id: item.feature_id, scenario: item.scenario, observed: true, blocker: false })) });
      commitPhase("COVERAGE_DERIVED", 30, "poll get_run_status");
      commitPhase("PLAN_FILLED", 36, "poll get_run_status");
      const compiled = compileFixturePlan(FIXTURE_PLAN);
      this.storage.writeJson(run.run_id, "plan.json", compiled.plan);
      this.storage.writeJson(run.run_id, "mapping-audit.json", compiled.mappingAudit);
      commitPhase("PLAN_FROZEN", 42, "poll get_run_status");
      commitPhase("SUITE_GENERATED", 48, "poll get_run_status");
      this.storage.writeArtifact(run.run_id, "suite.ts", "suite.ts", compiled.source);
      this.storage.writeJson(run.run_id, "suite-manifest.json", { digest: suiteDigest(compiled.source), forbidden_imports: false });
      commitPhase("SUITE_FROZEN", 54, "poll get_run_status");
      commitPhase("RUNNING", 60, "poll get_run_status");
      const execution = await this.runner.run({ runId: run.run_id, baseUrl: target.baseUrl, plan: compiled.plan, variant, storage: this.storage });
      commitPhase("EXECUTION_FINISHED", 78, "poll get_run_status");
      const audit = auditExecution(compiled.plan.cases.map((item) => item.case_id), execution.results);
      this.storage.writeJson(run.run_id, "completion-audit.json", audit);
      this.storage.writeJson(run.run_id, "issues.json", { schema_version: "2.1", issues: audit.issues });
      commitPhase("RUNTIME_FINALIZED", 84, "poll get_run_status");
      commitPhase("AUDITED", 89, "poll get_run_status");
      const gate = evaluateGate({ auditStatus: audit.audit_status, issues: audit.issues });
      const resultRef: ArtifactRef = { handle: "art_" + run.run_id.slice(4, 12) + "_results", kind: "results.json" };
      const results = { schema_version: "2.1", run_id: run.run_id, gate: gate.gate, audit_status: audit.audit_status, exit_code: gate.exit_code, results_ref: resultRef, summary: audit.summary, issues: audit.issues };
      this.storage.writeArtifact(run.run_id, "results.json", "results.json", JSON.stringify(results, null, 2) + "\n");
      const report = writeReport({ storage: this.storage, runId: run.run_id, gate: gate.gate, auditStatus: audit.audit_status, summary: audit.summary, issues: audit.issues, resultsRef: resultRef });
      commitPhase("REPORTED", 96, "poll get_run_status");
      commitPhase("GATED", 100, "get_run_result");
      return { gate: gate.gate, audit_status: audit.audit_status, results_ref: { ...resultRef, size_bytes: this.storage.readArtifact(run.run_id, "results.json").length }, report_ref: report.reportRef, gate_summary: { ...audit.summary, reason: gate.reason, issues: audit.issues }, cases: execution.results.map((item) => ({ case_id: item.case_id, execution_id: item.execution_id, status: item.status, error: item.error, evidence_refs: item.evidence_refs })), evidence_refs: execution.results.flatMap((item) => item.evidence_refs) };
    } finally { await target.close(); }
  }

  private variant(value: unknown): FixtureVariant { return value === "fail" || value === "incomplete" ? value : "pass"; }
}
