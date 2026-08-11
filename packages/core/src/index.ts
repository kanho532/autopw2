import path from "node:path";
import { auditExecution } from "@autopw/audit";
import { compileFixturePlan, compileTestPlan, suiteDigest } from "@autopw/compiler";
import { FIXTURE_PLAN, startDemoTarget, type FixtureVariant } from "@autopw/execution-fixture";
import { PlaywrightFixtureRunner, type ExecutionMatrix } from "@autopw/execution";
import { evaluateGate } from "@autopw/gate";
import { writeReport, type ReportCoverageRow } from "@autopw/reporting";
import { RunStorage, type ArtifactRef } from "@autopw/run-storage";
import type { RunSnapshot } from "@autopw/operation-registry";
import { discover } from "@autopw/discovery";
import { analyzeDiff, deriveCoverage, digest, reconcileRequirementCoverage, type DerivationResult, type DiffResult, type Tier, type TestRequirement } from "@autopw/derivation";
import { buildCandidateCatalog, buildRequirementPlannerInput, DeterministicFixturePlanner, LocalStructuredPlannerProvider, PlanTemplateCache, planExecutionInstances, plannerInputDigest, validatePlannerOutput, type CandidateCatalog, type PlannerInput, type PlannerOutput, type PlannerProviderOptions, type PlanTemplate } from "@autopw/planner";
import { redactSecrets } from "@autopw/security";
import { loadPlan, mergePlans, type PlanMergeMode, type TestPlan } from "@autopw/test-plan";

export interface VerticalRun extends RunSnapshot { phase: string; }
export interface VerticalResult { gate: "incomplete" | "infra" | "fail" | "unstable" | "pass"; audit_status: "COMPLETE" | "INCOMPLETE"; results_ref: ArtifactRef; report_ref: ArtifactRef; gate_summary: Record<string, unknown>; cases: Record<string, unknown>[]; evidence_refs: ArtifactRef[]; }
export interface CoveragePreview { discovery: Record<string, unknown>; derivation: DerivationResult; diff: DiffResult; result_ref?: ArtifactRef; summary: Record<string, unknown>; }
export type PlanEngineMode = "fixture" | "declarative";
export type DiscoveryEngineMode = "legacy" | "structured";
export interface EngineModes { plan_engine: PlanEngineMode; discovery_engine: DiscoveryEngineMode; }
/** M10 release default. The legacy pair remains an explicit compatibility mode for one release cycle. */
export const DEFAULT_ENGINE_MODES: Readonly<EngineModes> = Object.freeze({ plan_engine: "declarative", discovery_engine: "structured" });
export const LEGACY_ENGINE_MODES: Readonly<EngineModes> = Object.freeze({ plan_engine: "fixture", discovery_engine: "legacy" });

export interface TargetSession { mode: "managed" | "external"; baseUrl: string; close(): Promise<void>; }
export interface TargetProvider { open(): Promise<TargetSession>; }

export class ManagedFixtureTargetProvider implements TargetProvider {
  constructor(private readonly fixtureVariant: FixtureVariant = "pass") {}
  async open(): Promise<TargetSession> {
    const target = await startDemoTarget(this.fixtureVariant);
    return { mode: "managed", baseUrl: target.baseUrl, close: target.close };
  }
}

export class ExternalTargetProvider implements TargetProvider {
  readonly baseUrl: string;
  constructor(baseUrl: string) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw Object.assign(new Error("external target URL is invalid"), { code: "EXTERNAL_TARGET_URL_INVALID" });
    this.baseUrl = parsed.toString().replace(/\/$/, "");
  }
  async open(): Promise<TargetSession> { return { mode: "external", baseUrl: this.baseUrl, close: async () => undefined }; }
}

export function resolveEngineModes(input?: Partial<EngineModes>): EngineModes {
  const plan_engine = input?.plan_engine ?? DEFAULT_ENGINE_MODES.plan_engine;
  const discovery_engine = input?.discovery_engine ?? DEFAULT_ENGINE_MODES.discovery_engine;
  if (plan_engine !== "fixture" && plan_engine !== "declarative") throw Object.assign(new Error("invalid plan engine mode"), { code: "INVALID_PLAN_ENGINE_MODE" });
  if (discovery_engine !== "legacy" && discovery_engine !== "structured") throw Object.assign(new Error("invalid discovery engine mode"), { code: "INVALID_DISCOVERY_ENGINE_MODE" });
  return { plan_engine, discovery_engine };
}
interface PlannerArtifacts { input: PlannerInput; output: PlannerOutput; template: PlanTemplate; audit: Record<string, unknown>; requirements: TestRequirement[]; candidateCatalog?: CandidateCatalog; }
type PhaseCallback = (phase: string, progress: number, nextAction: string) => void;

