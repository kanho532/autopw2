// M9.1 Declarative TestPlan contract acceptance verifier.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plan = await import(pathToFileURL(path.join(root, "packages/test-plan/dist/index.js")).href);
const { default: Ajv2020 } = await import("ajv/dist/2020.js");
const { default: addFormats } = await import("ajv-formats");
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const schemaValidator = ajv.compile(JSON.parse(fs.readFileSync(path.join(root, "packages/test-plan/schema/test-plan.schema.json"), "utf8")));
let passed = 0;
let failed = 0;
function check(name, condition, detail = "") { if (condition) { passed += 1; console.log("PASS  " + name + (detail ? " (" + detail + ")" : "")); } else { failed += 1; console.log("FAIL  " + name + (detail ? " (" + detail + ")" : "")); } }

const base = {
  plan_schema: "autopw.test-plan/1.0",
  plan_id: "contract_demo",
  generated_at: "2026-08-07T00:00:00.000Z",
  origin: { type: "manual", source_ref: "test" },
  coverage_eligible: true,
  fixtures: { taskA: { id: "task-1" } },
  cases: []
};
const uiCase = {
  case_id: "case_ui",
  title: "UI case",
  feature_id: "demo",
  requirement_refs: ["demo.visible"],
  scenario: "normal",
  priority: "P0",
  effective_tier: "fast",
  kind: "ui",
  risk: "read_only",
  confidence: 0.9,
  execution_policy: { production_allowed: false },
  steps: [
    { action: "goto", path: "/" },
    { action: "fill", locator: { by: "label", text: "Name" }, value: "AutoPW" },
    { action: "click", locator: { by: "role", role: "button", name: "Save" } },
    { action: "expect_visible", locator: { by: "test_id", value: "success" } }
  ]
};
const apiCase = {
  ...uiCase,
  case_id: "case_api",
  kind: "api",
  steps: [
    { action: "api_request", method: "POST", path: "/api/tasks", body: { title: "${fixtures.taskA.id}" }, save_as: "created" },
    { action: "expect_status", source: "${responses.created}", equals: 201 },
    { action: "expect_json", source: "${responses.created}", path: "body.id", exists: true }
  ]
};
const boundApiCase = {
  ...apiCase,
  case_id: "case_api_bound",
  oracle_bindings: [{ requirement_id: "demo.visible", step_refs: ["step_1", "step_2"] }]
};
const hybridCase = {
  ...uiCase,
  case_id: "case_hybrid",
  kind: "hybrid",
  setup: [{ action: "set_variable", name: "taskId", value: "task-1" }],
  steps: [{ action: "goto", path: "/tasks/${variables.taskId}" }, { action: "expect_text", locator: { by: "text", text: "Task" }, contains: "Task" }],
  cleanup: [{ action: "set_variable", name: "cleanupId", value: "${variables.taskId}" }]
};

