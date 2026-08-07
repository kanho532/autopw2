import type { TestPlan } from "./model.js";
import { normalizePlan } from "./normalize.js";

export type PlanMergeMode = "auto" | "overlay" | "replace";

export function mergePlans(autoPlan: TestPlan, manualPlan: TestPlan | undefined, mode: PlanMergeMode): TestPlan {
  const auto = normalizePlan(autoPlan);
  if (!manualPlan || mode === "auto") return auto;
  const manual = normalizePlan(manualPlan);
  if (mode === "replace") return manual;
  const manualById = new Map(manual.cases.map((item) => [item.case_id, item]));
  const merged = auto.cases.map((item) => manualById.get(item.case_id) || item);
  for (const item of manual.cases) if (!auto.cases.some((candidate) => candidate.case_id === item.case_id)) merged.push(item);
  return normalizePlan({ ...auto, cases: merged });
}
