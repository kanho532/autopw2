import type { TestStep } from "./model.js";

export const SUPPORTED_STEP_ACTIONS = [
  "goto", "reload", "fill", "click", "select", "check", "uncheck", "press", "wait_for", "api_request",
  "expect_visible", "expect_hidden", "expect_text", "expect_value", "expect_count", "expect_url", "expect_checked", "expect_no_console_errors",
  "expect_status", "expect_header", "expect_json", "expect_json_schema", "expect_relation", "expect_collection", "set_variable", "capture_text", "capture_attribute", "capture_json"
] as const;

export const FORBIDDEN_STEP_ACTIONS = ["evaluate", "execute_js", "shell", "node", "require", "import", "child_process"] as const;
export type SupportedStepAction = typeof SUPPORTED_STEP_ACTIONS[number];

export function isSupportedStepAction(value: unknown): value is SupportedStepAction {
  return typeof value === "string" && (SUPPORTED_STEP_ACTIONS as readonly string[]).includes(value);
}

export function stepAction(step: TestStep): string { return step.action; }
