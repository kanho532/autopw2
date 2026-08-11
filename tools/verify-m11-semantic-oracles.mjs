import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const load = async (relative) => import(pathToFileURL(path.join(root, relative)).href);
const testPlan = await load("packages/test-plan/dist/index.js");
const compiler = await load("packages/compiler/dist/index.js");
const execution = await load("packages/execution/dist/index.js");
const storageModule = await load("packages/run-storage/dist/index.js");
let passed = 0; let failed = 0;
function check(name, value, detail = "") { if (value) { passed += 1; console.log("PASS", name, detail); } else { failed += 1; console.log("FAIL", name, detail); } }

const baseCase = (steps) => ({ case_id: "case_semantic", title: "semantic", feature_id: "items", requirement_refs: ["req_semantic"], scenario: "normal", priority: "P0", effective_tier: "smoke", kind: "api", risk: "read_only", confidence: 1, execution_policy: { production_allowed: true }, steps });
const basePlan = (schema, steps) => ({ plan_schema: schema, plan_id: "semantic_plan", generated_at: "2026-08-11T00:00:00.000Z", origin: { type: "generated" }, coverage_eligible: true, cases: [baseCase(steps)] });
const semanticSteps = [
  { action: "api_request", method: "GET", path: "/items", save_as: "items" },
  { action: "api_request", method: "GET", path: "/count", save_as: "count" },
  { action: "expect_collection", source: "responses.items", quantifier: "every", predicate: { path: "name", operator: "contains", value: "AutoPW" } },
  { action: "expect_relation", left: { source: "responses.count", path: "count" }, operator: "equals", right: { source: "responses.items", aggregate: "length" } }
];
check("m11.5-testplan-1.0-remains-readable", testPlan.validatePlan(basePlan("autopw.test-plan/1.0", [{ action: "api_request", method: "GET", path: "/items", save_as: "items" }, { action: "expect_status", source: "responses.items", equals: 200 }]), { authority: "generated" }).ok);
check("m11.5-semantic-steps-require-1.1", !testPlan.validatePlan(basePlan("autopw.test-plan/1.0", semanticSteps), { authority: "generated" }).ok);
check("m11.5-testplan-1.1-validates-safe-semantic-steps", testPlan.validatePlan(basePlan("autopw.test-plan/1.1", semanticSteps), { authority: "generated" }).ok);
check("m11.5-javascript-evaluation-remains-unsupported", !testPlan.validatePlan(basePlan("autopw.test-plan/1.1", [{ action: "evaluate", code: "1+1" }]), { authority: "generated" }).ok);

