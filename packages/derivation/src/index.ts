import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { DiscoveryResult } from "@autopw/discovery";
import { planExecutionInstances, type MatrixProfile, type ExecutionProjection } from "@autopw/planner";

export type Tier = "smoke" | "fast" | "full";
export type CoverageStatus = "PLANNED" | "BLOCKED" | "NOT_APPLICABLE" | "TIER_SKIPPED";
export type RequirementIntent = "route_loads" | "create_succeeds" | "required_field_rejected" | "boundary_rejected" | "not_found_semantics" | "route_detail" | "completed_state" | "delete_removes_entity" | "enum_validation" | "update_persists" | "search_filters_results" | "summary_is_consistent" | "count_consistent" | "cors_allows_operation";
export type RequirementStatus = "REQUIRED" | "PLANNED" | "BLOCKED" | "NOT_APPLICABLE" | "TIER_SKIPPED";
export interface RequirementPrecondition { kind: string; refs: string[]; details?: Record<string, unknown>; }
export interface RequirementOracle { kind: string; assertion: string; details?: Record<string, unknown>; }
export interface TestRequirement { requirement_id: string; feature_id: string; intent: RequirementIntent; scenario: string; priority: "P0" | "P1" | "P2"; source_refs: string[]; preconditions: RequirementPrecondition[]; oracle: RequirementOracle | null; risk: "read_only" | "mutating" | "destructive"; confidence: number; status: RequirementStatus; reason?: string; }
export interface RequirementCoverage { required: number; planned: number; executable: number; executed: number; passed: number; evidence_complete: number; p0_required: number; p0_planned: number; p0_executable: number; p0_executed: number; p0_passed: number; }
export interface RequirementExecutionLike { case_id: string; status: string; evidence_refs?: unknown[]; }
export interface DiffResult { status: "NOOP" | "CHANGED"; changed_files: { status: string; path: string; feature_ids: string[]; new_feature: boolean }[]; affected_features: string[]; new_features: string[]; }
export interface DerivationInput { discovery: DiscoveryResult; tier: Tier; diff?: DiffResult; matrix?: MatrixProfile; mandatory_capabilities?: { id: string; priority: "P0" | "P1" | "P2"; feature_ids: string[]; on_missing: "incomplete" | "warn" }[]; input_versions?: Record<string, string>; destructive_allowed?: boolean; allow_destructive?: boolean; }
export interface Skeleton { case_id: string; feature_id: string; scenario: string; priority: "P0" | "P1" | "P2"; effective_tier: Tier; status: CoverageStatus; matrix_cell: string; blocked: boolean; reason?: string; }
export interface DerivationResult { schema_version: "2.1"; skeleton: Skeleton[]; matrix: Record<string, unknown>[]; p0_required_total: number; p0_coverage_pct: number | null; input_versions: Record<string, string>; metrics: { derivation_cpu_ms: number }; projection: ExecutionProjection; cdd: Record<string, unknown>; }

const ALLOWED_SCENARIOS: Record<Tier, Set<string>> = {
  smoke: new Set(["normal", "required_field"]),
  fast: new Set(["normal", "required_field", "invalid_input", "empty_state"]),
  full: new Set(["normal", "required_field", "invalid_input", "empty_state", "boundary", "service_error", "network_failure", "not_found", "persistence", "cors"])
};
const ALLOWED_PRIORITIES: Record<Tier, Set<string>> = { smoke: new Set(["P0"]), fast: new Set(["P0", "P1"]), full: new Set(["P0", "P1", "P2"]) };