const validUi = { ...base, cases: [uiCase] };
const validApi = { ...base, plan_id: "contract_api", cases: [apiCase] };
const validHybrid = { ...base, plan_id: "contract_hybrid", cases: [hybridCase] };
check("m9.1-valid-ui-plan", plan.validatePlan(validUi).ok);
check("m9.1-valid-api-plan", plan.validatePlan(validApi).ok);
check("m9.1-valid-hybrid-plan", plan.validatePlan(validHybrid).ok);
check("m9.1-schema-valid-ui-plan", schemaValidator(validUi));
check("m9.1-schema-valid-api-plan", schemaValidator(validApi));
check("m9.9-schema-valid-explicit-oracle-bindings", schemaValidator({ ...base, plan_id: "contract_oracle", cases: [boundApiCase] }));
check("m9.9-runtime-schema-parity-explicit-oracle-bindings", plan.validatePlan({ ...base, plan_id: "contract_oracle", cases: [boundApiCase] }).ok === schemaValidator({ ...base, plan_id: "contract_oracle", cases: [boundApiCase] }));
check("m9.1-schema-valid-hybrid-plan", schemaValidator(validHybrid));
const lifecycleStatusPlan = { ...base, plan_id: "contract_lifecycle_status", cases: [{ ...apiCase, setup: [{ action: "api_request", method: "POST", path: "/api/tasks", acceptable_statuses: [200, 201], save_as: "created" }] }] };
check("m9.1-lifecycle-status-contract-valid", plan.validatePlan(lifecycleStatusPlan).ok && schemaValidator(lifecycleStatusPlan));
check("m9.1-duplicate-case-id-rejected", !plan.validatePlan({ ...base, cases: [uiCase, uiCase] }).ok);
check("m9.1-forbidden-action-rejected", !plan.validatePlan({ ...base, cases: [{ ...uiCase, steps: [{ action: "execute_js", code: "alert(1)" }] }] }).ok);
check("m9.1-forbidden-property-rejected", !plan.validatePlan({ ...base, cases: [{ ...uiCase, steps: [{ action: "click", selector: "#save" }] }] }).ok);
check("m9.1-required-step-field-rejected", !plan.validatePlan({ ...base, cases: [{ ...uiCase, steps: [{ action: "click" }] }] }).ok && !schemaValidator({ ...base, cases: [{ ...uiCase, steps: [{ action: "click" }] }] }));
check("m9.1-undefined-variable-rejected", !plan.validatePlan({ ...base, cases: [{ ...uiCase, steps: [{ action: "fill", locator: { by: "id", value: "name" }, value: "${variables.missing}" }] }] }).ok);
check("m9.1-environment-variable-rejected", !plan.validatePlan({ ...base, cases: [{ ...uiCase, steps: [{ action: "fill", locator: { by: "id", value: "name" }, value: "${env.SECRET}" }] }] }).ok);
check("m9.1-unsafe-url-rejected", !plan.validatePlan({ ...base, cases: [{ ...uiCase, steps: [{ action: "goto", path: "https://evil.example" }] }] }).ok);
check("m9.1-automatic-css-rejected", !plan.validatePlan({ ...base, origin: { type: "generated" }, cases: [{ ...uiCase, steps: [{ action: "click", locator: { by: "css", value: "#save", authority: "trusted_manual" } }] }] }).ok);
check("m9.1-untrusted-manual-css-rejected", !plan.validatePlan({ ...base, cases: [{ ...uiCase, steps: [{ action: "click", locator: { by: "css", value: "#save", authority: "trusted_manual" } }] }] }).ok);
check("m9.1-trusted-manual-css-accepted", plan.validatePlan({ ...base, cases: [{ ...uiCase, steps: [{ action: "click", locator: { by: "css", value: "#save", authority: "trusted_manual" } }] }] }, { authority: "trusted_manual" }).ok);
const parityCases = [
  ["extra-top-level-field", { ...validUi, script: "dangerous" }],
  ["unsafe-parent-path", { ...base, cases: [{ ...uiCase, steps: [{ action: "goto", path: "/api/../../secret" }] }] }],
  ["invalid-target-path", { ...validUi, target: { base_path: "../outside" } }],
  ["invalid-origin-field", { ...validUi, origin: { type: "manual", legacy_case_id: "case_ui" } }],
  ["invalid-origin-field-type", { ...validUi, origin: { type: "manual", source_ref: 123, discovery_digest: false } }],
  ["invalid-locator-optional-types", { ...base, cases: [{ ...uiCase, steps: [{ action: "click", locator: { by: "role", role: "button", name: 123, exact: "yes" } }] }] }],
  ["invalid-timestamp", { ...validUi, generated_at: "not-a-date" }],
  ["generated-css-plan", { ...base, origin: { type: "generated" }, cases: [{ ...uiCase, steps: [{ action: "click", locator: { by: "css", value: "#save", authority: "trusted_manual" } }] }] }],
  ["generated-case-origin-override", { ...base, origin: { type: "generated" }, cases: [{ ...uiCase, origin: { type: "manual" }, steps: [{ action: "click", locator: { by: "css", value: "#save", authority: "trusted_manual" } }] }] }],
  ["generated-case-origin-override-without-css", { ...base, origin: { type: "generated" }, cases: [{ ...uiCase, origin: { type: "manual" } }] }],
  ["invalid-lifecycle-status-contract", { ...base, cases: [{ ...apiCase, setup: [{ action: "api_request", method: "POST", path: "/api/tasks", acceptable_statuses: [99, 201, 201] }] }] }]
];
for (const [name, candidate] of parityCases) check("m9.1-schema-runtime-parity-" + name, Boolean(schemaValidator(candidate)) === plan.validatePlan(candidate).ok);