export class AuditVerticalSlice {
  readonly root: string;
  readonly storage: RunStorage;
  readonly runner = new PlaywrightFixtureRunner();
  readonly fixtureVariant?: FixtureVariant;
  readonly plannerConfig: Partial<PlannerProviderOptions>;
  readonly production: boolean;
  readonly engineModes: EngineModes;
  readonly targetProvider: TargetProvider;
  readonly preflightCache = new Map<string, { expires_at: number; value: CoveragePreview }>();

  constructor({ root, dataRoot, fixtureVariant, plannerConfig, production, engineModes, targetProvider }: { root: string; dataRoot: string; fixtureVariant?: FixtureVariant; plannerConfig?: Partial<PlannerProviderOptions>; production?: boolean; engineModes?: Partial<EngineModes>; targetProvider?: TargetProvider }) {
    this.root = path.resolve(root);
    this.storage = new RunStorage(dataRoot);
    this.fixtureVariant = fixtureVariant;
    this.plannerConfig = plannerConfig || {};
    this.production = Boolean(production);
    this.engineModes = resolveEngineModes(engineModes);
    this.targetProvider = targetProvider || new ManagedFixtureTargetProvider(this.variant(fixtureVariant));
  }

  async execute({ run, request, onPhase }: { run: VerticalRun; request: Record<string, unknown>; onPhase: PhaseCallback }): Promise<VerticalResult> {
    const runStartedAt = Date.now();
    const releaseMetrics: Record<string, number> = {};
    const variant = this.variant(this.fixtureVariant);
    const startedAt = new Date().toISOString();
    const commitPhase = (phase: string, progress: number, nextAction: string): void => { this.storage.appendEvent(run.run_id, { kind: "PHASE_COMMITTED", phase, detail: { progress, next_action: nextAction } }); onPhase(phase, progress, nextAction); };
    this.storage.runDir(run.run_id);
    this.storage.writeJson(run.run_id, "request.json", redactSecrets(request));
    const requestedSnapshot = isRecord(request.__trust_snapshot) ? request.__trust_snapshot : {};
    this.storage.writeJson(run.run_id, "host-context.json", { ...(redactSecrets(requestedSnapshot) as Record<string, unknown>), workspace_id: run.workspace_id, workspace_root: "<authorized>", production: this.production });
    this.storage.appendEvent(run.run_id, { kind: "RUN_CREATED", phase: "CREATED", detail: { variant } });
    commitPhase("TARGET_READY", 8, "poll get_run_status");
    const target = await this.targetProvider.open();
    try {
      this.storage.writeJson(run.run_id, "target.json", { mode: target.mode, base_url: new URL(target.baseUrl).origin, health: "ready", started_at: startedAt });
      commitPhase("SEED_RESOLVED", 15, "poll get_run_status");
      this.storage.writeJson(run.run_id, "seed.json", { result: "SKIPPED", reset_capable: true, idempotent: true, at: new Date().toISOString() });
      commitPhase("DISCOVERED", 24, "poll get_run_status");
      const coverageStartedAt = Date.now();
      const coverage = await this.deriveCoverage({ request, artifactId: run.run_id, targetUrl: target.baseUrl });
      releaseMetrics.coverage_pipeline_ms = Date.now() - coverageStartedAt;
      const discoveryMetrics = isRecord((coverage.discovery as Record<string, unknown>).metrics) ? (coverage.discovery as Record<string, unknown>).metrics as Record<string, unknown> : {};
      releaseMetrics.static_discovery_wall_ms = Number(discoveryMetrics.static_discovery_wall_ms || 0);
      releaseMetrics.live_discovery_wall_ms = Number(discoveryMetrics.live_discovery_wall_ms || 0);
      releaseMetrics.correlation_cpu_ms = Number(discoveryMetrics.correlation_cpu_ms || 0);
      releaseMetrics.derivation_cpu_ms = coverage.derivation.metrics.derivation_cpu_ms;
      this.storage.writeJson(run.run_id, "discovery.json", coverage.discovery);
      this.storage.writeJson(run.run_id, "derivation.json", coverage.derivation);
      commitPhase("COVERAGE_DERIVED", 30, "poll get_run_status");
      const plannerStartedAt = Date.now();
      const planner = await this.fillPlanner({ request, coverage, targetUrl: target.baseUrl });
      releaseMetrics.planner_fill_ms = Date.now() - plannerStartedAt;
      this.storage.writeJson(run.run_id, "planner-input.json", planner.input);
      this.storage.writeJson(run.run_id, "planner-output.json", planner.output);
      this.storage.writeJson(run.run_id, "plan-template.json", { cache_key: planner.template.cache_key, selections_digest: planner.template.selections_digest, planner_provider_id: planner.template.planner_provider_id, model_id: planner.template.model_id });
      this.storage.writeJson(run.run_id, "planner-audit.json", planner.audit);
      commitPhase("PLAN_FILLED", 36, "poll get_run_status");
      const compilationStartedAt = Date.now();
      const compiled = this.engineModes.plan_engine === "declarative" ? compileTestPlan({ requirements: planner.requirements, candidateCatalog: planner.candidateCatalog || emptyCatalog(), plannerOutput: planner.output }) : compileFixturePlan(materializeFixturePlan(FIXTURE_PLAN, planner.output));
      releaseMetrics.compilation_ms = Date.now() - compilationStartedAt;
      const manualPlan = this.engineModes.plan_engine === "declarative" ? manualPlanFromRequest(request) : undefined;
      const planMode = resolvePlanMode(request.plan_mode);
      const effectivePlan = manualPlan ? mergePlans(compiled.plan as TestPlan, manualPlan, planMode, { manualAuthority: { authority: "trusted_manual" } }) : compiled.plan;
      const effectiveCaseMap = this.engineModes.plan_engine === "declarative" ? requirementCaseMapFor(planner.requirements, effectivePlan as TestPlan) : {};
      const effectiveOracleMap = this.engineModes.plan_engine === "declarative" ? requirementOracleMapFor(planner.requirements, effectivePlan as TestPlan) : {};
      const requiredRequirements = planner.requirements.filter((item) => !["TIER_SKIPPED", "NOT_APPLICABLE"].includes(item.status));
      const mappingComplete = requiredRequirements.every((item) => effectiveCaseMap[item.requirement_id]?.length && effectiveOracleMap[item.requirement_id]?.length);
      const mappingAudit = this.engineModes.plan_engine === "declarative" ? { ...compiled.mappingAudit, generated_case_ids: (effectivePlan as TestPlan).cases.map((item) => item.case_id).sort(), planned_requirement_ids: Object.keys(effectiveCaseMap).sort(), requirement_case_map: effectiveCaseMap, requirement_oracle_map: effectiveOracleMap, match: mappingComplete ? "COMPLETE" as const : "PARTIAL" as const } : compiled.mappingAudit;
      const planSource = manualPlan ? planMode === "overlay" ? "manual overlay" : "manual" : "generated";
      this.storage.writeJson(run.run_id, "plan.json", effectivePlan);
      this.storage.writeJson(run.run_id, "mapping-audit.json", mappingAudit);
      this.storage.writeJson(run.run_id, "plan-source.json", { mode: planSource, origin: (effectivePlan as TestPlan).origin || { type: "migrated" }, manual_plan: Boolean(manualPlan) });
      commitPhase("PLAN_FROZEN", 42, "poll get_run_status");
      commitPhase("SUITE_GENERATED", 48, "poll get_run_status");
      this.storage.writeArtifact(run.run_id, "suite.ts", "suite.ts", compiled.source);
      this.storage.writeJson(run.run_id, "suite-manifest.json", { digest: suiteDigest(compiled.source), forbidden_imports: false });
      commitPhase("SUITE_FROZEN", 54, "poll get_run_status");
      commitPhase("RUNNING", 60, "poll get_run_status");
      const executionStartedAt = Date.now();
      const execution = this.engineModes.plan_engine === "declarative"
        ? await this.runner.run({ runId: run.run_id, baseUrl: target.baseUrl, allowedOrigins: this.resolvedAllowedOrigins(request), plan: effectivePlan as TestPlan, matrix: matrixFromRequest(request), tier: String(request.tier || request.base_tier || "fast") as "smoke" | "fast" | "full", storage: this.storage, planAuthority: manualPlan ? "trusted_manual" : "generated" })
        : await this.runner.run({ runId: run.run_id, baseUrl: target.baseUrl, allowedOrigins: this.resolvedAllowedOrigins(request), plan: effectivePlan as import("@autopw/execution-fixture").FixturePlan, variant, matrix: matrixFromRequest(request), tier: String(request.tier || request.base_tier || "fast") as "smoke" | "fast" | "full", storage: this.storage });
      releaseMetrics.execution_ms = Date.now() - executionStartedAt;
      const reconciledCoverage = this.engineModes.plan_engine === "declarative" ? reconcileRequirementCoverage(planner.requirements, effectiveCaseMap, execution.results) : undefined;
      if (reconciledCoverage) this.storage.writeJson(run.run_id, "requirement-coverage.json", reconciledCoverage);
      commitPhase("EXECUTION_FINISHED", 78, "poll get_run_status");
      const audit = auditExecution(effectivePlan.cases.map((item) => item.case_id), execution.results, execution.manifest, this.engineModes.plan_engine === "declarative" ? { requirements: planner.requirements, requirementCaseMap: effectiveCaseMap, requirementOracleMap: effectiveOracleMap, coverage: reconciledCoverage, cases: effectivePlan.cases } : {});
      this.storage.writeJson(run.run_id, "completion-audit.json", audit);
      this.storage.writeJson(run.run_id, "issues.json", { schema_version: "2.1", issues: audit.issues });
      commitPhase("RUNTIME_FINALIZED", 84, "poll get_run_status");
      commitPhase("AUDITED", 89, "poll get_run_status");
      const gate = evaluateGate({ audit, coverage: reconciledCoverage, gatePolicy: gatePolicyFromRequest(request), issues: audit.issues, executionResults: execution.results });
      const resultRef = this.storage.writeArtifact(run.run_id, "results.json", "results.json", "{}\n");
      const results = { schema_version: "2.1", run_id: run.run_id, gate: gate.gate, audit_status: audit.audit_status, exit_code: gate.exit_code, results_ref: resultRef, summary: { ...audit.summary, coverage: reconciledCoverage }, issues: audit.issues };
      const persistedResultsRef = this.storage.writeArtifact(run.run_id, "results.json", "results.json", JSON.stringify(results, null, 2) + "\n");
      const reportStartedAt = Date.now();
      const report = writeReport({ storage: this.storage, runId: run.run_id, gate: gate.gate, auditStatus: audit.audit_status, summary: { ...audit.summary, coverage: reconciledCoverage }, issues: audit.issues, resultsRef: persistedResultsRef, planSource, target: target.mode, coverage: coverageRows(planner.requirements, effectiveCaseMap, execution.results), cases: effectivePlan.cases });
      releaseMetrics.report_ms = Date.now() - reportStartedAt;
      releaseMetrics.total_run_ms = Date.now() - runStartedAt;
      this.storage.writeJson(run.run_id, "release-metrics.json", { schema_version: "2.2", engine_modes: this.engineModes, plan_cache_hit: Boolean((planner.audit as Record<string, unknown>).cache_hit), ...releaseMetrics });
      this.storage.writeJson(run.run_id, "latest.json", { run_id: run.run_id, gate: gate.gate, audit_status: audit.audit_status, plan_source: planSource, report: { markdown: "artifacts/report.md", html: "artifacts/report.html", results: "artifacts/results.json" } });
      commitPhase("REPORTED", 96, "poll get_run_status");
      commitPhase("GATED", 100, "get_run_result");
      const batchByExecution = new Map(execution.manifest.instances.map((instance) => [String(instance.execution_id), String(instance.batch_id)]));
      const tierByCase = new Map(effectivePlan.cases.map((item) => [item.case_id, item.effective_tier]));
      return { gate: gate.gate, audit_status: audit.audit_status, results_ref: persistedResultsRef, report_ref: report.reportRef, gate_summary: { ...audit.summary, coverage: reconciledCoverage, reason: gate.reason, issues: audit.issues }, cases: execution.results.map((item) => ({ case_id: item.case_id, execution_id: item.execution_id, status: item.status, tier: tierByCase.get(item.case_id) || String(request.tier || request.base_tier || "fast"), batch_id: batchByExecution.get(item.execution_id), error: item.error, evidence_refs: item.evidence_refs })), evidence_refs: execution.results.flatMap((item) => item.evidence_refs) };
    } finally { await target.close(); }
  }

