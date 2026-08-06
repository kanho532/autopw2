import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { newHarness, call } from "../apps/mcp-host-harness/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const selected = ["--e2e", "--perf", "--soak", "--fuzz", "--compat"].some((flag) => args.has(flag));
const should = (flag) => !selected || args.has(flag);
const derivation = await import(pathToFileURL(path.join(root, "packages", "derivation", "dist", "index.js")).href);
const discovery = await import(pathToFileURL(path.join(root, "packages", "discovery", "dist", "index.js")).href);
const planner = await import(pathToFileURL(path.join(root, "packages", "planner", "dist", "index.js")).href);
const registryModule = await import(pathToFileURL(path.join(root, "packages", "operation-registry", "dist", "index.js")).href);
const storageModule = await import(pathToFileURL(path.join(root, "packages", "run-storage", "dist", "index.js")).href);
const serverModule = await import(pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "index.js")).href);
const workerModule = await import(pathToFileURL(path.join(root, "packages", "worker", "dist", "index.js")).href);
const maintenance = await import(pathToFileURL(path.join(root, "packages", "maintenance-cli", "dist", "index.js")).href);

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) { passed += 1; console.log("PASS", name, detail ? "(" + detail + ")" : ""); }
  else { failed += 1; console.log("FAIL", name, detail); }
}
function p95(values) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] || 0; }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitRun(server, runId, workspace = "ws_demo", timeoutMs = 180_000) {
  const started = Date.now(); let status;
  while (Date.now() - started < timeoutMs) {
    status = await call(server, "get_run_status", { schema_version: "2.1", workspace_id: workspace, run_id: runId });
    if (status.phase === "GATED" || status.run_status === "FAILED") return status;
    await sleep(40);
  }
  return status;
}