const normalized = plan.normalizePlan({ ...base, cases: [apiCase, uiCase] });
const reversed = plan.normalizePlan({ ...base, cases: [uiCase, apiCase] });
check("m9.1-normalize-sorts-case-order", normalized.cases[0].case_id === "case_api" && normalized.cases[1].case_id === "case_ui");
check("m9.1-digest-is-key-order-independent", plan.planDigest(normalized) === plan.planDigest(reversed));
check("m9.1-loader-parses-json", plan.loadPlan(JSON.stringify(validUi)).cases[0].case_id === "case_ui");
const merged = plan.mergePlans({ ...base, plan_id: "auto", origin: { type: "generated" }, cases: [uiCase] }, { ...base, plan_id: "manual", cases: [{ ...uiCase, title: "manual override" }] }, "overlay");
check("m9.1-overlay-manual-case-wins", merged.cases.length === 1 && merged.cases[0].title === "manual override");
check("m9.1-overlay-origin-is-mixed", merged.origin.type === "mixed" && merged.cases[0].origin?.type === "manual");
const replaced = plan.mergePlans({ ...base, cases: [uiCase] }, { ...base, cases: [apiCase] }, "replace");
check("m9.1-replace-uses-explicit-plan", replaced.cases.length === 1 && replaced.cases[0].case_id === "case_api");
const manualCssPlan = { ...base, plan_id: "manual_css", origin: { type: "generated" }, cases: [{ ...uiCase, steps: [{ action: "click", locator: { by: "css", value: "#save", authority: "trusted_manual" } }] }] };
check("m9.1-untrusted-css-merge-rejected", (() => { try { plan.mergePlans({ ...base, origin: { type: "generated" }, cases: [uiCase] }, manualCssPlan, "overlay"); return false; } catch (error) { return error.code === "PLAN_INVALID"; } })());
const trustedCssMerge = plan.mergePlans({ ...base, origin: { type: "generated" }, cases: [uiCase] }, manualCssPlan, "overlay", { manualAuthority: { authority: "trusted_manual" } });
check("m9.1-trusted-css-merge-accepted", trustedCssMerge.origin.type === "mixed" && trustedCssMerge.cases[0].origin?.type === "manual");
const replacedGenerated = plan.mergePlans({ ...base, cases: [uiCase] }, { ...base, origin: { type: "generated" }, cases: [apiCase] }, "replace");
check("m9.1-replace-forces-manual-provenance", replacedGenerated.origin.type === "manual" && replacedGenerated.cases[0].origin?.type === "manual");
check("m9.1-malformed-merge-is-plan-invalid", (() => { try { plan.mergePlans({ ...base, cases: [uiCase] }, { cases: null }, "replace"); return false; } catch (error) { return error.code === "PLAN_INVALID"; } })());

const fixturePlan = { schema_version: "2.1", frozen_at: "2026-08-06T00:00:00.000Z", cases: [{ case_id: "fixture_case", feature_id: "demo", scenario: "normal", effective_tier: "fast", steps: [{ action: "goto", path: "/" }, { action: "click", selector: "#save" }, { action: "expect_visible", selector: "#success" }] }] };
const migrated = plan.fromFixturePlan(fixturePlan);
check("m9.1-fixture-plan-converts", plan.validatePlan(migrated, { authority: "migrated_fixture" }).ok && migrated.origin.type === "migrated" && migrated.cases.length === 1);
check("m9.1-fixture-css-is-explicitly-trusted", migrated.cases[0].steps.some((step) => step.action === "click" && step.locator.by === "css" && step.locator.authority === "trusted_manual"));
check("m9.1-schema-file-present", fs.existsSync(path.join(root, "packages/test-plan/schema/test-plan.schema.json")));

console.log(`\nM9.1 plan contract verify: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