  async preview({ request, operationId }: { request: Record<string, unknown>; operationId: string }): Promise<CoveragePreview> {
    const target = await this.targetProvider.open();
    try { return await this.deriveCoverage({ request, artifactId: operationId, targetUrl: target.baseUrl }); }
    finally { await target.close(); }
  }

  async preflight({ request }: { request: Record<string, unknown> }): Promise<CoveragePreview> {
    const key = stableJson(Object.fromEntries(Object.entries(request).filter(([name]) => name !== "client_request_id")));
    const cached = this.preflightCache.get(key);
    if (cached && cached.expires_at > Date.now()) return cached.value;
    const target = await this.targetProvider.open();
    try {
      const value = await this.deriveCoverage({ request, targetUrl: target.baseUrl });
      const tier = String(request.tier || request.base_tier || "fast") as Tier;
      const matrixBudget = isRecord(request.matrix_budget) ? Number(request.matrix_budget.max_execution_instances || 0) : 0;
      // M9.0 freezes the Fixture compatibility path. Discovery may expose
      // additional facts, but the preflight budget must describe the plan
      // that the current Fixture runner will actually execute.
      if (this.engineModes.plan_engine === "fixture") {
        value.derivation.projection = planExecutionInstances(
          FIXTURE_PLAN.cases.map((item) => ({ case_id: item.case_id })),
          tier,
          { ...matrixFromRequest(request), profile_max_execution_instances: matrixBudget || undefined, host_max_execution_instances: Number(request.__host_max_execution_instances || 100) }
        );
        value.summary.projected_execution_instances = value.derivation.projection.projected_execution_instances;
        value.summary.projection = value.derivation.projection.dimensions;
        value.summary.narrowing_suggestions = value.derivation.projection.narrowing_suggestions;
      } else {
        const requirements = requirementsFromCoverage(value);
        value.derivation.projection = planExecutionInstances(requirements.filter((item) => item.status !== "BLOCKED" && item.status !== "TIER_SKIPPED" && item.status !== "NOT_APPLICABLE").map((item) => ({ case_id: "case_" + item.requirement_id })), tier, { ...matrixFromRequest(request), profile_max_execution_instances: matrixBudget || undefined, host_max_execution_instances: Number(request.__host_max_execution_instances || 100) });
        value.summary.projected_execution_instances = value.derivation.projection.projected_execution_instances;
        value.summary.projection = value.derivation.projection.dimensions;
        value.summary.narrowing_suggestions = value.derivation.projection.narrowing_suggestions;
      }
      this.preflightCache.set(key, { expires_at: Date.now() + 30_000, value });
      return value;
    }
    finally { await target.close(); }
  }