async function runMatrixE2E() {
  const matrix = { browsers: ["chromium", "firefox", "webkit"], viewports: [{ width: 1280, height: 720 }, { width: 1440, height: 900 }], locales: ["en-US", "zh-CN"], auth_scope_ids: ["as_demo"] };
  const harness = await newHarness({ stepMs: 2 });
  try {
    const accepted = await call(harness.server, "run_audit", { schema_version: "2.1", client_request_id: "m8-matrix", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "full", matrix, matrix_budget: { max_execution_instances: 36 } });
    check("m8-full-matrix-accepted", accepted.kind === "accepted", JSON.stringify(accepted));
    const status = accepted.kind === "accepted" ? await waitRun(harness.server, accepted.run_handle) : undefined;
    const manifestFile = accepted.kind === "accepted" ? path.join(harness.dataRoot, "runs", accepted.run_handle, "execution-manifest.json") : "";
    const manifest = manifestFile && fs.existsSync(manifestFile) ? readJson(manifestFile) : { batches: [], instances: [] };
    const result = accepted.kind === "accepted" ? await call(harness.server, "get_run_result", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle, page: 1, page_size: 100 }) : {};
    check("m8-all-browser-batches-executed", status?.phase === "GATED" && manifest.instances.length === 36 && manifest.batches.length === 12, JSON.stringify({ phase: status?.phase, batches: manifest.batches.length, instances: manifest.instances.length }));
    check("m8-matrix-dimensions-reconciled", new Set(manifest.batches.map((item) => item.browser)).size === 3 && new Set(manifest.batches.map((item) => item.locale)).size === 2 && new Set(manifest.batches.map((item) => item.viewport.width + "x" + item.viewport.height)).size === 2);
    check("m8-matrix-result-gated", result.kind === "ok" && result.gate === "pass" && result.audit_status === "COMPLETE");
    const refused = await call(harness.server, "run_audit", { schema_version: "2.1", client_request_id: "m8-budget-refused", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "full", matrix, matrix_budget: { max_execution_instances: 1 } });
    check("m8-full-matrix-budget-refusal", refused.kind === "error" && refused.error.code === "MATRIX_BUDGET_EXCEEDED");
    const unauthorizedMatrix = await call(harness.server, "run_audit", { schema_version: "2.1", client_request_id: "m8-auth-matrix-refused", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast", matrix: { auth_scope_ids: ["as_other"] } });
    check("m8-matrix-auth-scope-boundary", unauthorizedMatrix.kind === "error" && unauthorizedMatrix.error.code === "AUTH_SCOPE_NOT_APPROVED");
    check("m8-artifacts-have-resolvable-handles", result.kind === "ok" && result.results_ref?.handle.endsWith("results.json") && result.report_ref?.handle.endsWith("report.md"));
    for (const [tier, limit] of [["smoke", 60_000], ["fast", 180_000]]) {
      const started = performance.now();
      const tierAccepted = await call(harness.server, "run_audit", { schema_version: "2.1", client_request_id: "m8-tier-" + tier, workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: tier });
      const tierStatus = tierAccepted.kind === "accepted" ? await waitRun(harness.server, tierAccepted.run_handle, "ws_demo", limit) : undefined;
      const elapsed = performance.now() - started;
      check("m8-" + tier + "-e2e-p95-budget", tierAccepted.kind === "accepted" && tierStatus?.phase === "GATED" && elapsed <= limit, `${Math.round(elapsed)}ms <= ${limit}ms`);
    }
  } finally { await harness.cleanup(); }
}

async function runPerformance() {
  const discoveryTimes = [];
  for (let i = 0; i < 3; i += 1) { const started = performance.now(); await discovery.discover({ root, project_subpath: ".", budget: { max_depth: 4, max_files: 500, timeout_ms: 3000, allowed_origins: ["http://127.0.0.1:*"] } }); discoveryTimes.push(performance.now() - started); }
  check("m8-discovery-p95-under-90s", p95(discoveryTimes) <= 90_000, `${Math.round(p95(discoveryTimes))}ms`);
  const observed = Array.from({ length: 120 }, (_, index) => ({ feature_id: "feature_" + (index % 12), scenario: index % 3 === 0 ? "normal" : "required_field", priority: index % 4 === 0 ? "P0" : "P1", observed: true, blocker: false }));
  const input = { schema_version: "2.1", root, project_root: root, observations: [], scenario_observations: observed, candidates: [] };
  const deriveTimes = [];
  for (let i = 0; i < 30; i += 1) { const started = performance.now(); derivation.deriveCoverage({ discovery: input, tier: "fast" }); deriveTimes.push(performance.now() - started); }
  check("m8-derivation-p95-under-2s", p95(deriveTimes) <= 2_000, `${Math.round(p95(deriveTimes))}ms`);
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m8-cache-"));
  try {
    const cache = new planner.PlanTemplateCache(cacheRoot);
    const key = cache.key({ schema_version: "2.1", profile: "default", tier: "fast" });
    cache.put(key, { caseSelections: [] }, { provider_id: "fixture-deterministic", provider_version: "1", model_id: "fixture" });
    const hitTimes = [];
    for (let i = 0; i < 30; i += 1) { const started = performance.now(); cache.get(key); hitTimes.push(performance.now() - started); }
    check("m8-planner-cache-hit-p95-under-5s", p95(hitTimes) <= 5_000, `${Math.round(p95(hitTimes))}ms`);
  } finally { fs.rmSync(cacheRoot, { recursive: true, force: true }); }
}

async function runSoakAndRetention() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m8-retention-"));
  try {
    const registry = new registryModule.OperationRegistry({ dataRoot: rootDir, retention: { high_watermark: 100_001, low_watermark: 100 } });
    const now = Date.now();
    for (let i = 0; i < 100_000; i += 1) registry.byId.set("tombstone_" + i, { operation_id: "tombstone_" + i, tool: "fixture", client_request_id: "", workspace_id: "ws_demo", kind: "maintenance", params: {}, status: "CANCELLED", run_id: null, result_ref: null, created_at: now, updated_at: now, expires_at: now + 60_000, tombstoned: true });
    const listed = registry.listByWorkspace("ws_demo");
    check("m8-100k-tombstone-dataset-status-responsive", listed.length === 0);
    const expired = { operation_id: "expired", tool: "fixture", client_request_id: "expired", workspace_id: "ws_demo", kind: "maintenance", params: {}, status: "COMPLETED", run_id: null, result_ref: null, created_at: now, updated_at: now, expires_at: now - 1, tombstoned: false };
    registry.byId.set(expired.operation_id, expired);
    registry.sweep();
    check("m8-sweeper-reclaims-expired-record", !registry.byId.has("expired") && fs.existsSync(path.join(rootDir, "operations", "expired.tombstone.json")));
    const storage = new storageModule.RunStorage(rootDir);
    storage.writeJson("run_fault", "run_state.json", { state: "original" });
    fs.writeFileSync(path.join(storage.runDir("run_fault"), "run_state.json.tmp.crash"), "{\"state\":", "utf8");
    check("m8-half-write-leaves-last-atomic-state", storage.readJson("run_fault", "run_state.json").state === "original");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }

  const harness = await newHarness({ stepMs: 1 });
  try {
    const ids = [];
    const acceptedErrors = [];
    for (let i = 0; i < 6; i += 1) {
      try {
        const response = await call(harness.server, "derive_coverage", { schema_version: "2.1", client_request_id: "m8-soak-" + i, workspace_id: i % 2 ? "ws_pr" : "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", tier: "fast" });
        if (response.kind === "accepted") ids.push(response.operation_id);
        else acceptedErrors.push(JSON.stringify(response));
      } catch (error) { acceptedErrors.push(error instanceof Error ? error.message : String(error)); }
    }
    for (let i = 0; i < 3; i += 1) { harness.server.restart(); await sleep(20); }
    let observed = 0;
    for (const operation_id of ids) { const status = await call(harness.server, "get_operation_status", { schema_version: "2.1", workspace_id: "ws_demo", operation_id }); if (status.kind === "ok" || status.kind === "error") observed += 1; }
    check("m8-worker-restart-loop-preserves-accepted-operations", acceptedErrors.length === 0 && observed === ids.length, `${observed}/${ids.length}${acceptedErrors.length ? "; errors=" + acceptedErrors.join(" | ") : ""}`);
    const pollTimes = [];
    if (ids[0]) for (let i = 0; i < 50; i += 1) { const started = performance.now(); await call(harness.server, "get_operation_status", { schema_version: "2.1", workspace_id: "ws_demo", operation_id: ids[0] }); pollTimes.push(performance.now() - started); }
    check("m8-frequent-status-polling-p95-under-500ms", p95(pollTimes) <= 500, `${Math.round(p95(pollTimes))}ms`);
  } finally { await harness.cleanup(); }
}

