import type { ExecutionResult, ExecutionManifest } from "@autopw/execution";

export interface AuditCaseLike { case_id: string; kind?: "ui" | "api" | "hybrid"; risk?: "read_only" | "mutating" | "destructive"; execution_policy?: { isolated_fixture_required?: boolean }; }
export interface AuditRequirementLike { requirement_id: string; status?: string; priority?: "P0" | "P1" | "P2"; }
export interface AuditCoverageLike { required: number; planned: number; executable: number; executed: number; passed: number; evidence_complete: number; p0_required?: number; p0_planned?: number; p0_executable?: number; p0_executed?: number; p0_passed?: number; }
export interface AuditOptions { requirements?: AuditRequirementLike[]; requirementCaseMap?: Record<string, string[]>; coverage?: AuditCoverageLike; cases?: AuditCaseLike[]; }
export interface AuditOutcome { audit_status: "COMPLETE" | "INCOMPLETE"; requirement_reconciliation: "COMPLETE" | "MISMATCH"; case_reconciliation: "COMPLETE" | "MISMATCH"; instance_reconciliation: "COMPLETE" | "MISMATCH"; evidence_complete: boolean; cleanup_complete: boolean; coverage?: AuditCoverageLike; issues: Record<string, unknown>[]; summary: Record<string, unknown>; }

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
    return Boolean(item.execution_policy?.isolated_fixture_required) || result?.cleanup_status === "PASSED";
  });
  const requirementIds = (options.requirements || []).filter((item) => item.status !== "TIER_SKIPPED" && item.status !== "NOT_APPLICABLE").map((item) => item.requirement_id);
  const requirementReconciliation = requirementIds.length === 0 || requirementIds.every((id) => {
    const mapped = options.requirementCaseMap?.[id] || [];
    return mapped.length > 0 && mapped.every((caseId) => caseIds.includes(caseId));
  });
  const issues = results.filter((item) => item.status === "FAILED" || item.status === "INFRA_BLOCKED").map((item) => ({ id: "issue_" + item.execution_id, classification: item.classification || (item.status === "INFRA_BLOCKED" ? "INFRA_DEFECT" : "PRODUCT_DEFECT"), confidence: "HIGH", execution_id: item.execution_id, evidence_refs: item.evidence_refs.map((ref) => ref.handle), message: item.error || "execution failed" }));
  const flakyIssues = results.filter((item) => item.stability === "FLAKY").map((item) => ({ id: "issue_flaky_" + item.execution_id, classification: "UNSTABLE", confidence: "HIGH", execution_id: item.execution_id, evidence_refs: item.evidence_refs.map((ref) => ref.handle), message: "execution passed after a retry" }));
  const complete = caseReconciliation && requirementReconciliation && instanceReconciliation && evidenceComplete && cleanupComplete && results.every((item) => item.status !== "BLOCKED_RESUME" && item.status !== "INFRA_BLOCKED");
  return { audit_status: complete ? "COMPLETE" : "INCOMPLETE", requirement_reconciliation: requirementReconciliation ? "COMPLETE" : "MISMATCH", case_reconciliation: caseReconciliation ? "COMPLETE" : "MISMATCH", instance_reconciliation: instanceReconciliation ? "COMPLETE" : "MISMATCH", evidence_complete: evidenceComplete, cleanup_complete: cleanupComplete, ...(options.coverage ? { coverage: options.coverage } : {}), issues: [...issues, ...flakyIssues], summary: { total_cases: caseIds.length, total_instances: results.length, passed: results.filter((item) => item.status === "PASSED").length, failed: results.filter((item) => item.status === "FAILED").length, blocked: results.filter((item) => item.status === "BLOCKED_RESUME" || item.status === "INFRA_BLOCKED").length, flaky: flakyIssues.length, requirement_reconciliation: requirementReconciliation ? "COMPLETE" : "MISMATCH", cleanup_complete: cleanupComplete, evidence_complete: evidenceComplete } };
}

function evidenceForCase(result: ExecutionResult, testCase: AuditCaseLike | undefined): boolean {
  if (result.evidence_refs.length === 0) return false;
  if (!testCase?.kind) return true;
  const kinds = new Set(result.evidence_refs.map((ref) => ref.kind));
  if (testCase.kind === "api") return kinds.has("api-response");
  const ui = kinds.has("screenshot") && kinds.has("console.json") && kinds.has("playwright-trace");
  return testCase.kind === "ui" ? ui : ui && kinds.has("api-response");
}