  private async deriveCoverage({ request, artifactId, targetUrl }: { request: Record<string, unknown>; artifactId?: string; targetUrl?: string }): Promise<CoveragePreview> {
    const preflightStarted = Date.now();
    const tier = String(request.tier || request.base_tier || "fast") as Tier;
    const allowedOrigins = this.resolvedAllowedOrigins(request);
    const discovery = await discover({
      root: this.root,
      project_subpath: String(request.project_subpath || "."),
      target_url: targetUrl,
      budget: { max_depth: 6, max_files: 500, timeout_ms: 3000, allowed_origins: allowedOrigins }
    });
    const sourceMappings = discovery.observations.filter((observation) => observation.kind === "source" && typeof observation.path === "string" && Array.isArray(observation.features)).map((observation) => ({ file_glob: String(observation.path), features: (observation.features as unknown[]).filter((feature): feature is string => typeof feature === "string") }));
    const diff = analyzeDiff({ diffRef: typeof request.diff_ref === "string" ? request.diff_ref : undefined, root: this.root, mappings: sourceMappings });
    const matrixBudget = typeof request.matrix_budget === "object" && request.matrix_budget ? Number((request.matrix_budget as Record<string, unknown>).max_execution_instances || 0) : 0;
    const derivation = deriveCoverage({
      discovery, tier, diff,
      matrix: { ...matrixFromRequest(request), profile_max_execution_instances: matrixBudget || undefined, host_max_execution_instances: Number(request.__host_max_execution_instances || 100) },
      destructive_allowed: request.allow_destructive !== false,
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

  private async fillPlanner({ request, coverage, targetUrl }: { request: Record<string, unknown>; coverage: CoveragePreview; targetUrl: string }): Promise<PlannerArtifacts> {
    const requirements = requirementsFromCoverage(coverage);
    const candidates = this.engineModes.plan_engine === "declarative" ? buildCandidateCatalog({ discovery: coverage.discovery as unknown as { observations: Array<Record<string, unknown>> }, requirements, manualOverlay: { allowed_origin: new URL(targetUrl).origin } }) : fixtureCandidates(targetUrl);
    const skeletons = this.engineModes.plan_engine === "declarative" ? buildRequirementPlannerInput(requirements, candidates) : FIXTURE_PLAN.cases.map((item) => ({
      case_id: item.case_id, feature_id: item.feature_id, scenario: item.scenario, route_id: "route_" + item.case_id,
      action_ids: Object.values(candidates.actions).filter((candidate) => candidate.case_id === item.case_id).map((candidate) => candidate.id),
      expectation_ids: Object.values(candidates.expectations).filter((candidate) => candidate.case_id === item.case_id).map((candidate) => candidate.id),
      status: coverage.derivation.skeleton.find((candidate) => candidate.case_id === item.case_id)?.status || "PLANNED"
    }));
    const input: PlannerInput = {
      schemaVersion: "2.1", skeletons, candidates, contractRefs: [{ contractId: this.engineModes.plan_engine === "declarative" ? "test-requirement-plan" : "fixture-plan", version: "2.1", ref: this.engineModes.plan_engine === "declarative" ? "requirement://derived" : "fixture://plan" }],
      // Discovery metrics are run-local timing data. They must not contribute to the
      // reusable plan template digest, otherwise identical target facts never hit cache.
      untrustedObservations: Object.entries(coverage.discovery).filter(([kind]) => kind !== "metrics").slice(0, 24).map(([kind, value], index) => ({ observationId: "obs_" + index, untrusted: true as const, kind, value: JSON.stringify(redactSecrets(value)).slice(0, 400) }))
    };
    const options: PlannerProviderOptions = { provider_id: "local-structured", provider_version: "1", model_id: "local-deterministic", timeout_ms: 2000, token_budget: 2048, temperature: 0, max_attempts: 2, ...this.plannerConfig };
    const cache = new PlanTemplateCache(path.join(this.storage.dataRoot, "plan-cache"));
    const key = cache.key({ normalized_profile_digest: digest(String(request.profile_path || "default")), coverage_policy_digest: digest(JSON.stringify(request.coverage_policy || {})), scenario_contract_digest: digest("fixture-scenarios-v2"), route_map_digest: digest("fixture-route-map"), discovery_digest: plannerInputDigest(input), engine_version: "2.1", schema_version: "2.1", planner_provider_id: options.provider_id, planner_provider_version: options.provider_version, model_id: options.model_id, base_tier: String(request.tier || request.base_tier || "fast"), sorted_scope: skeletons.map((item) => item.case_id).sort(), locale: String(request.locale || "en-US"), auth_scope_id: String(request.auth_scope_id || "as_demo"), run_id: request.run_id, seed: request.seed });
    const cached = cache.get(key);
    let output: PlannerOutput;
    let attempts = 0;
    if (cached) { output = cached.selections; attempts = 0; }
    else {
      const provider = options.provider_id === "fixture-deterministic" ? new DeterministicFixturePlanner() : new LocalStructuredPlannerProvider();
      let lastError: unknown;
      for (let attempt = 1; attempt <= (options.max_attempts || 2); attempt += 1) {
        attempts = attempt;
        try { output = await withTimeout(provider.fill(input, options), options.timeout_ms); const valid = validatePlannerOutput(input, output, { allowedOrigin: new URL(targetUrl).origin, production: this.production }); if (!valid.ok) throw plannerError("PLAN_VALIDATION_FAILED: " + valid.errors.join("; ")); break; }
        catch (error) { lastError = error; if (attempt === (options.max_attempts || 2)) throw plannerError(lastError instanceof Error ? lastError.message : String(lastError)); }
      }
      output = output!;
      cache.put(key, output, options);
    }
    const validation = validatePlannerOutput(input, output, { allowedOrigin: new URL(targetUrl).origin, production: this.production });
    if (!validation.ok) throw plannerError("PLAN_VALIDATION_FAILED: " + validation.errors.join("; "));
    const template = cache.get(key) || cache.put(key, output, options);
    return { input, output, template, requirements, candidateCatalog: this.engineModes.plan_engine === "declarative" ? candidates : undefined, audit: { schema_version: "2.1", provider_id: options.provider_id, provider_version: options.provider_version, model_id: options.model_id, temperature: 0, timeout_ms: options.timeout_ms, token_budget: options.token_budget, attempts, cache_hit: Boolean(cached), output_digest: template.selections_digest } };
  }

  private variant(value: FixtureVariant | undefined): FixtureVariant { return value === "fail" || value === "incomplete" ? value : "pass"; }

  private resolvedAllowedOrigins(request: Record<string, unknown>): string[] {
    const snapshot = isRecord(request.__trust_snapshot) ? request.__trust_snapshot : undefined;
    const origins = snapshot && Array.isArray(snapshot.allowed_origins) ? snapshot.allowed_origins.filter((origin): origin is string => typeof origin === "string") : [];
    if (origins.length === 0 && typeof request.__target_url === "string") origins.push(new URL(request.__target_url).origin);
    if (origins.length === 0 && Array.isArray(request.__allowed_origins)) origins.push(...request.__allowed_origins.filter((origin): origin is string => typeof origin === "string"));
    if (origins.length === 0) throw Object.assign(new Error("NETWORK_POLICY_EMPTY"), { code: "NETWORK_POLICY_EMPTY" });
    return origins;
  }
}

function plannerError(message: string): Error & { code: string } { return Object.assign(new Error(message), { code: "PLAN_DEFECT" }); }
function requirementsFromCoverage(coverage: CoveragePreview): TestRequirement[] { const requirements = coverage.derivation.cdd.requirements; return Array.isArray(requirements) ? requirements as TestRequirement[] : []; }
function manualPlanFromRequest(request: Record<string, unknown>): TestPlan | undefined { return request.__manual_plan ? loadPlan(request.__manual_plan as TestPlan, { authority: "trusted_manual" }) : undefined; }
function resolvePlanMode(value: unknown): PlanMergeMode { const mode = value === undefined ? "auto" : String(value); if (!["auto", "overlay", "replace"].includes(mode)) throw Object.assign(new Error("invalid plan mode"), { code: "INVALID_PLAN_MODE" }); return mode as PlanMergeMode; }
function requirementCaseMapFor(requirements: TestRequirement[], plan: TestPlan): Record<string, string[]> {
  const ids = new Set(requirements.map((item) => item.requirement_id));
  const map: Record<string, string[]> = {};
  for (const item of plan.cases) for (const requirementId of item.requirement_refs) if (ids.has(requirementId)) (map[requirementId] ||= []).push(item.case_id);
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, [...new Set(value)].sort()]));
}
function requirementOracleMapFor(requirements: TestRequirement[], plan: TestPlan): Record<string, string[]> {
  const ids = new Set(requirements.map((item) => item.requirement_id));
  const map: Record<string, string[]> = {};
  for (const item of plan.cases) {
    for (const binding of item.oracle_bindings || []) {
      if (!ids.has(binding.requirement_id)) continue;
      for (const stepRef of binding.step_refs) (map[binding.requirement_id] ||= []).push(`${item.case_id}:${stepRef}`);
    }
  }
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, [...new Set(value)].sort()]));
}
function gatePolicyFromRequest(request: Record<string, unknown>): { strategy?: "product" | "strict"; min_p0_coverage_pct?: number; max_flaky_cases?: number } {
  const value = isRecord(request.__gate_policy) ? request.__gate_policy : {};
  return { strategy: value.strategy === "strict" ? "strict" : "product", min_p0_coverage_pct: Number(value.min_p0_coverage_pct ?? request.min_p0_coverage_pct ?? 100), max_flaky_cases: Number(value.max_flaky_cases ?? request.max_flaky_cases ?? 0) };
}
function coverageRows(requirements: TestRequirement[], map: Record<string, string[]>, results: Array<{ case_id: string; status: string; evidence_refs?: unknown[] }>): ReportCoverageRow[] {
  const resultByCase = new Map(results.map((item) => [item.case_id, item]));
  return requirements.map((item) => {
    const caseIds = map[item.requirement_id] || [];
    const matched = caseIds.map((caseId) => resultByCase.get(caseId)).filter((value): value is { case_id: string; status: string; evidence_refs?: unknown[] } => Boolean(value));
    return { requirement_id: item.requirement_id, priority: item.priority, intent: item.intent, source: item.source_refs, plan_status: caseIds.length ? "PLANNED" : item.status, execution_status: matched.length ? matched.map((value) => value.status).join(",") : "NOT_EXECUTED", evidence: matched.length && matched.every((value) => (value.evidence_refs || []).length > 0) ? "COMPLETE" : "MISSING", reason: item.reason || "" };
  });
}
function emptyCatalog(): CandidateCatalog { return { routes: {}, actions: {}, locators: {}, inputs: {}, expectations: {}, endpoints: {} }; }
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(plannerError("PLANNER_TIMEOUT")), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
function fixtureCandidates(origin: string): CandidateCatalog {
  const routes: CandidateCatalog["routes"] = {}; const actions: CandidateCatalog["actions"] = {}; const locators: CandidateCatalog["locators"] = {}; const inputs: CandidateCatalog["inputs"] = {}; const expectations: CandidateCatalog["expectations"] = {}; const endpoints: CandidateCatalog["endpoints"] = {};
  for (const item of FIXTURE_PLAN.cases) {
    const routeId = "route_" + item.case_id; routes[routeId] = { id: routeId, kind: "route", case_id: item.case_id, scenario: item.scenario, origin, source: "fixture" };
    item.steps.forEach((step, index) => {
      const actionId = "act_" + item.case_id + "_" + index; const selector = "selector" in step ? step.selector : undefined;
      const locatorId = selector ? "loc_" + item.case_id + "_" + index : undefined; const inputId = step.action === "fill" ? "input_" + item.case_id + "_" + index : undefined;
      actions[actionId] = { id: actionId, kind: "action", case_id: item.case_id, scenario: item.scenario, route_id: routeId, locator_id: locatorId, input_id: inputId, action: step.action, source: "fixture" };
      if (locatorId) locators[locatorId] = { id: locatorId, kind: "locator", case_id: item.case_id, scenario: item.scenario, route_id: routeId, source: "fixture" };
      if (inputId) inputs[inputId] = { id: inputId, kind: "input", case_id: item.case_id, scenario: item.scenario, route_id: routeId, source: "fixture" };
    });
    const expectationId = "exp_" + item.case_id; expectations[expectationId] = { id: expectationId, kind: "expectation", case_id: item.case_id, scenario: item.scenario, route_id: routeId, origin, strength: "strong", source: "fixture" };
  }
  return { routes, actions, locators, inputs, expectations, endpoints };
}

