import type { ExecutionResult, ExecutionManifest } from "@autopw/execution";
import { triageFailure } from "@autopw/triage";

export interface AuditCaseLike { case_id: string; kind?: "ui" | "api" | "hybrid"; risk?: "read_only" | "mutating" | "destructive"; confidence?: number; origin?: { type?: string }; requirement_refs?: string[]; execution_policy?: { isolated_fixture_required?: boolean }; }
export interface AuditRequirementLike { requirement_id: string; status?: string; priority?: "P0" | "P1" | "P2"; evidence_refs?: string[]; oracle?: { kind?: string; assertion?: string } | null; oracle_specification?: { kind?: string; proven?: boolean }; }
export interface AuditCoverageLike { required: number; planned: number; executable: number; executed: number; passed: number; evidence_complete: number; p0_required?: number; p0_planned?: number; p0_executable?: number; p0_executed?: number; p0_passed?: number; }
export interface AuditOptions { requirements?: AuditRequirementLike[]; requirementCaseMap?: Record<string, string[]>; requirementOracleMap?: Record<string, string[]>; coverage?: AuditCoverageLike; cases?: AuditCaseLike[]; }
export interface AuditOutcome { audit_status: "COMPLETE" | "INCOMPLETE"; requirement_reconciliation: "COMPLETE" | "MISMATCH"; oracle_reconciliation: "COMPLETE" | "MISMATCH"; case_reconciliation: "COMPLETE" | "MISMATCH"; instance_reconciliation: "COMPLETE" | "MISMATCH"; evidence_complete: boolean; cleanup_complete: boolean; coverage?: AuditCoverageLike; coverage_metrics: Record<string, number>; issues: Record<string, unknown>[]; summary: Record<string, unknown>; }

export function auditExecution(caseIds: string[], results: ExecutionResult[], manifest?: ExecutionManifest, options: AuditOptions = {}): AuditOutcome {
  const resultIds = results.map((item) => item.case_id);
  const expectedCases = new Set(caseIds);
  const actualCases = new Set(resultIds);
  const executionIds = results.map((item) => item.execution_id);
  const expectedExecutionIds = manifest?.instances.map((item) => String(item.execution_id)) || [];
  const caseReconciliation = caseIds.length === expectedCases.size && expectedCases.size === actualCases.size && caseIds.every((id) => actualCases.has(id));
  const instanceReconciliation = results.length === executionIds.length && executionIds.length === new Set(executionIds).size && results.every((item) => Boolean(item.execution_id) && item.case_id.length > 0) && (!manifest || expectedExecutionIds.length === executionIds.length && expectedExecutionIds.every((id) => executionIds.includes(id)));
  const caseById = new Map((options.cases || []).map((item) => [item.case_id, item]));
  const evidenceComplete = results.filter((item) => item.status !== "BLOCKED_RESUME" && item.status !== "INFRA_BLOCKED").every((item) => evidenceForCase(item, caseById.get(item.case_id)));
  const cleanupRequired = (options.cases || []).filter((item) => item.risk === "mutating" || item.risk === "destructive");
  const cleanupComplete = cleanupRequired.every((item) => {
    const result = results.find((candidate) => candidate.case_id === item.case_id);
    return result?.cleanup_status === "PASSED";
  });
  const requirementIds = (options.requirements || []).filter((item) => item.status !== "TIER_SKIPPED" && item.status !== "NOT_APPLICABLE").map((item) => item.requirement_id);
  const requirementReconciliation = requirementIds.length === 0 || requirementIds.every((id) => {
    const mapped = options.requirementCaseMap?.[id] || [];
    return mapped.length > 0 && mapped.every((caseId) => caseIds.includes(caseId));
  });
  const oracleReconciliation = requirementIds.every((id) => {
    const requirement = options.requirements?.find((item) => item.requirement_id === id);
    if (!requirement || !("oracle" in requirement)) return true;
    if (requirement.oracle === null) return false;
    return (options.requirementOracleMap?.[id] || []).length > 0;
  });
  const issues = results.filter((item) => item.status === "FAILED" || item.status === "INFRA_BLOCKED").map((item) => {
    const testCase = caseById.get(item.case_id);
    const requirement = (testCase?.requirement_refs || []).map((id) => options.requirements?.find((candidate) => candidate.requirement_id === id)).find(Boolean);
    const decision = triageFailure({ proposed_classification: item.classification, signal: item.failure_signal, plan_origin: testCase?.origin?.type || "unknown", case_confidence: testCase?.confidence, evidence_refs: item.evidence_refs.map((ref) => ref.handle), requirement_evidence_refs: requirement?.evidence_refs, oracle: { kind: requirement?.oracle_specification?.kind || requirement?.oracle?.kind, proven: requirement?.oracle_specification?.proven ?? requirement?.oracle !== null } });
    return { id: "issue_" + item.execution_id, classification: decision.classification, confidence: decision.confidence, execution_id: item.execution_id, evidence_refs: item.evidence_refs.map((ref) => ref.handle), message: item.error || "execution failed", triage: decision, ...(item.failure_signal ? { failure_signal: item.failure_signal } : {}) };
  });
  const flakyIssues = results.filter((item) => item.stability === "FLAKY").map((item) => ({ id: "issue_flaky_" + item.execution_id, classification: "UNSTABLE", confidence: "HIGH", execution_id: item.execution_id, evidence_refs: item.evidence_refs.map((ref) => ref.handle), message: "execution passed after a retry" }));
  const complete = caseReconciliation && requirementReconciliation && oracleReconciliation && instanceReconciliation && evidenceComplete && cleanupComplete && results.every((item) => item.status !== "BLOCKED_RESUME" && item.status !== "INFRA_BLOCKED");
  const coverageMetrics = buildCoverageMetrics(options, results, caseById, issues, cleanupRequired);
  return { audit_status: complete ? "COMPLETE" : "INCOMPLETE", requirement_reconciliation: requirementReconciliation ? "COMPLETE" : "MISMATCH", oracle_reconciliation: oracleReconciliation ? "COMPLETE" : "MISMATCH", case_reconciliation: caseReconciliation ? "COMPLETE" : "MISMATCH", instance_reconciliation: instanceReconciliation ? "COMPLETE" : "MISMATCH", evidence_complete: evidenceComplete, cleanup_complete: cleanupComplete, ...(options.coverage ? { coverage: options.coverage } : {}), coverage_metrics: coverageMetrics, issues: [...issues, ...flakyIssues], summary: { total_cases: caseIds.length, total_instances: results.length, passed: results.filter((item) => item.status === "PASSED").length, failed: results.filter((item) => item.status === "FAILED").length, blocked: results.filter((item) => item.status === "BLOCKED_RESUME" || item.status === "INFRA_BLOCKED").length, flaky: flakyIssues.length, requirement_reconciliation: requirementReconciliation ? "COMPLETE" : "MISMATCH", oracle_reconciliation: oracleReconciliation ? "COMPLETE" : "MISMATCH", cleanup_complete: cleanupComplete, evidence_complete: evidenceComplete, coverage_metrics: coverageMetrics } };
}

