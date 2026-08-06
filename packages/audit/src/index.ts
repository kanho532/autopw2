import type { ExecutionResult } from "@autopw/execution";

export interface AuditOutcome { audit_status: "COMPLETE" | "INCOMPLETE"; case_reconciliation: "COMPLETE" | "MISMATCH"; instance_reconciliation: "COMPLETE" | "MISMATCH"; evidence_complete: boolean; issues: Record<string, unknown>[]; summary: Record<string, unknown>; }

export function auditExecution(caseIds: string[], results: ExecutionResult[]): AuditOutcome {
  const resultIds = results.map((item) => item.case_id);
  const caseReconciliation = caseIds.length === resultIds.length && caseIds.every((id) => resultIds.includes(id));
  const instanceReconciliation = results.every((item) => Boolean(item.execution_id) && item.case_id.length > 0);
  const evidenceComplete = results.filter((item) => item.status !== "BLOCKED_RESUME").every((item) => item.evidence_refs.length > 0);
  const issues = results.filter((item) => item.status === "FAILED").map((item) => ({ id: "issue_" + item.execution_id, classification: item.classification || "PRODUCT_DEFECT", confidence: "HIGH", execution_id: item.execution_id, evidence_refs: item.evidence_refs.map((ref) => ref.handle), message: item.error || "execution failed" }));
  const complete = caseReconciliation && instanceReconciliation && evidenceComplete && results.every((item) => item.status !== "BLOCKED_RESUME");
  return { audit_status: complete ? "COMPLETE" : "INCOMPLETE", case_reconciliation: caseReconciliation ? "COMPLETE" : "MISMATCH", instance_reconciliation: instanceReconciliation ? "COMPLETE" : "MISMATCH", evidence_complete: evidenceComplete, issues, summary: { total_cases: caseIds.length, total_instances: results.length, passed: results.filter((item) => item.status === "PASSED").length, failed: results.filter((item) => item.status === "FAILED").length, blocked: results.filter((item) => item.status === "BLOCKED_RESUME").length } };
}
