import { extractVariableReferences } from "./interpolation.js";
import { AUTOMATIC_LOCATOR_KINDS } from "./locator.js";
import { TEST_PLAN_SCHEMA, type TestCase, type TestPlan, type TestStep, type ValidationResult } from "./model.js";
import { FORBIDDEN_STEP_ACTIONS, isSupportedStepAction } from "./steps.js";

const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const SAFE_PATH_PATTERN = /^(?:\/|\.\/|[A-Za-z0-9_.-])[A-Za-z0-9_./?=&:%{}$-]*$/;
const HTTP_PATTERN = /^(?:https?:|javascript:|data:|file:|\\\\|\/\/)/i;
const FORBIDDEN_PROPERTY_PATTERN = /^(?:script|code|command|shell|execute|selector|xpath)$/i;
const SCENARIOS = ["normal", "required_field", "invalid_input", "empty_state", "boundary", "service_error", "network_failure", "not_found", "persistence", "cors"];
const ACTION_KEYS: Record<string, string[]> = {
  goto: ["action", "path"], reload: ["action"],
  fill: ["action", "locator", "value"], press: ["action", "locator", "key"],
  click: ["action", "locator"], select: ["action", "locator", "value"], check: ["action", "locator"], uncheck: ["action", "locator"],
  wait_for: ["action", "locator", "state", "timeout_ms"], api_request: ["action", "method", "path", "headers", "body", "save_as"],
  expect_visible: ["action", "locator"], expect_hidden: ["action", "locator"],
  expect_text: ["action", "locator", "equals", "contains"], expect_value: ["action", "locator", "equals"], expect_count: ["action", "locator", "equals"],
  expect_url: ["action", "path"], expect_checked: ["action", "locator", "checked"], expect_no_console_errors: ["action"],
  expect_status: ["action", "source", "equals"], expect_header: ["action", "source", "name", "equals", "contains"],
  expect_json: ["action", "source", "path", "equals", "exists"], expect_json_schema: ["action", "source", "schema"],
  set_variable: ["action", "name", "value"], capture_text: ["action", "locator", "save_as"],
  capture_attribute: ["action", "locator", "attribute", "save_as"], capture_json: ["action", "source", "path", "save_as"]
};

