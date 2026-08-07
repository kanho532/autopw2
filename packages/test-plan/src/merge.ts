import type { FixtureDefinition, TestCase, TestPlan } from "./model.js";
import { stableStringify } from "./digest.js";
import { normalizePlan } from "./normalize.js";

export type PlanMergeMode = "auto" | "overlay" | "replace";

export function mergePlans(autoPlan: TestPlan, manualPlan: TestPlan | undefined, mode: PlanMergeMode): TestPlan {
  const auto = normalizePlan(autoPlan, { authority: "generated" });
  if (!manualPlan || mode === "auto") return auto;
  const manual = normalizePlan(manualPlan, { authority: "trusted_manual" });
  if (mode === "replace") return manual;

  const fixtures = mergeFixtures(auto.fixtures || {}, manual.fixtures || {});
  const manualById = new Map(manual.cases.map((item) => [item.case_id, withManualOrigin(item, manual)]));
  const mergedCases = auto.cases.map((item) => manualById.get(item.case_id) || item);
  for (const item of manual.cases) if (!auto.cases.some((candidate) => candidate.case_id === item.case_id)) mergedCases.push(withManualOrigin(item, manual));
  const merged = normalizePlan({
    ...auto,
    origin: { type: "mixed", source_ref: manual.origin.source_ref || auto.origin.source_ref || "plan://overlay" },
    target: manual.target || auto.target,
    fixtures,
    cases: mergedCases
  }, { authority: "trusted_manual" });
  return merged;
}

function withManualOrigin(item: TestCase, manual: TestPlan): TestCase {
  return { ...item, origin: { type: "manual", source_ref: manual.origin.source_ref || "plan://manual-overlay" } };
}

function mergeFixtures(auto: Record<string, FixtureDefinition>, manual: Record<string, FixtureDefinition>): Record<string, FixtureDefinition> {
  const merged = { ...auto };
  for (const [name, value] of Object.entries(manual)) {
    if (name in merged && stableStringify(merged[name]) !== stableStringify(value)) {
      throw Object.assign(new Error("manual fixture conflicts with generated fixture: " + name), { code: "PLAN_FIXTURE_CONFLICT", fixture: name });
    }
    merged[name] = value;
  }
  return merged;
}
