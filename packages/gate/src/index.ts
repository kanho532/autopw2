export interface GateAuditLike { audit_status: "COMPLETE" | "INCOMPLETE"; evidence_complete?: boolean; cleanup_complete?: boolean; requirement_reconciliation?: "COMPLETE" | "MISMATCH"; oracle_reconciliation?: "COMPLETE" | "MISMATCH"; }
export interface GateCoverageLike { p0_required?: number; p0_planned?: number; p0_executable?: number; p0_executed?: number; p0_passed?: number; }
export interface GatePolicy { strategy?: "product" | "strict"; min_p0_coverage_pct?: number; max_flaky_cases?: number; }
export interface GateOutcome { gate: "incomplete" | "infra" | "fail" | "unstable" | "pass"; exit_code: number; reason: string; }

export function evaluateGate({ audit, auditStatus, coverage, gatePolicy, issues = [], executionResults = [] }: { audit?: GateAuditLike; auditStatus?: "COMPLETE" | "INCOMPLETE"; coverage?: GateCoverageLike; gatePolicy?: GatePolicy; issues?: Record<string, unknown>[]; executionResults?: Array<{ stability?: string }> }): GateOutcome {
  const status = audit?.audit_status || auditStatus || "INCOMPLETE";
  if (status === "INCOMPLETE" || audit?.requirement_reconciliation === "MISMATCH" || audit?.oracle_reconciliation === "MISMATCH" || audit?.evidence_complete === false || audit?.cleanup_complete === false) return { gate: "incomplete", exit_code: 2, reason: "structural audit or coverage reconciliation incomplete" };
  const p0Required = Number(coverage?.p0_required || 0);
  const p0Executable = Number(coverage?.p0_executable || 0);
  if (p0Required > 0 && (p0Executable < p0Required || Number(coverage?.p0_planned || 0) < p0Required)) return { gate: "incomplete", exit_code: 2, reason: "P0 requirement is not planned and executable" };
  if (issues.some((item) => item.classification === "PLAN_DEFECT" || item.classification === "TEST_DEFECT")) return { gate: "incomplete", exit_code: 2, reason: "test generation or plan execution is not trustworthy" };
  if (issues.some((item) => item.classification === "INFRA_DEFECT")) return { gate: "infra", exit_code: 2, reason: "infrastructure defect" };
  if (issues.some((item) => item.classification === "PRODUCT_DEFECT")) return { gate: "fail", exit_code: 1, reason: "product defect" };
  const flakyIssues = issues.filter((item) => item.classification === "UNSTABLE");
  const flakyIssueIds = new Set(flakyIssues.filter((item) => typeof item.execution_id === "string").map((item) => String(item.execution_id)));
  const flaky = flakyIssues.filter((item) => typeof item.execution_id !== "string").length + flakyIssueIds.size + executionResults.filter((item) => item.stability === "FLAKY" && !flakyIssueIds.has(String((item as { execution_id?: string }).execution_id || ""))).length;
  if (flaky > Number(gatePolicy?.max_flaky_cases ?? 0)) return { gate: "unstable", exit_code: 1, reason: "flaky case threshold exceeded" };
  const minP0 = Number(gatePolicy?.min_p0_coverage_pct ?? 100);
  const p0Covered = Number(coverage?.p0_passed ?? coverage?.p0_executed ?? coverage?.p0_executable ?? 0);
  const p0Pct = p0Required === 0 ? 100 : (p0Covered / p0Required) * 100;
  if (p0Pct < minP0) return { gate: "incomplete", exit_code: 2, reason: `P0 coverage ${Math.round(p0Pct * 100) / 100}% is below ${minP0}%` };
  return { gate: "pass", exit_code: 0, reason: "all required cases passed with complete evidence and cleanup" };
}
