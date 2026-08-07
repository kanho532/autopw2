import fs from "node:fs";
import path from "node:path";
import type { TestPlan } from "./model.js";
import { normalizePlan } from "./normalize.js";

export function parsePlan(value: string | unknown): TestPlan {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return normalizePlan(parsed as TestPlan);
}

export function loadPlanFile(file: string): TestPlan {
  const resolved = path.resolve(file);
  return parsePlan(fs.readFileSync(resolved, "utf8"));
}

export function loadPlan(value: string | TestPlan): TestPlan {
  return typeof value === "string" && fs.existsSync(path.resolve(value)) ? loadPlanFile(value) : parsePlan(value);
}