export function deriveCoverage(input: DerivationInput): DerivationResult {
  const started = performance.now();
  const diff = input.diff || { status: "NOOP", changed_files: [], affected_features: [], new_features: [] };
  const mandatory = input.mandatory_capabilities || [];
  const observed = input.discovery.scenario_observations;
  const diffProvided = diff.status === "CHANGED";
  const mandatoryFeatures = new Set(mandatory.flatMap((capability) => capability.feature_ids));
  const skeleton: Skeleton[] = observed.map((observation) => {
    const affected = diff.affected_features.includes(observation.feature_id);
    const isNew = diff.new_features.includes(observation.feature_id);
    const effective_tier: Tier = input.tier === "full" ? "full" : input.tier === "smoke" ? "smoke" : affected && !isNew ? "smoke" : "fast";
    const mandatoryCapability = mandatory.find((capability) => capability.feature_ids.includes(observation.feature_id));
    const priority = observation.priority;
    const inScope = !diffProvided || affected || isNew || mandatoryFeatures.has(observation.feature_id);
    const blocked = !observation.observed || (observation.blocker && !observation.observed) || (mandatoryCapability?.on_missing === "incomplete" && !observation.observed);
    let status: CoverageStatus = blocked ? "BLOCKED" : observation.observed ? "PLANNED" : "NOT_APPLICABLE";
    let reason = blocked ? observation.reason || "OBJECTIVE_BLOCKER" : undefined;
    if (!inScope) { status = "TIER_SKIPPED"; reason = "TIER_SKIPPED_SCOPE"; }
    else if (!ALLOWED_PRIORITIES[effective_tier].has(priority)) { status = "TIER_SKIPPED"; reason = "TIER_SKIPPED_PRIORITY"; }
    else if (!ALLOWED_SCENARIOS[effective_tier].has(observation.scenario)) { status = "TIER_SKIPPED"; reason = "TIER_SKIPPED_SCENARIO"; }
    return { case_id: caseId(observation.feature_id, observation.scenario), feature_id: observation.feature_id, scenario: observation.scenario, priority, effective_tier, status, matrix_cell: observation.feature_id + ":" + effective_tier, blocked: status === "BLOCKED", ...(reason ? { reason } : {}) };
  });
  for (const capability of mandatory) {
    for (const feature_id of capability.feature_ids) {
      if (observed.some((item) => item.feature_id === feature_id)) continue;
      skeleton.push({ case_id: caseId(feature_id, "mandatory_capability"), feature_id, scenario: "normal", priority: capability.priority, effective_tier: input.tier, status: capability.on_missing === "incomplete" ? "BLOCKED" : "PLANNED", matrix_cell: feature_id + ":" + input.tier, blocked: capability.on_missing === "incomplete", ...(capability.on_missing === "incomplete" ? { reason: "MANDATORY_CAPABILITY_NOT_OBSERVED" } : {}) });
    }
  }
  skeleton.sort((a, b) => a.case_id.localeCompare(b.case_id));
  const projection = planExecutionInstances(skeleton.filter((item) => item.status === "PLANNED"), input.tier, input.matrix);
  const requirements = deriveRequirements({ discovery: input.discovery, tier: input.tier, diff, destructive_allowed: input.destructive_allowed ?? input.allow_destructive ?? true });
  const p0 = skeleton.filter((item) => item.priority === "P0" && item.status !== "TIER_SKIPPED" && item.status !== "NOT_APPLICABLE");
  const coveredP0 = p0.filter((item) => item.status === "PLANNED" && !item.blocked).length;
  const p0_coverage_pct = p0.length === 0 ? null : Math.round((coveredP0 / p0.length) * 10000) / 100;
  const input_versions = { engine_version: "2.1.0-m9.6", schema_version_bundle: "2.1", ...(input.input_versions || {}) };
  const metrics = { derivation_cpu_ms: Math.max(0, Math.round(performance.now() - started)) };
  const requirementCoverage = summarizeRequirementCoverage(requirements);
  const requirementCaseLinks = Object.fromEntries(requirements.map((requirement) => [requirement.requirement_id, [requirementCaseId(requirement.requirement_id)]]));
  return { schema_version: "2.1", skeleton, matrix: projection.batches as unknown as Record<string, unknown>[], p0_required_total: p0.length, p0_coverage_pct, input_versions, metrics, projection, cdd: { title: "Coverage Development Description", scope: skeleton.map((item) => ({ case_id: item.case_id, feature_id: item.feature_id, scenario: item.scenario, effective_tier: item.effective_tier, status: item.status, reason: item.reason })), requirements, requirement_case_links: requirementCaseLinks, coverage: requirementCoverage, p0_blocked: p0.some((item) => item.blocked), blockers: skeleton.filter((item) => item.blocked).map((item) => ({ case_id: item.case_id, reason: item.reason })), candidates: input.discovery.candidates.map((candidate) => ({ id: candidate.id, kind: candidate.kind, feature_id: candidate.feature_id })) } };
}

