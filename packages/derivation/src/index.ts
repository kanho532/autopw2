import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { DiscoveryResult } from "@autopw/discovery";
import type { ApplicationGraph, EvidenceCollection } from "@autopw/application-graph";
import { planExecutionInstances, type MatrixProfile, type ExecutionProjection } from "@autopw/planner";
import { deriveGraphRequirements } from "./requirements-v2.js";

export type Tier = "smoke" | "fast" | "full";
export type CoverageStatus = "PLANNED" | "BLOCKED" | "NOT_APPLICABLE" | "TIER_SKIPPED";
export type RequirementIntent = "route_loads" | "create_succeeds" | "required_field_rejected" | "boundary_rejected" | "not_found_semantics" | "route_detail" | "completed_state" | "delete_removes_entity" | "enum_validation" | "update_persists" | "search_filters_results" | "summary_is_consistent" | "count_consistent" | "cors_allows_operation";
export type RequirementStatus = "REQUIRED" | "PLANNED" | "BLOCKED" | "NOT_APPLICABLE" | "TIER_SKIPPED";
export interface RequirementPrecondition { kind: string; refs: string[]; details?: Record<string, unknown>; }
export interface RequirementOracle { kind: string; assertion: string; details?: Record<string, unknown>; }
export interface RequirementOperationRef { operation_id: string; method: string; path: string; }
export interface RequirementIdentityStrategy { kind: "response_body" | "location_header" | "explicit" | "none"; path?: string; header?: string; proven: boolean; reason?: string; }
export interface RequirementFixtureStrategy { kind: "none" | "resource_crud" | "seed" | "manual" | "workflow"; operation_ids: string[]; create_operation_id?: string; read_operation_id?: string; cleanup_operation_id?: string; create?: RequirementOperationRef; read?: RequirementOperationRef; update?: RequirementOperationRef; cleanup?: RequirementOperationRef; identity?: RequirementIdentityStrategy; payload?: Record<string, unknown>; proven: boolean; reason?: string; }
export interface RequirementPayloadStrategy { kind: "none" | "schema" | "constraint"; schema_refs?: string[]; field_ids?: string[]; field_id?: string; rule?: string; value?: unknown; values?: unknown[]; valid_payload?: Record<string, unknown>; invalid_payload?: Record<string, unknown>; boundary_payloads?: Record<string, unknown>[]; proven: boolean; reason?: string; }
export interface RequirementOracleSpecification { kind: string; operation_ids: string[]; field_ids: string[]; evidence_refs: string[]; assertion: string; proven: boolean; reason?: string; }
export interface TestRequirement { requirement_id: string; feature_id: string; intent: RequirementIntent; scenario: string; priority: "P0" | "P1" | "P2"; source_refs: string[]; evidence_refs: string[]; operation_id?: string; resource_id?: string; field_id?: string; workflow_id?: string; preconditions: RequirementPrecondition[]; fixture_strategy: RequirementFixtureStrategy; payload_strategy: RequirementPayloadStrategy; oracle: RequirementOracle | null; oracle_specification: RequirementOracleSpecification; risk: "read_only" | "mutating" | "destructive"; confidence: number; status: RequirementStatus; reason?: string; }
export interface RequirementCoverage { required: number; planned: number; executable: number; executed: number; passed: number; evidence_complete: number; p0_required: number; p0_planned: number; p0_executable: number; p0_executed: number; p0_passed: number; }
export interface RequirementExecutionLike { case_id: string; status: string; evidence_refs?: unknown[]; }
export interface DiffResult { status: "NOOP" | "CHANGED"; changed_files: { status: string; path: string; feature_ids: string[]; new_feature: boolean }[]; affected_features: string[]; new_features: string[]; }
export interface DerivationInput { discovery: DiscoveryResult; application_graph?: ApplicationGraph; evidence?: EvidenceCollection; tier: Tier; diff?: DiffResult; matrix?: MatrixProfile; mandatory_capabilities?: { id: string; priority: "P0" | "P1" | "P2"; feature_ids: string[]; on_missing: "incomplete" | "warn" }[]; input_versions?: Record<string, string>; destructive_allowed?: boolean; allow_destructive?: boolean; }
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
  const requirements = deriveRequirements({ discovery: input.discovery, application_graph: input.application_graph, evidence: input.evidence, tier: input.tier, diff, destructive_allowed: input.destructive_allowed ?? input.allow_destructive ?? true });
  const p0 = skeleton.filter((item) => item.priority === "P0" && item.status !== "TIER_SKIPPED" && item.status !== "NOT_APPLICABLE");
  const coveredP0 = p0.filter((item) => item.status === "PLANNED" && !item.blocked).length;
  const p0_coverage_pct = p0.length === 0 ? null : Math.round((coveredP0 / p0.length) * 10000) / 100;
  const input_versions = { engine_version: "2.1.0-m9.6", schema_version_bundle: "2.1", ...(input.input_versions || {}) };
  const metrics = { derivation_cpu_ms: Math.max(0, Math.round(performance.now() - started)) };
  const requirementCoverage = summarizeRequirementCoverage(requirements);
  const requirementCaseLinks = Object.fromEntries(requirements.map((requirement) => [requirement.requirement_id, [requirementCaseId(requirement.requirement_id)]]));
  return { schema_version: "2.1", skeleton, matrix: projection.batches as unknown as Record<string, unknown>[], p0_required_total: p0.length, p0_coverage_pct, input_versions, metrics, projection, cdd: { title: "Coverage Development Description", scope: skeleton.map((item) => ({ case_id: item.case_id, feature_id: item.feature_id, scenario: item.scenario, effective_tier: item.effective_tier, status: item.status, reason: item.reason })), requirements, requirement_case_links: requirementCaseLinks, coverage: requirementCoverage, p0_blocked: p0.some((item) => item.blocked), blockers: skeleton.filter((item) => item.blocked).map((item) => ({ case_id: item.case_id, reason: item.reason })), candidates: input.discovery.candidates.map((candidate) => ({ id: candidate.id, kind: candidate.kind, feature_id: candidate.feature_id })) } };
}

export function deriveRequirements({ discovery, application_graph, evidence, tier, diff = { status: "NOOP", changed_files: [], affected_features: [], new_features: [] }, destructive_allowed = true }: { discovery: DiscoveryResult; application_graph?: ApplicationGraph; evidence?: EvidenceCollection; tier: Tier; diff?: DiffResult; destructive_allowed?: boolean }): TestRequirement[] {
  return deriveGraphRequirements({ discovery, application_graph, evidence, tier, diff, destructive_allowed });
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