function materializeFixturePlan(basePlan: typeof FIXTURE_PLAN, output: PlannerOutput): typeof FIXTURE_PLAN {
  const selections = new Map(output.caseSelections.map((selection) => [selection.caseId, selection]));
  return { ...basePlan, cases: basePlan.cases.filter((item) => selections.has(item.case_id)).map((item) => {
    const selection = selections.get(item.case_id);
    const selectedIndexes = new Set((selection?.actionSelections || []).map((action) => Number(action.actionTemplateId.match(/_(\d+)$/)?.[1])).filter((index) => Number.isInteger(index)));
    return { ...item, steps: item.steps.filter((_step, index) => selectedIndexes.has(index)) };
  }) };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item)).join(",") + "}";
  return JSON.stringify(value);
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function matrixFromRequest(request: Record<string, unknown>): ExecutionMatrix | undefined {
  const value = isRecord(request.matrix) ? request.matrix : undefined;
  const tier = String(request.tier || request.base_tier || "fast");
  if (!value && tier !== "full") return undefined;
  const matrix = value || { browsers: ["chromium", "firefox", "webkit"], viewports: [{ width: 1280, height: 720 }, { width: 1440, height: 900 }], locales: ["en-US"], auth_scope_ids: ["as_demo"] };
  return {
    browsers: Array.isArray(matrix.browsers) ? matrix.browsers as ExecutionMatrix["browsers"] : undefined,
    viewports: Array.isArray(matrix.viewports) ? matrix.viewports as ExecutionMatrix["viewports"] : undefined,
    locales: Array.isArray(matrix.locales) ? matrix.locales.filter((item): item is string => typeof item === "string") : undefined,
    auth_scope_ids: Array.isArray(matrix.auth_scope_ids) ? matrix.auth_scope_ids.filter((item): item is string => typeof item === "string") : undefined
  };
}