export function deriveRequirements({ discovery, tier, diff = { status: "NOOP", changed_files: [], affected_features: [], new_features: [] }, destructive_allowed = true }: { discovery: DiscoveryResult; tier: Tier; diff?: DiffResult; destructive_allowed?: boolean }): TestRequirement[] {
  const facts = discovery.observations.filter((item) => item.kind === "fact" && item.untrusted === true) as Array<Record<string, unknown>>;
  const endpoints = facts.filter((fact) => fact.fact_type === "endpoint");
  const validations = facts.filter((fact) => fact.fact_type === "validation");
  const controls = facts.filter((fact) => fact.fact_type === "control");
  const sourceText = discovery.observations.filter((item) => item.kind === "source").map((item) => String(item.value || "")).join("\n");
  const requirements: TestRequirement[] = [];
  const add = (requirement: Omit<TestRequirement, "status" | "reason">): void => {
    if (requirements.some((item) => item.requirement_id === requirement.requirement_id)) return;
    let status: RequirementStatus = "REQUIRED";
    let reason: string | undefined;
    if (requirement.oracle === null) { status = "BLOCKED"; reason = "MISSING_ORACLE"; }
    else if (requirement.risk === "destructive" && !destructive_allowed) { status = "BLOCKED"; reason = "DESTRUCTIVE_NOT_ALLOWED"; }
    const affected = diff.status === "NOOP" || diff.affected_features.includes(requirement.feature_id) || diff.new_features.includes(requirement.feature_id);
    if (!affected && diff.status === "CHANGED") { status = "TIER_SKIPPED"; reason = "TIER_SKIPPED_SCOPE"; }
    if (!ALLOWED_PRIORITIES[tier].has(requirement.priority)) { status = "TIER_SKIPPED"; reason = "TIER_SKIPPED_PRIORITY"; }
    if (!ALLOWED_SCENARIOS[tier].has(requirement.scenario)) { status = "TIER_SKIPPED"; reason = "TIER_SKIPPED_SCENARIO"; }
    requirements.push({ ...requirement, status, ...(reason ? { reason } : {}) });
  };
  const endpoint = (predicate: (fact: Record<string, unknown>) => boolean): Record<string, unknown> | undefined => endpoints.find(predicate);
  const refs = (...items: Array<Record<string, unknown> | undefined>): string[] => items.flatMap((item) => item && typeof item.fact_id === "string" ? [item.fact_id] : []);
  const feature = (item?: Record<string, unknown>): string => String(item?.feature_id || facts.find((fact) => typeof fact.feature_id === "string")?.feature_id || "project_root");
  const entity = (item?: Record<string, unknown>): string => { const pathValue = String(item?.path_template || "/resource").replace(/\?.*$/, "").replace(/\/:[^/]+$/, ""); const name = pathValue.split("/").filter(Boolean).pop() || "resource"; return name.endsWith("s") ? name.slice(0, -1) : name; };
  const getDetail = endpoint((fact) => fact.method === "GET" && String(fact.path_template).includes(":id"));
  const create = endpoint((fact) => fact.method === "POST" && !String(fact.path_template).includes(":id"));
  const patch = endpoint((fact) => fact.method === "PATCH" && String(fact.path_template).includes(":id"));
  const remove = endpoint((fact) => fact.method === "DELETE" && String(fact.path_template).includes(":id"));
  const summary = endpoint((fact) => fact.operation === "summary");
  const count = endpoint((fact) => fact.operation === "count");
  const search = endpoint((fact) => fact.operation === "search");
  const cors = endpoint((fact) => fact.operation === "cors");
  const required = validations.find((fact) => fact.rule === "required");
  const maxLength = validations.find((fact) => fact.rule === "maxLength");
  const enumFact = validations.find((fact) => fact.rule === "enum");
  const name = entity(create || getDetail || summary || search);
  if (getDetail) {
    add({ requirement_id: `req_${name}_not_found`, feature_id: feature(getDetail), intent: "not_found_semantics", scenario: "not_found", priority: "P0", source_refs: refs(getDetail), preconditions: [{ kind: "endpoint", refs: refs(getDetail) }], oracle: { kind: "http", assertion: "status equals 404", details: { status: 404 } }, risk: "read_only", confidence: Number(getDetail.confidence || 0.5) });
    add({ requirement_id: `req_${name}_detail`, feature_id: feature(getDetail), intent: "route_detail", scenario: "normal", priority: "P0", source_refs: refs(getDetail), preconditions: [{ kind: "endpoint", refs: refs(getDetail) }], oracle: { kind: "http", assertion: "status equals 200 and body contains id", details: { status: 200 } }, risk: "read_only", confidence: Number(getDetail.confidence || 0.5) });
  }
  if (required && create) add({ requirement_id: `req_${name}_title_validation`, feature_id: feature(required), intent: "required_field_rejected", scenario: "required_field", priority: "P0", source_refs: refs(required, maxLength, create), preconditions: [{ kind: "validation", refs: refs(required, maxLength) }, { kind: "endpoint", refs: refs(create) }], oracle: { kind: "validation", assertion: "missing or overlong title is rejected", details: { max_length: maxLength?.value } }, risk: "read_only", confidence: Math.min(Number(required.confidence || 0.5), Number(create.confidence || 0.5)) });
  if (summary) add({ requirement_id: `req_${name}_summary`, feature_id: feature(summary), intent: "summary_is_consistent", scenario: "normal", priority: "P0", source_refs: refs(summary), preconditions: [{ kind: "endpoint", refs: refs(summary) }], oracle: { kind: "json", assertion: "summary totals are internally consistent" }, risk: "read_only", confidence: Number(summary.confidence || 0.5) });
  if (create) add({ requirement_id: `req_${name}_create_refresh`, feature_id: feature(create), intent: "create_succeeds", scenario: "normal", priority: "P0", source_refs: refs(create), preconditions: [{ kind: "endpoint", refs: refs(create) }], oracle: { kind: "http", assertion: "created item is returned and visible after refresh", details: { status: 201 } }, risk: "mutating", confidence: Number(create.confidence || 0.5) });
  if (patch && /completed/i.test(sourceText)) add({ requirement_id: `req_${name}_completed`, feature_id: feature(patch), intent: "completed_state", scenario: "persistence", priority: "P0", source_refs: refs(patch), preconditions: [{ kind: "endpoint", refs: refs(patch) }], oracle: { kind: "persistence", assertion: "completed value persists after re-read" }, risk: "mutating", confidence: Number(patch.confidence || 0.5) });
  if (remove) add({ requirement_id: `req_${name}_delete`, feature_id: feature(remove), intent: "delete_removes_entity", scenario: "empty_state", priority: "P0", source_refs: refs(remove), preconditions: [{ kind: "endpoint", refs: refs(remove) }], oracle: { kind: "http", assertion: "delete returns no-content and the item is no longer found on re-read", details: { status: 204 } }, risk: "destructive", confidence: Number(remove.confidence || 0.5) });
  if (enumFact) add({ requirement_id: `req_${name}_priority_enum`, feature_id: feature(enumFact), intent: "enum_validation", scenario: "invalid_input", priority: "P0", source_refs: refs(enumFact, create, patch), preconditions: [{ kind: "validation", refs: refs(enumFact) }], oracle: { kind: "validation", assertion: "unsupported enum value is rejected", details: { values: enumFact.values } }, risk: "read_only", confidence: Number(enumFact.confidence || 0.5) });
  if (cors) add({ requirement_id: `req_${name}_patch_cors`, feature_id: feature(cors), intent: "cors_allows_operation", scenario: "cors", priority: "P1", source_refs: refs(cors), preconditions: [{ kind: "endpoint", refs: refs(cors) }], oracle: { kind: "http", assertion: "preflight returns allowed methods and origin", details: { status: 204 } }, risk: "read_only", confidence: Number(cors.confidence || 0.5) });
  if (patch) add({ requirement_id: `req_${name}_patch_persistence`, feature_id: feature(patch), intent: "update_persists", scenario: "persistence", priority: "P0", source_refs: refs(patch, getDetail), preconditions: [{ kind: "endpoint", refs: refs(patch, getDetail) }], oracle: { kind: "persistence", assertion: "updated fields persist after GET" }, risk: "mutating", confidence: Number(patch.confidence || 0.5) });
  if (search && controls.some((fact) => String(fact.control_id || "").toLowerCase() === "search" || String(fact.accessible_name || "").toLowerCase() === "search")) add({ requirement_id: `req_${name}_search`, feature_id: feature(search), intent: "search_filters_results", scenario: "normal", priority: "P0", source_refs: refs(search), preconditions: [{ kind: "endpoint", refs: refs(search) }], oracle: { kind: "collection", assertion: "results contain only matching items" }, risk: "read_only", confidence: Number(search.confidence || 0.5) });
  if (count) add({ requirement_id: `req_${name}_count`, feature_id: feature(count), intent: "count_consistent", scenario: "normal", priority: "P0", source_refs: refs(count, summary), preconditions: [{ kind: "endpoint", refs: refs(count, summary) }], oracle: { kind: "json", assertion: "count equals list length" }, risk: "read_only", confidence: Number(count.confidence || 0.5) });
  return requirements.sort((a, b) => a.requirement_id.localeCompare(b.requirement_id));
}

