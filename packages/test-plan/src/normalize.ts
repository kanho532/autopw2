import type { TestPlan } from "./model.js";
import { assertValidPlan, type PlanValidationContext } from "./validator.js";

export function normalizePlan(input: TestPlan, context: PlanValidationContext = { authority: "untrusted" }): TestPlan {
  assertValidPlan(input, context);
  const plan = JSON.parse(JSON.stringify(input)) as TestPlan;
  plan.cases = [...plan.cases].sort((a, b) => a.case_id.localeCompare(b.case_id)).map((item) => ({
    ...item,
    requirement_refs: [...item.requirement_refs].sort(),
    ...(item.setup ? { setup: [...item.setup] } : {}),
    steps: [...item.steps],
    ...(item.cleanup ? { cleanup: [...item.cleanup] } : {})
  }));
  if (plan.fixtures) plan.fixtures = Object.fromEntries(Object.entries(plan.fixtures).sort(([a], [b]) => a.localeCompare(b)));
  return plan;
}
