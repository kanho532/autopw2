import fs from "node:fs";
import path from "node:path";
import type { TestPlan } from "./model.js";
import { normalizePlan } from "./normalize.js";
import type { PlanValidationContext } from "./validator.js";

export function parsePlan(value: string | unknown, context: PlanValidationContext = { authority: "untrusted" }): TestPlan {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return normalizePlan(parsed as TestPlan, context);
}

export function loadPlanFile(file: string, context: PlanValidationContext = { authority: "untrusted" }): TestPlan {
  const resolved = path.resolve(file);
  return parsePlan(fs.readFileSync(resolved, "utf8"), context);
}

export function loadPlan(value: string | TestPlan, context: PlanValidationContext = { authority: "untrusted" }): TestPlan {
  return typeof value === "string" && fs.existsSync(path.resolve(value)) ? loadPlanFile(value, context) : parsePlan(value, context);
}