export function requirementCaseId(requirementId: string): string { return "case_" + requirementId.replace(/[^A-Za-z0-9_.:-]+/g, "_"); }
export function summarizeRequirementCoverage(requirements: TestRequirement[]): RequirementCoverage { return reconcileRequirementCoverage(requirements, {}, []); }
export function reconcileRequirementCoverage(requirements: TestRequirement[], requirementCaseMap: Record<string, string[]>, executionResults: RequirementExecutionLike[]): RequirementCoverage {
  const required = requirements.filter((item) => item.status !== "NOT_APPLICABLE" && item.status !== "TIER_SKIPPED");
  const planned = required.filter((item) => (requirementCaseMap[item.requirement_id] || []).length > 0 || item.status === "PLANNED");
  const executable = planned.filter((item) => item.status !== "BLOCKED" && item.oracle !== null);
  const executionByCase = new Map(executionResults.map((item) => [item.case_id, item]));
  const mappedCases = (item: TestRequirement): string[] => [...new Set(requirementCaseMap[item.requirement_id] || [])];
  const executed = executable.filter((item) => mappedCases(item).length > 0 && mappedCases(item).every((caseId) => executionByCase.has(caseId)));
  const passed = executed.filter((item) => mappedCases(item).every((caseId) => executionByCase.get(caseId)?.status === "PASSED"));
  const evidence_complete = passed.filter((item) => mappedCases(item).every((caseId) => (executionByCase.get(caseId)?.evidence_refs || []).length > 0));
  const p0 = required.filter((item) => item.priority === "P0");
  return { required: required.length, planned: planned.length, executable: executable.length, executed: executed.length, passed: passed.length, evidence_complete: evidence_complete.length, p0_required: p0.length, p0_planned: p0.filter((item) => planned.includes(item)).length, p0_executable: p0.filter((item) => executable.includes(item)).length, p0_executed: p0.filter((item) => executed.includes(item)).length, p0_passed: p0.filter((item) => passed.includes(item)).length };
}

