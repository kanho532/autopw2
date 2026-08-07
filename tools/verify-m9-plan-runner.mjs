// M9.3 Unified Plan Runner acceptance verifier.
import fs from "node:fs";
import http from "node:http";
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
  ] },
  { ...baseCase("redirect_case", "api"), steps: [
    { action: "api_request", method: "GET", path: "/api/redirect", save_as: "redirect" }
  ] },
  { ...baseCase("schema_case", "api"), steps: [
    { action: "api_request", method: "GET", path: "/api/items", save_as: "schema_items" },
    { action: "expect_json_schema", source: "$schema_items", schema: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^NOPE$", enum: ["NOPE"] } } } } }
  ] },
  { ...baseCase("timeout_case", "api"), execution_policy: { production_allowed: false, retries: 0, timeout_ms: 25 }, steps: [
    { action: "api_request", method: "GET", path: "/api/slow", save_as: "slow" }
  ] },
  { ...baseCase("timeout_cleanup_case", "api", "mutating"), execution_policy: { production_allowed: false, retries: 0, timeout_ms: 100 }, setup: [
    { action: "api_request", method: "POST", path: "/api/items", body: { name: "M9.3 timeout cleanup item" }, save_as: "created" }
  ], steps: [
    { action: "api_request", method: "GET", path: "/api/slow-long", save_as: "slow" }
  ], cleanup: [
    { action: "api_request", method: "DELETE", path: "/api/items/${responses.created.body.id}", save_as: "deleted" },
    { action: "expect_status", source: "$deleted", equals: 204 }
  ] },
  { ...baseCase("retry_flaky_case", "api"), execution_policy: { production_allowed: false, retries: 1 }, steps: [
    { action: "api_request", method: "GET", path: "/api/flaky", save_as: "flaky" },
    { action: "expect_status", source: "$flaky", equals: 200 }
  ] },
  { ...baseCase("cleanup_failure_case", "api"), steps: [
    { action: "api_request", method: "GET", path: "/health", save_as: "health" }
  ], cleanup: [
    { action: "expect_status", source: "$missing", equals: 200 }
  ] },
  { ...baseCase("raw_variable_case", "api"), setup: [
    { action: "set_variable", name: "token", value: "Bearer abcdef" }
  ], steps: [
    { action: "api_request", method: "GET", path: "/api/auth-check", headers: { Authorization: "${variables.token}" }, save_as: "auth" },
    { action: "expect_status", source: "$auth", equals: 200 }
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
  check("m9.3-api-redirect-rechecks-origin", byCase.get("redirect_case")?.status === "FAILED" && byCase.get("redirect_case")?.classification === "INFRA_DEFECT" && /origin is not allowed/i.test(byCase.get("redirect_case")?.error || ""));
  check("m9.3-json-schema-enforces-keywords", byCase.get("schema_case")?.status === "FAILED" && byCase.get("schema_case")?.classification === "PRODUCT_DEFECT" && /expect_json_schema/i.test(byCase.get("schema_case")?.error || ""));
  check("m9.3-case-timeout-is-enforced", byCase.get("timeout_case")?.status === "FAILED" && byCase.get("timeout_case")?.classification === "TEST_DEFECT");
  check("m9.3-timeout-still-runs-cleanup", byCase.get("timeout_cleanup_case")?.status === "FAILED" && byCase.get("timeout_cleanup_case")?.cleanup_status === "PASSED" && byCase.get("timeout_cleanup_case")?.path.some((step) => step.phase === "cleanup" && step.status === "PASSED"));
  check("m9.3-retry-flaky-is-recorded", byCase.get("retry_flaky_case")?.status === "PASSED" && byCase.get("retry_flaky_case")?.stability === "FLAKY" && byCase.get("retry_flaky_case")?.attempts.length === 2);
  check("m9.3-cleanup-failure-is-classified", byCase.get("cleanup_failure_case")?.status === "FAILED" && byCase.get("cleanup_failure_case")?.cleanup_status === "FAILED" && byCase.get("cleanup_failure_case")?.classification === "TEST_DEFECT" && byCase.get("cleanup_failure_case")?.path.some((step) => step.phase === "cleanup" && step.status === "FAILED"));
  check("m9.3-runtime-variable-keeps-secret", byCase.get("raw_variable_case")?.status === "PASSED");
  check("m9.3-trace-and-case-artifacts", ["ui_case", "hybrid_case"].every((caseId) => byCase.get(caseId)?.evidence_refs.some((ref) => ref.kind === "playwright-trace") && fs.existsSync(path.join(dataRoot, "runs", "run_m9_3", "cases", caseId, "case.json"))));
  check("m9.3-api-evidence-is-case-scoped", byCase.get("hybrid_case")?.evidence_refs.length >= 3 && fs.existsSync(path.join(dataRoot, "runs", "run_m9_3", "cases", "hybrid_case", "artifacts")));

  const tierCases = [
    { ...baseCase("tier_smoke", "api"), effective_tier: "smoke", steps: [{ action: "api_request", method: "GET", path: "/health", save_as: "smoke" }] },
    { ...baseCase("tier_fast", "api"), effective_tier: "fast", steps: [{ action: "api_request", method: "GET", path: "/health", save_as: "fast" }] },
    { ...baseCase("tier_full", "api"), effective_tier: "full", steps: [{ action: "api_request", method: "GET", path: "/health", save_as: "full" }] }
  ];
  const tierOutcome = await new execution.PlaywrightPlanRunner().run({ runId: "run_m9_3_tier", baseUrl: target.baseUrl, plan: plan(tierCases), tier: "fast", storage: new storageModule.RunStorage(dataRoot), allowedOrigins: [target.baseUrl], planAuthority: "trusted_manual", trace: false });
  check("m9.3-tier-filtering", tierOutcome.results.length === 2 && tierOutcome.results.every((item) => item.case_id !== "tier_full") && tierOutcome.manifest.instances.length === 2);

  const productionOutcome = await new execution.PlaywrightPlanRunner().run({ runId: "run_m9_3_production", baseUrl: target.baseUrl, plan: plan([{ ...baseCase("production_mutation", "api", "mutating"), steps: [{ action: "api_request", method: "POST", path: "/api/items", body: { name: "forbidden" }, save_as: "created" }] }]), production: true, storage: new storageModule.RunStorage(dataRoot), allowedOrigins: [target.baseUrl], planAuthority: "trusted_manual", trace: false });
  check("m9.3-production-mutation-is-blocked", productionOutcome.results[0]?.status === "FAILED" && productionOutcome.results[0]?.classification === "TEST_DEFECT" && productionOutcome.results[0]?.cleanup_status === "SKIPPED");

  const redirectServer = http.createServer((request, response) => {
    if (request.url === "/redirect-to-target") { response.writeHead(302, { Location: target.baseUrl + "/api/auth-check" }); response.end(); return; }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve, reject) => { redirectServer.once("error", reject); redirectServer.listen(0, "127.0.0.1", resolve); });
  const redirectAddress = redirectServer.address();
  if (!redirectAddress || typeof redirectAddress === "string") throw new Error("redirect verifier did not expose a TCP port");
  const redirectBaseUrl = "http://127.0.0.1:" + redirectAddress.port;
  try {
    const headerOutcome = await new execution.PlaywrightPlanRunner().run({ runId: "run_m9_3_redirect_headers", baseUrl: redirectBaseUrl, plan: plan([{ ...baseCase("cross_origin_header_case", "api"), steps: [
      { action: "api_request", method: "GET", path: "/redirect-to-target", headers: { Authorization: "Bearer abcdef", Cookie: "session=secret" }, save_as: "redirected" },
      { action: "expect_status", source: "$redirected", equals: 401 }
    ] }]), storage: new storageModule.RunStorage(dataRoot), allowedOrigins: [redirectBaseUrl, target.baseUrl], planAuthority: "trusted_manual", trace: false });
    check("m9.3-cross-origin-redirect-strips-credentials", headerOutcome.results[0]?.status === "PASSED");
  } finally { await new Promise((resolve, reject) => redirectServer.close((error) => error ? reject(error) : resolve())); }

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
