import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const load = async (relative) => import(pathToFileURL(path.join(root, relative)).href);
const core = await load("packages/core/dist/index.js");
const execution = await load("packages/execution/dist/index.js");
const mcp = await load("packages/mcp-server/dist/index.js");
const planner = await load("packages/planner/dist/index.js");
const security = await load("packages/security/dist/index.js");
const storageModule = await load("packages/run-storage/dist/index.js");
const testPlan = await load("packages/test-plan/dist/index.js");
const todo = await load("apps/todo-fixture-target/dist/index.js");

let passed = 0;
let failed = 0;
function check(name, value, detail = "") { if (value) { passed += 1; console.log("PASS", name, detail); } else { failed += 1; console.log("FAIL", name, detail); } }
function snapshot(runId) { return { run_id: runId, operation_id: "op_" + runId, workspace_id: "m10", phase: "CREATED", run_status: "ACTIVE", audit_status: null, gate: null, fatal_class: null, progress_pct: 0, next_action: "run" }; }
function request(targetUrl) { return { project_subpath: ".", profile_path: "profiles/default/profile.json", tier: "full", base_tier: "full", __target_url: targetUrl, __allowed_origins: [new URL(targetUrl).origin], __trust_snapshot: { allowed_origins: [new URL(targetUrl).origin], workspace_id: "m10", workspace_root: root }, matrix: { browsers: ["chromium"], viewports: [{ width: 1280, height: 720 }], locales: ["en-US"], auth_scope_ids: ["as_demo"] } }; }
function phaseList(dataRoot, runId) { return fs.readFileSync(path.join(dataRoot, "runs", runId, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.kind === "PHASE_COMMITTED").map((event) => event.phase); }
function rejects(fn, code) { try { fn(); return false; } catch (error) { return !code || error?.code === code; } }
async function waitForMcpResult(server, runId) { for (let attempt = 0; attempt < 120; attempt += 1) { const result = await server.callTool("get_run_result", { schema_version: "2.1", workspace_id: "ws_m10", run_id: runId }); if (result.kind === "ok" || result.kind === "failed" || result.kind === "error") return result; await new Promise((resolve) => setTimeout(resolve, 100)); } return server.callTool("get_run_result", { schema_version: "2.1", workspace_id: "ws_m10", run_id: runId }); }

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m10-"));
const target = await todo.startTodoTarget();
try {
  check("m10-default-engine-is-declarative-structured", core.DEFAULT_ENGINE_MODES.plan_engine === "declarative" && core.DEFAULT_ENGINE_MODES.discovery_engine === "structured");
  const targetRoot = path.join(root, "apps", "todo-fixture-target");
  const runtime = new core.AuditVerticalSlice({ root: targetRoot, dataRoot, targetProvider: new core.ExternalTargetProvider(target.baseUrl) });
  const first = await runtime.execute({ run: snapshot("run_m10_default_a"), request: request(target.baseUrl), onPhase: () => undefined });
  target.reset();
  const second = await runtime.execute({ run: snapshot("run_m10_default_b"), request: request(target.baseUrl), onPhase: () => undefined });
  const firstPlan = testPlan.loadPlanFile(path.join(dataRoot, "runs", "run_m10_default_a", "plan.json"), { authority: "generated" });
  const secondPlan = testPlan.loadPlanFile(path.join(dataRoot, "runs", "run_m10_default_b", "plan.json"), { authority: "generated" });
  const metrics = JSON.parse(fs.readFileSync(path.join(dataRoot, "runs", "run_m10_default_a", "release-metrics.json"), "utf8"));
  const cachedMetrics = JSON.parse(fs.readFileSync(path.join(dataRoot, "runs", "run_m10_default_b", "release-metrics.json"), "utf8"));
  const discovery = JSON.parse(fs.readFileSync(path.join(dataRoot, "runs", "run_m10_default_a", "discovery.json"), "utf8"));
  const expectedPhases = "TARGET_READY,SEED_RESOLVED,DISCOVERED,COVERAGE_DERIVED,PLAN_FILLED,PLAN_FROZEN,SUITE_GENERATED,SUITE_FROZEN,RUNNING,EXECUTION_FINISHED,RUNTIME_FINALIZED,AUDITED,REPORTED,GATED";
  check("m10-default-declarative-full-run-passes", first.gate === "pass" && first.audit_status === "COMPLETE" && first.cases.length > 0, JSON.stringify({ gate: first.gate, cases: first.cases.length }));
  check("m10-default-run-persists-complete-release-metrics", ["static_discovery_wall_ms", "live_discovery_wall_ms", "correlation_cpu_ms"].every((key) => Object.hasOwn(discovery.metrics || {}, key)) && ["static_discovery_wall_ms", "live_discovery_wall_ms", "correlation_cpu_ms", "derivation_cpu_ms", "planner_fill_ms", "compilation_ms", "execution_ms", "report_ms", "total_run_ms"].every((key) => Number.isFinite(metrics[key]) && metrics[key] >= 0), JSON.stringify(metrics));
  check("m10-planner-cache-hit-is-recorded-separately", cachedMetrics.plan_cache_hit === true && Number.isFinite(cachedMetrics.planner_fill_ms));
  check("m10-default-run-keeps-frozen-phase-order", phaseList(dataRoot, "run_m10_default_a").join(",") === expectedPhases);
  check("m10-plan-and-execution-identifiers-are-deterministic", testPlan.planDigest(firstPlan) === testPlan.planDigest(secondPlan) && first.cases.map((item) => item.execution_id).join(",") === second.cases.map((item) => item.execution_id).join(","));
  check("m10-artifacts-and-reports-are-restart-readable", fs.existsSync(path.join(dataRoot, "runs", "run_m10_default_a", "artifact-index.json")) && fs.existsSync(path.join(dataRoot, "runs", "run_m10_default_a", "artifacts", "report.md")) && fs.existsSync(path.join(dataRoot, "runs", "run_m10_default_a", "artifacts", "report.html")));

  target.reset();
  const mcpDataRoot = path.join(dataRoot, "mcp-default");
  const mcpServer = new mcp.McpServer({ root, dataRoot: mcpDataRoot, stepMs: 2, targetProvider: new core.ExternalTargetProvider(target.baseUrl) });
  mcpServer.registerHostContext("ws_m10", { mcp_host_context: { workspace_authorization: { workspace_id: "ws_m10", workspace_realpath: root, deny_symlink_escape: true }, trust_mode: "trusted", auth_scope: { auth_scope_id: "as_demo", mode: "none", isolated: true }, allowed_origins: [new URL(target.baseUrl).origin], caller: "m10-verifier", policy_version: "1.0.0" } });
  mcpServer.start();
  try {
    const accepted = await mcpServer.callTool("run_audit", { schema_version: "2.1", client_request_id: "m10_default_mcp", workspace_id: "ws_m10", project_subpath: ".", profile_path: "profiles/default/profile.json", base_tier: "full", matrix: { browsers: ["chromium"], viewports: [{ width: 1280, height: 720 }], locales: ["en-US"], auth_scope_ids: ["as_demo"] } });
    const mcpResult = accepted.kind === "accepted" ? await waitForMcpResult(mcpServer, accepted.run_handle) : accepted;
    const mcpRunId = String(accepted.run_handle || "");
    const mcpPlanPath = path.join(mcpDataRoot, "runs", mcpRunId, "plan.json");
    const mcpCoveragePath = path.join(mcpDataRoot, "runs", mcpRunId, "requirement-coverage.json");
    const mcpMetricsPath = path.join(mcpDataRoot, "runs", mcpRunId, "release-metrics.json");
    const mcpMetrics = fs.existsSync(mcpMetricsPath) ? JSON.parse(fs.readFileSync(mcpMetricsPath, "utf8")) : {};
    check("m10-mcp-default-declarative-structured-e2e", accepted.kind === "accepted" && mcpResult.kind === "ok" && mcpResult.gate === "pass" && mcpResult.audit_status === "COMPLETE" && fs.existsSync(mcpPlanPath) && fs.existsSync(mcpCoveragePath) && mcpMetrics.engine_modes?.plan_engine === "declarative" && mcpMetrics.engine_modes?.discovery_engine === "structured");
  } finally { await mcpServer.stop(); }

  const fixtureRuntime = new core.AuditVerticalSlice({ root, dataRoot, engineModes: core.LEGACY_ENGINE_MODES });
  const fixtureRequest = { ...request(target.baseUrl), tier: "fast", base_tier: "fast", __allowed_origins: ["http://127.0.0.1:*"], __trust_snapshot: { allowed_origins: ["http://127.0.0.1:*"], workspace_id: "m10", workspace_root: root } };
  const fixture = await fixtureRuntime.execute({ run: snapshot("run_m10_fixture"), request: fixtureRequest, onPhase: () => undefined });
  check("m10-dual-run-legacy-compatibility-lane-remains-available", fixture.gate === "pass" && fixture.cases.length === 3 && first.cases.length !== fixture.cases.length);

  const unsafePlan = { ...firstPlan, plan_id: "m10_unsafe", cases: [{ ...firstPlan.cases[0], steps: [{ action: "execute_js", code: "process.exit(1)" }] }] };
  const generatedCssPlan = { ...firstPlan, plan_id: "m10_css", cases: [{ ...firstPlan.cases[0], steps: [{ action: "click", locator: { by: "css", value: "#unsafe", authority: "trusted_manual" } }] }] };
  check("m10-arbitrary-javascript-plan-is-rejected", !testPlan.validatePlan(unsafePlan, { authority: "generated" }).ok);
  check("m10-generated-css-plan-is-rejected", !testPlan.validatePlan(generatedCssPlan, { authority: "generated" }).ok);
  check("m10-cross-origin-is-rejected", rejects(() => new security.BrowserNetworkGuard([target.baseUrl]).assertAllowed("https://example.com/"), "SAFETY_POLICY_VIOLATION"));
  check("m10-artifact-path-escape-is-rejected", rejects(() => new storageModule.RunStorage(dataRoot).writeJson("run_m10_default_a", "../escape.json", {})));
  check("m10-untrusted-pr-head-plan-is-rejected", rejects(() => new security.TrustResolver().resolve({ trust_mode: "untrusted_pr", workspace_authorization: { workspace_id: "pr", workspace_realpath: root }, auth_scope: { auth_scope_id: "one", mode: "none", isolated: true }, config_source: { pr_head_allowed: true } }), "UNTRUSTED_HEAD_CONFIG"));
  check("m10-secret-redaction-remains-effective", JSON.stringify(security.redactSecrets({ token: "secret", nested: "Bearer abcdef" })).includes("[REDACTED]"));

  const cacheRoot = path.join(dataRoot, "corrupt-cache");
  const cache = new planner.PlanTemplateCache(cacheRoot);
  const cacheKey = cache.key({ m10: "cache" });
  fs.writeFileSync(path.join(cacheRoot, cacheKey + ".json"), "{broken", "utf8");
  check("m10-corrupt-planner-cache-fails-closed", cache.get(cacheKey) === undefined);
  check("m10-release-documentation-is-present", ["M9-milestone-report.md", "M10-milestone-report.md", "test-plan-reference.md", "generated-testing-guide.md", "external-target-guide.md", "plan-security-guide.md", "legacy-plan-migration.md", "release-notes.md", "known-limitations.md"].every((file) => fs.existsSync(path.join(root, "docs", file))));

  const largeServer = http.createServer((_req, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ payload: "x".repeat(execution.MAX_ACCEPTED_API_RESPONSE_BYTES + 128) })); });
  await new Promise((resolve, reject) => { largeServer.once("error", reject); largeServer.listen(0, "127.0.0.1", resolve); });
  const address = largeServer.address();
  const largeUrl = "http://127.0.0.1:" + address.port;
  try {
    const largePlan = { plan_schema: "autopw.test-plan/1.0", plan_id: "m10_large_response", generated_at: "2026-08-11T00:00:00.000Z", origin: { type: "generated" }, coverage_eligible: true, cases: [{ case_id: "case_large_response", title: "large response", feature_id: "m10", requirement_refs: ["req_large_response"], oracle_bindings: [{ requirement_id: "req_large_response", step_refs: ["step_1"] }], scenario: "normal", priority: "P0", effective_tier: "smoke", kind: "api", risk: "read_only", confidence: 1, execution_policy: { production_allowed: true, timeout_ms: 5_000 }, steps: [{ action: "api_request", method: "GET", path: "/", save_as: "large" }, { action: "expect_status", source: "responses.large", equals: 200 }] }] };
    const result = await new execution.PlaywrightPlanRunner().run({ runId: "run_m10_large", baseUrl: largeUrl, allowedOrigins: [largeUrl], plan: largePlan, planAuthority: "generated", storage: new storageModule.RunStorage(dataRoot), tier: "smoke" });
    check("m10-accepted-response-payload-limit-is-enforced", result.results[0]?.status === "FAILED" && String(result.results[0]?.error || "").includes("accepted-payload limit"));
  } finally { await new Promise((resolve) => largeServer.close(resolve)); }
} finally {
  await target.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

console.log(`\nM10 release hardening verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