export function analyzeDiff({ diffRef, root, mappings = [], changedFiles }: { diffRef?: string; root?: string; mappings?: { file_glob: string; features: string[]; propagate?: boolean }[]; changedFiles?: { status: string; path: string }[] }): DiffResult {
  if (!diffRef || diffRef === "NOOP" || diffRef === "empty") return { status: "NOOP", changed_files: [], affected_features: [], new_features: [] };
  let changed: { status: string; path: string }[] = [];
  if (changedFiles) changed = changedFiles;
  else if (root) {
    try {
      const output = execFileSync("git", ["diff", "--name-status", "--find-renames", diffRef], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      changed = output.split(/\r?\n/).filter(Boolean).map((line) => { const parts = line.split("\t"); return { status: parts[0].charAt(0), path: parts[0].charAt(0) === "R" ? parts[2] || parts[1] : parts[1] || "" }; }).filter((item) => item.path.length > 0);
    } catch (error) { throw Object.assign(new Error("git diff unavailable: " + (error instanceof Error ? error.message : String(error))), { code: "DIFF_UNAVAILABLE" }); }
  }
  if (changed.length === 0 && !root) {
    const paths = diffRef.split("...").map((value) => value.trim()).filter(Boolean);
    changed = paths.length === 0 ? [] : [{ status: "M", path: paths[paths.length - 1] }];
  }
  const changed_files = changed.map((item) => ({ ...item, feature_ids: [] as string[], new_feature: item.status === "A" }));
  const affected = new Set<string>();
  const newFeatures = new Set<string>();
  for (const file of changed_files) {
    const fileFeatures = new Set<string>();
    for (const mapping of mappings) if (globMatches(mapping.file_glob, file.path)) for (const feature of mapping.features) { fileFeatures.add(feature); affected.add(feature); if (file.status === "A") newFeatures.add(feature); }
    file.feature_ids = [...fileFeatures].sort();
    file.new_feature = file.status === "A" && fileFeatures.size > 0;
  }
  return { status: changed_files.length ? "CHANGED" : "NOOP", changed_files, affected_features: [...affected].sort(), new_features: [...newFeatures].sort() };
}

export function caseId(feature: string, scenario: string): string { return "case_" + feature.replace(/[^A-Za-z0-9_.:-]+/g, "_") + "_" + scenario.replace(/[^A-Za-z0-9_.:-]+/g, "_"); }
function globMatches(glob: string, value: string): boolean { const pattern = "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", ".*").replaceAll("*", "[^/]*") + "$"; return new RegExp(pattern).test(value); }
function digest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16); }
export { digest };
