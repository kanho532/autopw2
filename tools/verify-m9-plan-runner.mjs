// M9.3 Unified Plan Runner acceptance verifier.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const execution = await import(pathToFileURL(path.join(root, "packages", "execution", "dist", "index.js")).href);
const fixture = await import(pathToFileURL(path.join(root, "packages", "execution-fixture", "dist", "index.js")).href);
const storageModule = await import(pathToFileURL(path.join(root, "packages", "run-storage", "dist", "index.js")).href);
const testPlan = await import(pathToFileURL(path.join(root, "packages", "test-plan", "dist", "index.js")).href);

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") { if (condition) { passed += 1; console.log("PASS", name, detail ? "(" + detail + ")" : ""); } else { failed += 1; console.log("FAIL", name, detail); } }
function baseCase(case_id, kind, risk = "read_only") {
  return { case_id, title: case_id, feature_id: "m9.3", requirement_refs: ["req_" + case_id], scenario: "normal", priority: "P0", effective_tier: "fast", kind, risk, confidence: 1, execution_policy: { production_allowed: false, retries: 0 } };
}
function plan(cases) {
  return { plan_schema: "autopw.test-plan/1.0", plan_id: "m9.3-runner", generated_at: "2026-08-07T00:00:00.000Z", origin: { type: "manual", source_ref: "verify:m9.3" }, coverage_eligible: true, cases };
}

const cases = [
  { ...baseCase("ui_case", "ui"), steps: [
    { action: "goto", path: "/" },
    { action: "fill", locator: { by: "id", value: "name" }, value: "AutoPW M9.3" },
    { action: "click", locator: { by: "role", role: "button", name: "Submit" } },
    { action: "expect_visible", locator: { by: "id", value: "success" } }
  ] },
  { ...baseCase("api_case", "api"), steps: [
    { action: "api_request", method: "GET", path: "/api/items", save_as: "items" },
    { action: "expect_status", source: "$items", equals: 200 },
    { action: "expect_json", source: "$items", path: "0.id", exists: true }
  ] },
  { ...baseCase("hybrid_case", "hybrid", "mutating"), setup: [
    { action: "api_request", method: "POST", path: "/api/items", body: { name: "M9.3 hybrid item" }, save_as: "created" }
  ], steps: [
    { action: "goto", path: "/" },
    { action: "expect_text", locator: { by: "text", text: "M9.3 hybrid item" }, contains: "M9.3 hybrid item" },
    { action: "api_request", method: "PATCH", path: "/api/items/${responses.created.body.id}", body: { completed: true }, save_as: "updated" },
    { action: "expect_status", source: "${responses.updated}", equals: 200 }
  ], cleanup: [
    { action: "api_request", method: "DELETE", path: "/api/items/${responses.created.body.id}", save_as: "deleted" },
    { action: "expect_status", source: "$deleted", equals: 204 }
  ] },
  { ...baseCase("cleanup_case", "api", "mutating"), setup: [
    { action: "api_request", method: "POST", path: "/api/items", body: { name: "M9.3 cleanup item" }, save_as: "created" }
  ], steps: [
    { action: "expect_text", locator: { by: "text", text: "this text does not exist" }, contains: "this text does not exist" }
  ], cleanup: [
    { action: "api_request", method: "DELETE", path: "/api/items/${responses.created.body.id}", save_as: "deleted" },
    { action: "expect_status", source: "$deleted", equals: 204 }
  ] }
];

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m9.3-runner-"));
const target = await fixture.startDemoTarget("pass");
try {
  const runner = new execution.PlaywrightPlanRunner();
  const outcome = await runner.run({ runId: "run_m9_3", baseUrl: target.baseUrl, plan: plan(cases), storage: new storageModule.RunStorage(dataRoot), allowedOrigins: [target.baseUrl], planAuthority: "trusted_manual", trace: true });
  const byCase = new Map(outcome.results.map((item) => [item.case_id, item]));
  check("m9.3-ui-case-passed", byCase.get("ui_case")?.status === "PASSED");
  check("m9.3-api-case-passed", byCase.get("api_case")?.status === "PASSED" && byCase.get("api_case")?.path.some((step) => step.endpoint_ref));
  check("m9.3-hybrid-case-passed", byCase.get("hybrid_case")?.status === "PASSED" && byCase.get("hybrid_case")?.cleanup_status === "PASSED", JSON.stringify({ status: byCase.get("hybrid_case")?.status, cleanup_status: byCase.get("hybrid_case")?.cleanup_status, error: byCase.get("hybrid_case")?.error }));
  check("m9.3-cleanup-runs-after-test-failure", byCase.get("cleanup_case")?.status === "FAILED" && byCase.get("cleanup_case")?.cleanup_status === "PASSED" && byCase.get("cleanup_case")?.path.some((step) => step.phase === "cleanup"));
  check("m9.3-trace-and-case-artifacts", ["ui_case", "hybrid_case"].every((caseId) => byCase.get(caseId)?.evidence_refs.some((ref) => ref.kind === "playwright-trace") && fs.existsSync(path.join(dataRoot, "runs", "run_m9_3", "cases", caseId, "case.json"))));
  check("m9.3-api-evidence-is-case-scoped", byCase.get("hybrid_case")?.evidence_refs.length >= 3 && fs.existsSync(path.join(dataRoot, "runs", "run_m9_3", "cases", "hybrid_case", "artifacts")));

  const fixtureTarget = await fixture.startDemoTarget("pass");
  try {
    const fixtureRun = await new execution.PlaywrightFixtureRunner().run({ runId: "run_fixture_compat", baseUrl: fixtureTarget.baseUrl, plan: fixture.FIXTURE_PLAN, variant: "pass", storage: new storageModule.RunStorage(dataRoot), allowedOrigins: [fixtureTarget.baseUrl] });
    check("m9.3-m2-fixture-compatibility", fixtureRun.results.length === 3 && fixtureRun.results.every((item) => item.status === "PASSED"));
  } finally { await fixtureTarget.close(); }
} finally {
  await target.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

let rejectedVariable = false;
try {
  testPlan.assertValidPlan(plan([{ ...baseCase("bad_variable", "api"), steps: [{ action: "api_request", method: "GET", path: "/api/items/${variables.missing}", save_as: "items" }] }]), { authority: "trusted_manual" });
} catch (error) { rejectedVariable = error?.code === "PLAN_INVALID"; }
check("m9.3-undefined-variable-is-test-defect", rejectedVariable);

console.log(`\nM9.3 verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
