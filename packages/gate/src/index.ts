export interface GateOutcome { gate: "incomplete" | "infra" | "fail" | "unstable" | "pass"; exit_code: number; reason: string; }

export function evaluateGate({ auditStatus, issues }: { auditStatus: "COMPLETE" | "INCOMPLETE"; issues: Record<string, unknown>[] }): GateOutcome {
  if (auditStatus === "INCOMPLETE") return { gate: "incomplete", exit_code: 2, reason: "structural audit incomplete" };
  if (issues.some((item) => item.classification === "INFRA_DEFECT")) return { gate: "infra", exit_code: 2, reason: "infrastructure defect" };
  if (issues.some((item) => item.classification === "PRODUCT_DEFECT")) return { gate: "fail", exit_code: 1, reason: "product defect" };
  return { gate: "pass", exit_code: 0, reason: "all fixture cases passed" };
}
