import crypto from "node:crypto";
import type { TestPlan } from "./model.js";
import { normalizePlan } from "./normalize.js";
import type { PlanValidationContext } from "./validator.js";

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + stableStringify(item)).join(",") + "}";
  return JSON.stringify(value);
}

export function planDigest(plan: TestPlan, context: PlanValidationContext = { authority: "untrusted" }): string {
  const normalized = normalizePlan(plan, context);
  return crypto.createHash("sha256").update(stableStringify({ ...normalized, generated_at: "" })).digest("hex");
}
