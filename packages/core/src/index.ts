import path from "node:path";
import { auditExecution } from "@autopw/audit";
import { compileFixturePlan, suiteDigest } from "@autopw/compiler";
import { FIXTURE_PLAN, startDemoTarget, type FixtureVariant } from "@autopw/execution-fixture";
import { PlaywrightFixtureRunner } from "@autopw/execution";
import { evaluateGate } from "@autopw/gate";
import { writeReport } from "@autopw/reporting";
import { RunStorage, type ArtifactRef } from "@autopw/run-storage";
import type { RunSnapshot } from "@autopw/operation-registry";
import { discover } from "@autopw/discovery";
import { analyzeDiff, deriveCoverage, digest, type DerivationResult, type DiffResult, type Tier } from "@autopw/derivation";

export interface VerticalRun extends RunSnapshot { phase: string; }
export interface VerticalResult { gate: "incomplete" | "infra" | "fail" | "unstable" | "pass"; audit_status: "COMPLETE" | "INCOMPLETE"; results_ref: ArtifactRef; report_ref: ArtifactRef; gate_summary: Record<string, unknown>; cases: Record<string, unknown>[]; evidence_refs: ArtifactRef[]; }
export interface CoveragePreview { discovery: Record<string, unknown>; derivation: DerivationResult; diff: DiffResult; result_ref?: ArtifactRef; summary: Record<string, unknown>; }
type PhaseCallback = (phase: string, progress: number, nextAction: string) => void;

export class AuditVerticalSlice {
  readonly root: string;
  readonly storage: RunStorage;
  readonly runner = new PlaywrightFixtureRunner();
  readonly fixtureVariant?: FixtureVariant;
  readonly preflightCache = new Map<string, { expires_at: number; value: CoveragePreview }>();

  constructor({ root, dataRoot, fixtureVariant }: { root: string; dataRoot: string; fixtureVariant?: FixtureVariant }) {
    this.root = path.resolve(root);
    this.storage = new RunStorage(dataRoot);
    this.fixtureVariant = fixtureVariant;
  }

