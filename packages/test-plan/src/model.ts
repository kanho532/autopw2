export const TEST_PLAN_SCHEMA = "autopw.test-plan/1.0" as const;

export type PlanOriginType = "generated" | "manual" | "migrated" | "bootstrap";
export type Scenario = "normal" | "required_field" | "invalid_input" | "empty_state" | "boundary" | "service_error" | "network_failure" | "not_found" | "persistence" | "cors";
export type Priority = "P0" | "P1" | "P2";
export type EffectiveTier = "smoke" | "fast" | "full";
export type TestKind = "ui" | "api" | "hybrid";
export type TestRisk = "read_only" | "mutating" | "destructive";

export interface PlanOrigin {
  type: PlanOriginType;
  source_ref?: string;
  generator_version?: string;
  discovery_digest?: string;
  requirement_digest?: string;
}

export interface CaseOrigin {
  type: PlanOriginType;
  source_ref?: string;
  legacy_case_id?: string;
}

export type LocatorRef =
  | { by: "role"; role: string; name?: string; exact?: boolean }
  | { by: "label"; text: string }
  | { by: "test_id"; value: string }
  | { by: "text"; text: string; exact?: boolean }
  | { by: "id"; value: string }
  | { by: "css"; value: string; authority: "trusted_manual" };

export interface GotoStep { action: "goto"; path: string; }
export interface ReloadStep { action: "reload"; }
export interface LocatorActionStep { action: "click" | "select" | "check" | "uncheck"; locator: LocatorRef; value?: string; }
export interface FillStep { action: "fill"; locator: LocatorRef; value: string; }
export interface PressStep { action: "press"; locator: LocatorRef; key: string; }
export interface WaitForStep { action: "wait_for"; locator?: LocatorRef; state?: "visible" | "hidden" | "attached"; timeout_ms?: number; }
export interface ApiRequestStep { action: "api_request"; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; path: string; headers?: Record<string, string>; body?: unknown; save_as?: string; }
export interface ExpectVisibleStep { action: "expect_visible" | "expect_hidden"; locator: LocatorRef; }
export interface ExpectTextStep { action: "expect_text"; locator: LocatorRef; equals?: string; contains?: string; }
export interface ExpectValueStep { action: "expect_value"; locator: LocatorRef; equals: string; }
export interface ExpectCountStep { action: "expect_count"; locator: LocatorRef; equals: number; }
export interface ExpectUrlStep { action: "expect_url"; path: string; }
export interface ExpectCheckedStep { action: "expect_checked"; locator: LocatorRef; checked: boolean; }
export interface ExpectNoConsoleErrorsStep { action: "expect_no_console_errors"; }
export interface ExpectStatusStep { action: "expect_status"; source: string; equals: number; }
export interface ExpectHeaderStep { action: "expect_header"; source: string; name: string; equals?: string; contains?: string; }
export interface ExpectJsonStep { action: "expect_json"; source: string; path: string; equals?: unknown; exists?: boolean; }
export interface ExpectJsonSchemaStep { action: "expect_json_schema"; source: string; schema: unknown; }
export interface SetVariableStep { action: "set_variable"; name: string; value: unknown; }
export interface CaptureTextStep { action: "capture_text"; locator: LocatorRef; save_as: string; }
export interface CaptureAttributeStep { action: "capture_attribute"; locator: LocatorRef; attribute: string; save_as: string; }
export interface CaptureJsonStep { action: "capture_json"; source: string; path?: string; save_as: string; }

export type TestStep = GotoStep | ReloadStep | LocatorActionStep | FillStep | PressStep | WaitForStep | ApiRequestStep | ExpectVisibleStep | ExpectTextStep | ExpectValueStep | ExpectCountStep | ExpectUrlStep | ExpectCheckedStep | ExpectNoConsoleErrorsStep | ExpectStatusStep | ExpectHeaderStep | ExpectJsonStep | ExpectJsonSchemaStep | SetVariableStep | CaptureTextStep | CaptureAttributeStep | CaptureJsonStep;

export type FixtureDefinition = Record<string, unknown>;

export interface TestCase {
  case_id: string;
  origin?: CaseOrigin;
  title: string;
  feature_id: string;
  requirement_refs: string[];
  scenario: Scenario;
  priority: Priority;
  effective_tier: EffectiveTier;
  kind: TestKind;
  risk: TestRisk;
  confidence: number;
  execution_policy: {
    production_allowed: boolean;
    isolated_fixture_required?: boolean;
    retries?: number;
    timeout_ms?: number;
  };
  setup?: TestStep[];
  steps: TestStep[];
  cleanup?: TestStep[];
}

export interface TestPlan {
  plan_schema: typeof TEST_PLAN_SCHEMA;
  plan_id: string;
  generated_at: string;
  origin: PlanOrigin;
  coverage_eligible: boolean;
  target?: { base_path?: string };
  fixtures?: Record<string, FixtureDefinition>;
  cases: TestCase[];
}

export interface ValidationResult { ok: boolean; errors: string[]; }