function buildCoverageMetrics(options: AuditOptions, results: ExecutionResult[], caseById: Map<string, AuditCaseLike>, issues: Record<string, unknown>[], cleanupRequired: AuditCaseLike[]): Record<string, number> {
  const requirements = options.requirements || [];
  const discovered = requirements.filter((item) => item.status !== "NOT_APPLICABLE");
  const inTier = discovered.filter((item) => item.status !== "TIER_SKIPPED");
  const passedRequirement = (requirement: AuditRequirementLike): boolean => (options.requirementCaseMap?.[requirement.requirement_id] || []).length > 0 && (options.requirementCaseMap?.[requirement.requirement_id] || []).every((caseId) => results.some((item) => item.case_id === caseId && item.status === "PASSED"));
  const generatedResults = results.filter((item) => caseById.get(item.case_id)?.origin?.type === "generated");
  const generatorIssueIds = new Set(issues.filter((item) => item.classification === "PLAN_DEFECT" || item.classification === "TEST_DEFECT").map((item) => String(item.execution_id)));
  const productIssues = issues.filter((item) => item.classification === "PRODUCT_DEFECT");
  const semantic = inTier.filter((item) => ["relation", "collection", "persistence", "deletion", "semantic", "ui_relation"].includes(item.oracle_specification?.kind || ""));
  const semanticBound = semantic.filter((item) => (options.requirementOracleMap?.[item.requirement_id] || []).length > 0);
  const cleanupPassed = cleanupRequired.filter((item) => results.find((candidate) => candidate.case_id === item.case_id)?.cleanup_status === "PASSED").length;
  return {
    tier_coverage_pct: percent(inTier.filter(passedRequirement).length, inTier.length),
    discovered_scope_coverage_pct: percent(discovered.filter(passedRequirement).length, discovered.length),
    generated_case_precision_pct: percent(generatedResults.filter((item) => !generatorIssueIds.has(item.execution_id)).length, generatedResults.length),
    false_product_defect_rate_pct: productIssues.length === 0 ? 0 : percent(productIssues.filter((item) => item.confidence !== "HIGH").length, productIssues.length),
    semantic_oracle_coverage_pct: percent(semanticBound.length, semantic.length),
    cleanup_integrity_pct: percent(cleanupPassed, cleanupRequired.length)
  };
}
function percent(numerator: number, denominator: number): number { return denominator === 0 ? 100 : Math.round((numerator / denominator) * 10000) / 100; }

function evidenceForCase(result: ExecutionResult, testCase: AuditCaseLike | undefined): boolean {
  if (result.evidence_refs.length === 0) return false;
  if (!testCase?.kind) return true;
  const kinds = new Set(result.evidence_refs.map((ref) => ref.kind));
  if (testCase.kind === "api") return kinds.has("api-response");
  const ui = kinds.has("screenshot") && kinds.has("console.json") && kinds.has("playwright-trace");
  return testCase.kind === "ui" ? ui : ui && kinds.has("api-response");
}
