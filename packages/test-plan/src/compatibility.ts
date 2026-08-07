import { cssLocator } from "./locator.js";
import type { TestPlan, TestStep } from "./model.js";

export interface FixtureStepLike { action: string; path?: string; selector?: string; value?: string; }
export interface FixtureCaseLike { case_id: string; feature_id: string; scenario: string; effective_tier: string; steps: FixtureStepLike[]; }
export interface FixturePlanLike { schema_version: string; cases: FixtureCaseLike[]; frozen_at?: string; }

export function fromFixturePlan(fixturePlan: FixturePlanLike): TestPlan {
  return {
    plan_schema: "autopw.test-plan/1.0",
    plan_id: "migrated-fixture-plan",
    generated_at: fixturePlan.frozen_at || new Date(0).toISOString(),
    origin: { type: "migrated", source_ref: "fixture://plan" },
    coverage_eligible: true,
    cases: fixturePlan.cases.map((item) => ({
      case_id: item.case_id,
      title: item.case_id,
      feature_id: item.feature_id,
      requirement_refs: ["legacy." + item.case_id],
      scenario: item.scenario === "required_field" ? "required_field" : "normal",
      priority: "P0",
      effective_tier: item.effective_tier === "smoke" || item.effective_tier === "full" ? item.effective_tier : "fast",
      kind: "ui",
      risk: "read_only",
      confidence: 1,
      execution_policy: { production_allowed: false, isolated_fixture_required: true },
      steps: item.steps.map(convertStep)
    }))
  };
}

function convertStep(step: FixtureStepLike): TestStep {
  switch (step.action) {
    case "goto": return { action: "goto", path: step.path || "/" };
    case "fill": return { action: "fill", locator: cssLocator(step.selector || ""), value: step.value || "" };
    case "click": return { action: "click", locator: cssLocator(step.selector || "") };
    case "expect_visible": return { action: "expect_visible", locator: cssLocator(step.selector || "") };
    case "expect_no_console_errors": return { action: "expect_no_console_errors" };
    default: throw Object.assign(new Error("unsupported fixture step: " + step.action), { code: "FIXTURE_STEP_UNSUPPORTED" });
  }
}