const catalogFor = (caseId, actionStep) => ({ routes: {}, locators: {}, inputs: {}, fixtures: {}, extractors: {}, cleanup_actions: {}, endpoints: {}, actions: { action: { id: "action", kind: "action", case_id: caseId, scenario: "normal", step: actionStep } }, expectations: { expectation: { id: "expectation", kind: "expectation", case_id: caseId, scenario: "normal", strength: "strong", step: { action: "expect_status", source: actionStep.save_as, equals: 200 } } } });
const outputFor = (caseId) => ({ caseSelections: [{ caseId, actionSelections: [{ actionTemplateId: "action" }], expectationIds: ["expectation"] }] });
const requirement = (overrides) => ({ requirement_id: "req_count", feature_id: "items", intent: "count_consistent", scenario: "normal", priority: "P0", risk: "read_only", confidence: 1, status: "REQUIRED", oracle: { kind: "json", assertion: "count matches collection", details: { status: 200, collection_path: "/items" } }, oracle_specification: { kind: "relation", assertion: "count matches collection", proven: true }, ...overrides });
const caseId = "case_req_count";
const countCatalog = catalogFor(caseId, { action: "api_request", method: "GET", path: "/count", save_as: "response_req_count" });
const compiled = compiler.compileTestPlan({ requirements: [requirement({})], candidateCatalog: countCatalog, plannerOutput: outputFor(caseId) });
check("m11.5-compiler-writes-1.1-only-for-semantic-oracles", compiled.plan.plan_schema === "autopw.test-plan/1.1" && compiled.plan.cases[0].steps.some((step) => step.action === "expect_relation"));
check("m11.5-complete-semantic-oracle-earns-coverage", compiled.plan.coverage_eligible && compiled.mappingAudit.match === "COMPLETE" && compiled.mappingAudit.requirement_oracle_map.req_count?.some((ref) => ref.includes("step_")));
const semanticFixtures = { kind: "resource_crud", proven: true, payload: { name: "AutoPW" }, create: { operation_id: "create", method: "POST", path: "/items" }, read: { operation_id: "read", method: "GET", path: "/items/:itemId" }, update: { operation_id: "update", method: "PATCH", path: "/items/:itemId" }, cleanup: { operation_id: "delete", method: "DELETE", path: "/items/:itemId" }, identity: { kind: "response_body", path: "id", proven: true } };
const semanticCases = [
  ["create_succeeds", "POST", "/items", "expect_relation"],
  ["update_persists", "PATCH", "/items/item-1", "expect_relation"],
  ["summary_is_consistent", "GET", "/items/summary", "expect_relation"],
  ["count_consistent", "GET", "/count", "expect_relation"],
  ["search_filters_results", "GET", "/items?q=AutoPW", "expect_collection"]
];
const compiledSemanticIntents = semanticCases.every(([intent, method, requestPath, expectedAction]) => {
  const requirementId = `req_${intent}`;
  const intentCaseId = `case_${requirementId}`;
  const actionStep = { action: "api_request", method, path: requestPath, save_as: `response_${requirementId}` };
  const intentCatalog = catalogFor(intentCaseId, actionStep);
  const intentRequirement = requirement({ requirement_id: requirementId, intent, fixture_strategy: semanticFixtures, payload_strategy: { valid_payload: { name: "AutoPW" } }, oracle: { kind: "semantic", assertion: intent, details: { status: method === "POST" ? 201 : 200, collection_path: "/items" } }, oracle_specification: { kind: "semantic", assertion: intent, proven: true } });
  const result = compiler.compileTestPlan({ requirements: [intentRequirement], candidateCatalog: intentCatalog, plannerOutput: outputFor(intentCaseId) });
  return result.plan.plan_schema === "autopw.test-plan/1.1" && result.plan.coverage_eligible && result.plan.cases[0].steps.some((step) => step.action === expectedAction);
});
check("m11.5-refresh-persistence-summary-count-search-compile-semantically", compiledSemanticIntents);
const incomplete = compiler.compileTestPlan({ requirements: [requirement({ oracle_specification: { kind: "relation", assertion: "count matches collection", proven: false } })], candidateCatalog: countCatalog, plannerOutput: outputFor(caseId) });
check("m11.5-incomplete-oracle-does-not-earn-coverage", incomplete.plan.plan_schema === "autopw.test-plan/1.0" && !incomplete.plan.coverage_eligible && !incomplete.mappingAudit.requirement_oracle_map.req_count);
const readRequirement = { ...requirement({}), requirement_id: "req_read", intent: "route_loads", oracle_specification: { kind: "http", assertion: "loads", proven: true } };
const readCase = "case_req_read";
const readCatalog = catalogFor(readCase, { action: "api_request", method: "GET", path: "/items", save_as: "response_req_read" });
const readCompiled = compiler.compileTestPlan({ requirements: [readRequirement], candidateCatalog: readCatalog, plannerOutput: outputFor(readCase) });
check("m11.5-compiler-keeps-status-only-plans-on-1.0", readCompiled.plan.plan_schema === "autopw.test-plan/1.0");

const server = http.createServer((request, response) => { response.setHeader("content-type", "application/json"); if (request.url === "/items") response.end(JSON.stringify([{ name: "AutoPW one" }, { name: "AutoPW two" }])); else if (request.url === "/count") response.end(JSON.stringify({ count: 2 })); else { response.statusCode = 404; response.end(JSON.stringify({ error: "missing" })); } });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m11-semantic-run-"));
try {
  const outcome = await new execution.PlaywrightPlanRunner().run({ runId: "run_m11_semantic", baseUrl: `http://127.0.0.1:${address.port}`, plan: basePlan("autopw.test-plan/1.1", semanticSteps), planAuthority: "generated", allowedOrigins: [`http://127.0.0.1:${address.port}`], storage: new storageModule.RunStorage(dataRoot) });
  check("m11.5-runner-evaluates-relations-and-collections", outcome.results.length === 1 && outcome.results[0].status === "PASSED");
} finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dataRoot, { recursive: true, force: true }); }

console.log(`\nM11 phase 5 semantic oracle verification: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