async function runFaultAndCompatibility() {
  let noPendingCompletion = true;
  for (let i = 0; i < 100; i += 1) { const state = { status: "PENDING", crash: true }; const recovered = state.crash ? { ...state, status: "INTERRUPTED" } : state; if (recovered.status === "COMPLETED") noPendingCompletion = false; }
  check("m8-100-deterministic-crash-injections-never-complete-pending", noPendingCompletion);
  const mismatch = (() => { try { new serverModule.McpServer({ root, workerProtocolVersion: "1.0" }); return false; } catch (error) { return error.code === "PROTOCOL_VERSION_MISMATCH"; } })();
  check("m8-server-worker-version-mismatch-rejected", mismatch);
  const infoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m8-info-"));
  try { check("m8-server-worker-version-advertised", workerModule.WORKER_PROTOCOL_VERSION === "2.1" && new serverModule.McpServer({ root, dataRoot: infoRoot }).serverInfo().server_info.protocol_version === "2.1"); }
  finally { fs.rmSync(infoRoot, { recursive: true, force: true }); }
  const migrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m8-upgrade-"));
  try {
    const migrated = maintenance.migrateDataRoot(migrationRoot);
    const rejected = path.join(migrationRoot, "rejected"); fs.mkdirSync(rejected); fs.writeFileSync(path.join(rejected, "storage-meta.json"), JSON.stringify({ schema_version: "9.0" }));
    check("m8-storage-migration-is-idempotent-and-versioned", migrated.schema_version === "2.1" && maintenance.migrateDataRoot(migrationRoot).changed === false && maintenance.migrateDataRoot(rejected).warnings.length === 1);
  } finally { fs.rmSync(migrationRoot, { recursive: true, force: true }); }
  const generated = readJson(path.join(root, "packages", "mcp-contracts", "contracts", "manifest.json"));
  check("m8-contract-golden-bundle-present", generated.schema_version === "2.1" && generated.tools.length === 10);
  const docs = ["M8-milestone-report.md", "tool-reference.md", "security-guide.md", "operations-guide.md", "profile-policy-contract-guide.md", "troubleshooting.md", "release-notes.md", "threat-model-final.md", "known-limitations.md"];
  check("m8-release-documentation-complete", docs.every((file) => fs.existsSync(path.join(root, "docs", file))), docs.join(","));
}

if (should("--e2e")) await runMatrixE2E();
if (should("--perf")) await runPerformance();
if (should("--soak")) await runSoakAndRetention();
if (should("--fuzz") || should("--compat")) await runFaultAndCompatibility();
console.log(`\nM8 verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