  async execute({ run, request, onPhase }: { run: VerticalRun; request: Record<string, unknown>; onPhase: PhaseCallback }): Promise<VerticalResult> {
    const variant = this.variant(this.fixtureVariant);
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
      const coverage = await this.deriveCoverage({ request, artifactId: run.run_id, targetUrl: target.baseUrl });
      this.storage.writeJson(run.run_id, "discovery.json", coverage.discovery);
      this.storage.writeJson(run.run_id, "derivation.json", coverage.derivation);
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
      const resultRef = this.storage.writeArtifact(run.run_id, "results.json", "results.json", "{}\n");
      const results = { schema_version: "2.1", run_id: run.run_id, gate: gate.gate, audit_status: audit.audit_status, exit_code: gate.exit_code, results_ref: resultRef, summary: audit.summary, issues: audit.issues };
      const persistedResultsRef = this.storage.writeArtifact(run.run_id, "results.json", "results.json", JSON.stringify(results, null, 2) + "\n");
      const report = writeReport({ storage: this.storage, runId: run.run_id, gate: gate.gate, auditStatus: audit.audit_status, summary: audit.summary, issues: audit.issues, resultsRef: persistedResultsRef });
      commitPhase("REPORTED", 96, "poll get_run_status");
      commitPhase("GATED", 100, "get_run_result");
      return { gate: gate.gate, audit_status: audit.audit_status, results_ref: persistedResultsRef, report_ref: report.reportRef, gate_summary: { ...audit.summary, reason: gate.reason, issues: audit.issues }, cases: execution.results.map((item) => ({ case_id: item.case_id, execution_id: item.execution_id, status: item.status, error: item.error, evidence_refs: item.evidence_refs })), evidence_refs: execution.results.flatMap((item) => item.evidence_refs) };
    } finally { await target.close(); }
  }

  async preview({ request, operationId }: { request: Record<string, unknown>; operationId: string }): Promise<CoveragePreview> {
    const target = await startDemoTarget(this.variant(this.fixtureVariant));
    try { return await this.deriveCoverage({ request, artifactId: operationId, targetUrl: target.baseUrl }); }
    finally { await target.close(); }
  }

  async preflight({ request }: { request: Record<string, unknown> }): Promise<CoveragePreview> {
    const key = stableJson(Object.fromEntries(Object.entries(request).filter(([name]) => name !== "client_request_id")));
    const cached = this.preflightCache.get(key);
    if (cached && cached.expires_at > Date.now()) return cached.value;
    const target = await startDemoTarget(this.variant(this.fixtureVariant));
    try {
      const value = await this.deriveCoverage({ request, targetUrl: target.baseUrl });
      this.preflightCache.set(key, { expires_at: Date.now() + 30_000, value });
      return value;
    }
    finally { await target.close(); }
  }

  private async deriveCoverage({ request, artifactId, targetUrl }: { request: Record<string, unknown>; artifactId?: string; targetUrl?: string }): Promise<CoveragePreview> {
    const preflightStarted = Date.now();
    const tier = String(request.tier || request.base_tier || "fast") as Tier;
    const discovery = await discover({
      root: this.root,
      project_subpath: String(request.project_subpath || "."),
      target_url: targetUrl,
      budget: { max_depth: 6, max_files: 500, timeout_ms: 3000, allowed_origins: targetUrl ? [new URL(targetUrl).origin] : [] }
    });
    const sourceMappings = discovery.observations.filter((observation) => observation.kind === "source" && typeof observation.path === "string" && Array.isArray(observation.features)).map((observation) => ({ file_glob: String(observation.path), features: (observation.features as unknown[]).filter((feature): feature is string => typeof feature === "string") }));
    const diff = analyzeDiff({ diffRef: typeof request.diff_ref === "string" ? request.diff_ref : undefined, root: this.root, mappings: sourceMappings });
    const matrixBudget = typeof request.matrix_budget === "object" && request.matrix_budget ? Number((request.matrix_budget as Record<string, unknown>).max_execution_instances || 0) : 0;
    const derivation = deriveCoverage({
      discovery, tier, diff,
      matrix: { profile_max_execution_instances: matrixBudget || undefined, host_max_execution_instances: Number(request.__host_max_execution_instances || 100) },
      input_versions: {
        workspace_digest: digest(this.root), profile_digest: digest(String(request.profile_path || "")),
        route_map_digest: digest("default-route-map"), diff_digest: digest(String(request.diff_ref || "NOOP")),
        auth_scope_id: String(request.auth_scope_id || "as_demo"), tier
      }
    });
    const summary: Record<string, unknown> = {
      skeleton_count: derivation.skeleton.length,
      planned_count: derivation.skeleton.filter((item) => item.status === "PLANNED").length,
      blocked_count: derivation.skeleton.filter((item) => item.status === "BLOCKED").length,
      projected_execution_instances: derivation.projection.projected_execution_instances,
      projection: derivation.projection.dimensions,
      narrowing_suggestions: derivation.projection.narrowing_suggestions,
      input_versions: derivation.input_versions,
      timings: { preflight_ms: Date.now() - preflightStarted, discovery_wall_ms: discovery.metrics.discovery_wall_ms, derivation_cpu_ms: derivation.metrics.derivation_cpu_ms, serialization_ms: 0 }
    };
    let result_ref: ArtifactRef | undefined;
    if (artifactId) {
      const serializationStarted = Date.now();
      const storageId = artifactId.startsWith("op_") ? "run_" + artifactId.slice(3) : artifactId;
      result_ref = this.storage.writeArtifact(storageId, "cdd.json", "cdd.json", JSON.stringify({ discovery, derivation, diff, summary }, null, 2) + "\n");
      (summary.timings as Record<string, unknown>).serialization_ms = Date.now() - serializationStarted;
    }
    return { discovery: discovery as unknown as Record<string, unknown>, derivation, diff, result_ref, summary };
  }

  private variant(value: FixtureVariant | undefined): FixtureVariant { return value === "fail" || value === "incomplete" ? value : "pass"; }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item)).join(",") + "}";
  return JSON.stringify(value);
}