export function validatePlan(plan: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(plan)) return { ok: false, errors: ["plan must be an object"] };
  if (!onlyKeys(plan, ["plan_schema", "plan_id", "generated_at", "origin", "coverage_eligible", "target", "fixtures", "cases"])) errors.push("plan has unknown fields");
  if (plan.plan_schema !== TEST_PLAN_SCHEMA) errors.push("plan_schema must be " + TEST_PLAN_SCHEMA);
  requireString(plan, "plan_id", errors, ID_PATTERN, "plan_id");
  if (typeof plan.generated_at !== "string" || !isIsoDate(plan.generated_at)) errors.push("generated_at must be an ISO date-time");
  if (!isPlanOrigin(plan.origin)) errors.push("origin is invalid");
  if (typeof plan.coverage_eligible !== "boolean") errors.push("coverage_eligible must be boolean");
  if (plan.target !== undefined && (!isObject(plan.target) || !onlyKeys(plan.target, ["base_path"]))) errors.push("target is invalid");
  if (isObject(plan.target) && plan.target.base_path !== undefined) validateProjectPath(plan.target.base_path, errors);
  if (plan.fixtures !== undefined && !isObject(plan.fixtures)) errors.push("fixtures must be an object");
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
  const raw = item as unknown as Record<string, unknown>;
  const prefix = "case " + String(item.case_id || "<unknown>");
  if (!onlyKeys(raw, ["case_id", "origin", "title", "feature_id", "requirement_refs", "scenario", "priority", "effective_tier", "kind", "risk", "confidence", "execution_policy", "setup", "steps", "cleanup"])) errors.push(prefix + ": unknown case field");
  if (typeof item.case_id !== "string" || !ID_PATTERN.test(item.case_id)) errors.push(prefix + ": invalid case_id");
  else if (seen.has(item.case_id)) errors.push(prefix + ": duplicate case_id");
  else seen.add(item.case_id);
  if (item.origin !== undefined && !isCaseOrigin(item.origin)) errors.push(prefix + ": invalid origin");
  if (isObject(plan.origin) && plan.origin.type === "generated" && item.origin !== undefined && item.origin.type !== "generated") errors.push(prefix + ": generated plan cannot override case origin");
  for (const key of ["title", "feature_id"] as const) if (typeof item[key] !== "string" || !item[key]) errors.push(prefix + ": " + key + " is required");
  if (!Array.isArray(item.requirement_refs) || item.requirement_refs.length === 0 || item.requirement_refs.some((value) => typeof value !== "string" || !ID_PATTERN.test(value)) || new Set(item.requirement_refs).size !== item.requirement_refs.length) errors.push(prefix + ": invalid requirement_refs");
  if (!SCENARIOS.includes(item.scenario)) errors.push(prefix + ": invalid scenario");
  if (!["P0", "P1", "P2"].includes(item.priority) || !["smoke", "fast", "full"].includes(item.effective_tier) || !["ui", "api", "hybrid"].includes(item.kind) || !["read_only", "mutating", "destructive"].includes(item.risk)) errors.push(prefix + ": invalid case policy enum");
  if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) errors.push(prefix + ": confidence must be between 0 and 1");
  if (!isObject(item.execution_policy) || !onlyKeys(item.execution_policy, ["production_allowed", "isolated_fixture_required", "retries", "timeout_ms"]) || typeof item.execution_policy.production_allowed !== "boolean") errors.push(prefix + ": execution_policy is invalid");
  else {
    if (item.execution_policy.isolated_fixture_required !== undefined && typeof item.execution_policy.isolated_fixture_required !== "boolean") errors.push(prefix + ": isolated_fixture_required must be boolean");
    if (item.execution_policy.retries !== undefined && (!Number.isInteger(item.execution_policy.retries) || item.execution_policy.retries < 0)) errors.push(prefix + ": retries must be a non-negative integer");
    if (item.execution_policy.timeout_ms !== undefined && (!Number.isInteger(item.execution_policy.timeout_ms) || item.execution_policy.timeout_ms < 1)) errors.push(prefix + ": timeout_ms must be a positive integer");
  }
  const bindings = { variables: new Set<string>(), responses: new Set<string>(), fixtures: isObject(plan.fixtures) ? new Set(Object.keys(plan.fixtures)) : new Set<string>() };
  const scopedPlan = { ...plan, __case_origin: item.origin };
  for (const phase of ["setup", "steps", "cleanup"] as const) {
    if (phase === "steps" && (!Array.isArray(item.steps) || item.steps.length === 0)) errors.push(prefix + ": steps must be a non-empty array");
    if (item[phase] !== undefined && !Array.isArray(item[phase])) errors.push(prefix + ": " + phase + " must be an array");
    if (Array.isArray(item[phase])) validateSteps(item[phase], phase, scopedPlan, errors, prefix, bindings);
  }
}

function validateSteps(steps: TestStep[], phase: string, plan: Record<string, unknown>, errors: string[], prefix: string, bindings: { variables: Set<string>; responses: Set<string>; fixtures: Set<string> }): void {
  for (const step of steps) {
    if (!isObject(step) || typeof step.action !== "string") { errors.push(prefix + ": invalid " + phase + " step"); continue; }
    const action = step.action;
    const rawStep = step as unknown as Record<string, unknown>;
    if ((FORBIDDEN_STEP_ACTIONS as readonly string[]).includes(action)) errors.push(prefix + ": forbidden action " + action);
    if (!isSupportedStepAction(action)) { errors.push(prefix + ": unsupported action " + action); continue; }
    if (!onlyKeys(rawStep, ACTION_KEYS[action] || ["action"])) errors.push(prefix + ": unknown field in " + action + " step");
    for (const key of Object.keys(rawStep)) if (FORBIDDEN_PROPERTY_PATTERN.test(key)) errors.push(prefix + ": forbidden step property " + key);
    validateActionShape(action, rawStep, plan, errors, prefix);
    for (const reference of extractVariableReferences(step)) {
      if (!reference.namespace || !reference.name || reference.namespace === "env") errors.push(prefix + ": invalid or forbidden variable reference");
      else if (reference.namespace === "fixtures" && !bindings.fixtures.has(reference.name)) errors.push(prefix + ": undefined fixture " + reference.name);
      else if (reference.namespace === "variables" && !bindings.variables.has(reference.name)) errors.push(prefix + ": undefined variable " + reference.name);
      else if (reference.namespace === "responses" && !bindings.responses.has(reference.name)) errors.push(prefix + ": undefined response " + reference.name);
      else if (!["fixtures", "variables", "responses"].includes(reference.namespace)) errors.push(prefix + ": invalid variable namespace " + reference.namespace);
    }
    if (action === "set_variable" && validVariableName(rawStep.name)) bindings.variables.add(rawStep.name);
    if (action === "api_request" && validVariableName(rawStep.save_as)) bindings.responses.add(rawStep.save_as);
    if (["capture_text", "capture_attribute", "capture_json"].includes(action) && validVariableName(rawStep.save_as)) bindings.variables.add(rawStep.save_as);
  }
}

