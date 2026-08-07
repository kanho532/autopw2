import { extractVariableReferences } from "./interpolation.js";
import { AUTOMATIC_LOCATOR_KINDS } from "./locator.js";
import { TEST_PLAN_SCHEMA, type TestCase, type TestPlan, type TestStep, type ValidationResult } from "./model.js";
import { FORBIDDEN_STEP_ACTIONS, isSupportedStepAction } from "./steps.js";

const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const SAFE_PATH_PATTERN = /^(?:\/|\.\/|[A-Za-z0-9_.-])[A-Za-z0-9_./?=&:%{}$-]*$/;
const HTTP_PATTERN = /^(?:https?:|javascript:|data:|file:|\\\\|\/\/)/i;
const FORBIDDEN_PROPERTY_PATTERN = /^(?:script|code|command|shell|execute|selector|xpath)$/i;

export function validatePlan(plan: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(plan)) return { ok: false, errors: ["plan must be an object"] };
  if (plan.plan_schema !== TEST_PLAN_SCHEMA) errors.push("plan_schema must be " + TEST_PLAN_SCHEMA);
  requireString(plan, "plan_id", errors, ID_PATTERN, "plan_id");
  requireString(plan, "generated_at", errors, undefined, "generated_at");
  if (!isObject(plan.origin) || !["generated", "manual", "migrated", "bootstrap"].includes(plan.origin.type as string)) errors.push("origin.type is invalid");
  if (typeof plan.coverage_eligible !== "boolean") errors.push("coverage_eligible must be boolean");
  if (!Array.isArray(plan.cases) || plan.cases.length === 0) errors.push("cases must be a non-empty array");
  const seen = new Set<string>();
  for (const item of Array.isArray(plan.cases) ? plan.cases : []) {
    if (!isObject(item)) { errors.push("case must be an object"); continue; }
    validateCase(item as unknown as TestCase, plan, errors, seen);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertValidPlan(plan: unknown): asserts plan is TestPlan {
  const result = validatePlan(plan);
  if (!result.ok) throw Object.assign(new Error("invalid TestPlan: " + result.errors.join("; ")), { code: "PLAN_INVALID", errors: result.errors });
}

function validateCase(item: TestCase, plan: Record<string, unknown>, errors: string[], seen: Set<string>): void {
  const prefix = "case " + String(item.case_id || "<unknown>");
  if (typeof item.case_id !== "string" || !ID_PATTERN.test(item.case_id)) errors.push(prefix + ": invalid case_id");
  else if (seen.has(item.case_id)) errors.push(prefix + ": duplicate case_id");
  else seen.add(item.case_id);
  for (const key of ["title", "feature_id"] as const) if (typeof item[key] !== "string" || !item[key]) errors.push(prefix + ": " + key + " is required");
  if (!Array.isArray(item.requirement_refs) || item.requirement_refs.some((value) => typeof value !== "string" || !ID_PATTERN.test(value))) errors.push(prefix + ": invalid requirement_refs");
  if (!["normal", "required_field", "invalid_input", "empty_state", "boundary", "service_error", "network_failure", "not_found", "persistence", "cors"].includes(item.scenario)) errors.push(prefix + ": invalid scenario");
  if (!["P0", "P1", "P2"].includes(item.priority) || !["smoke", "fast", "full"].includes(item.effective_tier) || !["ui", "api", "hybrid"].includes(item.kind) || !["read_only", "mutating", "destructive"].includes(item.risk)) errors.push(prefix + ": invalid case policy enum");
  if (typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1) errors.push(prefix + ": confidence must be between 0 and 1");
  if (!isObject(item.execution_policy) || typeof item.execution_policy.production_allowed !== "boolean") errors.push(prefix + ": execution_policy.production_allowed is required");
  const setupVariables = new Set<string>();
  const testVariables = new Set<string>(setupVariables);
  const cleanupVariables = new Set<string>(testVariables);
  for (const phase of ["setup", "steps", "cleanup"] as const) {
    if (phase === "steps" && !Array.isArray(item.steps)) errors.push(prefix + ": steps is required");
    if (item[phase] !== undefined && !Array.isArray(item[phase])) errors.push(prefix + ": " + phase + " must be an array");
    if (Array.isArray(item[phase])) {
      const available = phase === "setup" ? setupVariables : phase === "steps" ? testVariables : cleanupVariables;
      validateSteps(item[phase], phase, plan, errors, prefix, available);
      if (phase === "setup") for (const value of setupVariables) testVariables.add(value);
      if (phase === "steps") for (const value of testVariables) cleanupVariables.add(value);
    }
  }
}

function validateSteps(steps: TestStep[], phase: string, plan: Record<string, unknown>, errors: string[], prefix: string, available: Set<string>): void {
  const fixtureNames = isObject(plan.fixtures) ? new Set(Object.keys(plan.fixtures)) : new Set<string>();
  for (const step of steps) {
    if (!isObject(step) || typeof step.action !== "string") { errors.push(prefix + ": invalid " + phase + " step"); continue; }
    const action = step.action;
    const rawStep = step as unknown as Record<string, unknown>;
    if ((FORBIDDEN_STEP_ACTIONS as readonly string[]).includes(action)) errors.push(prefix + ": forbidden action " + action);
    if (!isSupportedStepAction(action)) { errors.push(prefix + ": unsupported action " + action); continue; }
    for (const key of Object.keys(step)) if (FORBIDDEN_PROPERTY_PATTERN.test(key)) errors.push(prefix + ": forbidden step property " + key);
    if (action === "goto" || action === "expect_url") validateRelativePath(String(step.path || ""), prefix, errors);
    if (action === "api_request") {
      validateRelativePath(String(step.path || ""), prefix, errors);
      if (rawStep.save_as !== undefined && !validVariableName(rawStep.save_as)) errors.push(prefix + ": invalid response variable");
    }
    if (action === "set_variable" && !validVariableName(step.name)) errors.push(prefix + ": invalid variable name");
    if (["capture_text", "capture_attribute", "capture_json"].includes(action) && !validVariableName(rawStep.save_as)) errors.push(prefix + ": invalid capture variable");
    if ("locator" in step) validateLocator(step.locator, plan, errors, prefix);
    const references = extractVariableReferences(step);
    for (const reference of references) {
      if (reference.namespace === "env") errors.push(prefix + ": environment variables are not allowed");
      else if (reference.namespace === "fixtures" && !fixtureNames.has(reference.name)) errors.push(prefix + ": undefined fixture " + reference.name);
      else if (reference.namespace === "variables" && !available.has(reference.name)) errors.push(prefix + ": undefined variable " + reference.name);
      else if (reference.namespace === "responses" && !available.has(reference.name)) errors.push(prefix + ": undefined response " + reference.name);
      else if (!["fixtures", "variables", "responses"].includes(reference.namespace)) errors.push(prefix + ": invalid variable namespace " + reference.namespace);
    }
    if (action === "set_variable") available.add(String(step.name));
    if (action === "api_request" && rawStep.save_as) available.add(String(rawStep.save_as));
    if (["capture_text", "capture_attribute", "capture_json"].includes(action) && rawStep.save_as) available.add(String(rawStep.save_as));
  }
}

function validateLocator(locator: unknown, plan: Record<string, unknown>, errors: string[], prefix: string): void {
  if (!isObject(locator) || typeof locator.by !== "string") { errors.push(prefix + ": locator is invalid"); return; }
  if ((AUTOMATIC_LOCATOR_KINDS as readonly string[]).includes(locator.by)) {
    const value = locator.by === "role" ? locator.role : locator.by === "label" || locator.by === "text" ? locator.text : locator.value;
    if (typeof value !== "string" || !value) errors.push(prefix + ": locator value is required");
  } else if (locator.by === "css") {
    if (locator.authority !== "trusted_manual" || typeof locator.value !== "string" || !locator.value) errors.push(prefix + ": automatic CSS locator is not allowed");
  } else errors.push(prefix + ": CSS/XPath or unknown locator is not allowed");
  if (JSON.stringify(locator).match(HTTP_PATTERN)) errors.push(prefix + ": locator contains an unsafe URL");
  if (plan.origin && isObject(plan.origin) && plan.origin.type === "generated" && locator.by === "css") errors.push(prefix + ": generated plan cannot use CSS locator");
}

function validateRelativePath(value: string, prefix: string, errors: string[]): void {
  if (!value || HTTP_PATTERN.test(value) || value.includes("..") || !SAFE_PATH_PATTERN.test(value)) errors.push(prefix + ": unsafe URL/path");
}
function validVariableName(value: unknown): value is string { return typeof value === "string" && VARIABLE_NAME_PATTERN.test(value); }
function isObject(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function requireString(value: Record<string, any>, key: string, errors: string[], pattern: RegExp | undefined, label: string): void { if (typeof value[key] !== "string" || (pattern && !pattern.test(value[key]))) errors.push(label + " is invalid"); }