function validateActionShape(action: string, step: Record<string, unknown>, plan: Record<string, unknown>, errors: string[], prefix: string): void {
  const required = (key: string, type: "string" | "boolean" | "number" | "object" = "string", nonEmpty = true) => {
    if (step[key] === undefined || typeof step[key] !== type || (nonEmpty && type === "string" && !step[key])) errors.push(prefix + ": " + action + "." + key + " is required");
  };
  if (["goto", "expect_url"].includes(action)) { required("path"); validateRelativePath(String(step.path || ""), prefix, errors); }
  if (["click", "fill", "press", "select", "check", "uncheck", "expect_visible", "expect_hidden", "expect_text", "expect_value", "expect_count", "expect_checked", "capture_text", "capture_attribute"].includes(action)) { if (step.locator === undefined) errors.push(prefix + ": " + action + ".locator is required"); else validateLocator(step.locator, plan, errors, prefix); }
  if (action === "fill" || action === "select") required("value", "string", false);
  if (action === "press") required("key");
  if (action === "wait_for") { if (step.locator !== undefined) validateLocator(step.locator, plan, errors, prefix); if (step.state !== undefined && !["visible", "hidden", "attached"].includes(String(step.state))) errors.push(prefix + ": invalid wait state"); if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 1)) errors.push(prefix + ": invalid wait timeout"); }
  if (action === "api_request") { required("method"); required("path"); if (!["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(String(step.method))) errors.push(prefix + ": invalid HTTP method"); validateRelativePath(String(step.path || ""), prefix, errors); if (step.headers !== undefined && (!isObject(step.headers) || Object.values(step.headers).some((value) => typeof value !== "string"))) errors.push(prefix + ": headers must be string values"); if (step.save_as !== undefined && !validVariableName(step.save_as)) errors.push(prefix + ": invalid response variable"); }
  if (action === "expect_text") { if ((step.equals === undefined) === (step.contains === undefined) || (step.equals !== undefined && typeof step.equals !== "string") || (step.contains !== undefined && typeof step.contains !== "string")) errors.push(prefix + ": expect_text requires exactly one string oracle"); }
  if (action === "expect_value" && typeof step.equals !== "string") errors.push(prefix + ": expect_value.equals is required");
  if (action === "expect_count" && (!Number.isInteger(step.equals) || Number(step.equals) < 0)) errors.push(prefix + ": expect_count.equals must be a non-negative integer");
  if (action === "expect_checked" && typeof step.checked !== "boolean") errors.push(prefix + ": expect_checked.checked is required");
  if (action === "expect_status") { required("source"); if (!Number.isInteger(step.equals)) errors.push(prefix + ": expect_status.equals must be an integer"); }
  if (action === "expect_header") { required("source"); required("name"); if ((step.equals === undefined) === (step.contains === undefined) || (step.equals !== undefined && typeof step.equals !== "string") || (step.contains !== undefined && typeof step.contains !== "string")) errors.push(prefix + ": expect_header requires exactly one string oracle"); }
  if (action === "expect_json") { required("source"); required("path"); if (step.equals === undefined && typeof step.exists !== "boolean") errors.push(prefix + ": expect_json requires equals or exists"); if (step.equals !== undefined && step.exists !== undefined) errors.push(prefix + ": expect_json cannot combine equals and exists"); }
  if (action === "expect_json_schema") { required("source"); if (!isObject(step.schema) && !Array.isArray(step.schema)) errors.push(prefix + ": expect_json_schema.schema is required"); }
  if (action === "set_variable") { required("name"); if (!validVariableName(step.name)) errors.push(prefix + ": invalid variable name"); if (step.value === undefined) errors.push(prefix + ": set_variable.value is required"); }
  if (["capture_text", "capture_attribute"].includes(action)) { required("save_as"); if (!validVariableName(step.save_as)) errors.push(prefix + ": invalid capture variable"); if (action === "capture_attribute") required("attribute"); }
  if (action === "capture_json") { required("source"); required("save_as"); if (!validVariableName(step.save_as)) errors.push(prefix + ": invalid capture variable"); if (step.path !== undefined && typeof step.path !== "string") errors.push(prefix + ": capture_json.path must be a string"); }
}

function validateLocator(locator: unknown, plan: Record<string, unknown>, errors: string[], prefix: string): void {
  if (!isObject(locator) || typeof locator.by !== "string") { errors.push(prefix + ": locator is invalid"); return; }
  const allowed = locator.by === "role" ? ["by", "role", "name", "exact"] : locator.by === "label" || locator.by === "text" ? ["by", "text", "exact"] : ["by", "value"];
  if (locator.by === "css") allowed.push("authority");
  if (!onlyKeys(locator, allowed)) errors.push(prefix + ": locator has unknown fields");
  if (locator.by === "role" && locator.name !== undefined && typeof locator.name !== "string") errors.push(prefix + ": locator.name must be a string");
  if ((locator.by === "role" || locator.by === "label" || locator.by === "text") && locator.exact !== undefined && typeof locator.exact !== "boolean") errors.push(prefix + ": locator.exact must be a boolean");
  if ((AUTOMATIC_LOCATOR_KINDS as readonly string[]).includes(locator.by)) {
    const value = locator.by === "role" ? locator.role : locator.by === "label" || locator.by === "text" ? locator.text : locator.value;
    if (typeof value !== "string" || !value) errors.push(prefix + ": locator value is required");
  } else if (locator.by === "css") {
    if (locator.authority !== "trusted_manual" || typeof locator.value !== "string" || !locator.value) errors.push(prefix + ": automatic CSS locator is not allowed");
  } else errors.push(prefix + ": CSS/XPath or unknown locator is not allowed");
  if (JSON.stringify(locator).match(HTTP_PATTERN)) errors.push(prefix + ": locator contains an unsafe URL");
  const caseOrigin = isObject(plan.__case_origin) ? plan.__case_origin : plan.origin;
  if (caseOrigin && isObject(caseOrigin) && caseOrigin.type === "generated" && locator.by === "css") errors.push(prefix + ": generated plan cannot use CSS locator");
}

function validateRelativePath(value: string, prefix: string, errors: string[]): void { if (!isSafeRelativePath(value)) errors.push(prefix + ": unsafe URL/path"); }
function validateProjectPath(value: unknown, errors: string[]): void { if (typeof value !== "string" || !value || HTTP_PATTERN.test(value) || value.startsWith("/") || !/^(?:\.|[A-Za-z0-9_.-])[A-Za-z0-9_./-]*$/.test(value) || hasParentSegment(value)) errors.push("target.base_path is unsafe"); }
function isSafeRelativePath(value: string): boolean { return Boolean(value) && !HTTP_PATTERN.test(value) && SAFE_PATH_PATTERN.test(value) && !hasParentSegment(value); }
function hasParentSegment(value: string): boolean { return value.split("/").some((segment) => segment === ".."); }
function validVariableName(value: unknown): value is string { return typeof value === "string" && VARIABLE_NAME_PATTERN.test(value); }
function isIsoDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value)); }
function isPlanOrigin(value: unknown): boolean { return isObject(value) && ["generated", "manual", "migrated", "bootstrap", "mixed"].includes(String(value.type)) && onlyKeys(value, ["type", "source_ref", "generator_version", "discovery_digest", "requirement_digest"]) && optionalStrings(value, ["source_ref", "generator_version", "discovery_digest", "requirement_digest"]); }
function isCaseOrigin(value: unknown): boolean { return isObject(value) && ["generated", "manual", "migrated", "bootstrap"].includes(String(value.type)) && onlyKeys(value, ["type", "source_ref", "legacy_case_id"]) && optionalStrings(value, ["source_ref", "legacy_case_id"]); }
function optionalStrings(value: Record<string, unknown>, keys: string[]): boolean { return keys.every((key) => value[key] === undefined || typeof value[key] === "string"); }
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function isObject(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function requireString(value: Record<string, any>, key: string, errors: string[], pattern: RegExp | undefined, label: string): void { if (typeof value[key] !== "string" || (pattern && !pattern.test(value[key]))) errors.push(label + " is invalid"); }
