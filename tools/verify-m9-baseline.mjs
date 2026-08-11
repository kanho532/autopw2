// M9.0 compatibility baseline verifier. Volatile run IDs, timestamps and ports
// are normalized so the Golden Snapshot remains deterministic.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const goldenPath = path.join(root, "fixtures", "baselines", "m9.0-baseline.json");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const { newHarness, call } = await import(pathTo("apps/mcp-host-harness/dist/index.js"));
const { FIXTURE_PLAN } = await import(pathTo("packages/execution-fixture/dist/index.js"));
const { LEGACY_ENGINE_MODES, resolveEngineModes } = await import(pathTo("packages/core/dist/index.js"));

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) { passed += 1; console.log("PASS  " + name + (detail ? " (" + detail + ")" : "")); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? " (" + detail + ")" : "")); }
}
function pathTo(relative) { return pathToFileURL(path.join(root, relative)).href; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForGate(server, runId) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const status = await call(server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: runId });
    if (status.kind === "ok" && status.phase === "GATED") return status;
    await sleep(25);
  }
  return call(server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: runId });
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

check("m9-golden-snapshot-present", golden.schema_version === "autopw.m9-baseline/1.0");
check("m9-legacy-plan-engine-mode", LEGACY_ENGINE_MODES.plan_engine === golden.engine_modes.plan_engine);
check("m9-invalid-engine-mode-rejected", (() => { try { resolveEngineModes({ plan_engine: "page" }); return false; } catch (error) { return error.code === "INVALID_PLAN_ENGINE_MODE"; } })());
check("m9-declarative-plan-engine-available", resolveEngineModes({ plan_engine: "declarative" }).plan_engine === "declarative");
check("m9-discovery-engine-retirement-is-explicit", (() => { try { resolveEngineModes({ discovery_engine: "legacy" }); return false; } catch (error) { return error.code === "DISCOVERY_ENGINE_RETIRED"; } })());
check("m9-fixture-plan-has-three-cases", FIXTURE_PLAN.cases.length === golden.fixture_case_ids.length && JSON.stringify(FIXTURE_PLAN.cases.map((item) => item.case_id)) === JSON.stringify(golden.fixture_case_ids));
check("m9-phase-order-is-frozen", golden.phase_order.join(",") === "TARGET_READY,SEED_RESOLVED,DISCOVERED,COVERAGE_DERIVED,PLAN_FILLED,PLAN_FROZEN,SUITE_GENERATED,SUITE_FROZEN,RUNNING,EXECUTION_FINISHED,RUNTIME_FINALIZED,AUDITED,REPORTED,GATED");
check("m9-mcp-contract-count-unchanged", readJson(path.join(root, "packages", "mcp-contracts", "contracts", "manifest.json")).tools.length === 10);

const flagHarness = await newHarness({ stepMs: 2 });
try {
  const request = { schema_version: "2.1", client_request_id: "m9-untrusted-flag", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast", plan_engine: "declarative" };
  const response = await call(flagHarness.server, "run_audit", request);
  check("m9-mcp-request-cannot-set-engine-mode", response.kind === "error" && response.error.code === "INVALID_INPUT");
} finally { await flagHarness.cleanup(); }

const harnesses = [];
try {
  for (const variant of ["pass", "fail", "incomplete"]) {
    const harness = await newHarness({ stepMs: 2, fixtureVariant: variant });
    harnesses.push(harness);
    const accepted = await call(harness.server, "run_audit", { schema_version: "2.1", client_request_id: "m9-baseline-" + variant, workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast" });
    check("m9-" + variant + "-accepted", accepted.kind === "accepted" && typeof accepted.run_handle === "string");
    if (accepted.kind !== "accepted") continue;
    const status = await waitForGate(harness.server, accepted.run_handle);
    const result = await call(harness.server, "get_run_result", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle, page: 1, page_size: 100 });
    const explanation = await call(harness.server, "explain_run", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle, page: 1, page_size: 100 });
    const expected = golden.variants[variant];
    check("m9-" + variant + "-gate-and-audit", result.kind === "ok" && result.gate === expected.gate && result.audit_status === expected.audit_status, JSON.stringify({ phase: status.phase, gate: result.gate, audit: result.audit_status }));
    check("m9-" + variant + "-case-count", explanation.kind === "ok" && explanation.cases.length === expected.case_count);
    const runDir = path.join(harness.dataRoot, "runs", accepted.run_handle);
    for (const file of golden.required_run_files) check("m9-" + variant + "-run-file-" + file, fs.existsSync(path.join(runDir, file)));
    for (const file of golden.required_artifacts) check("m9-" + variant + "-artifact-" + file, fs.existsSync(path.join(runDir, "artifacts", file)));
    check("m9-" + variant + "-phase-events", (() => {
      const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
      return events.filter((event) => event.kind === "PHASE_COMMITTED").map((event) => event.phase).join(",") === golden.phase_order.join(",");
    })());
    const execution = readJson(path.join(runDir, "execution-results.json"));
    check("m9-" + variant + "-execution-results-shape", Array.isArray(execution) && execution.length === expected.case_count);
    const report = fs.readFileSync(path.join(runDir, "artifacts", "report.md"), "utf8");
    check("m9-" + variant + "-report-handle-resolves", result.kind === "ok" && report.includes(result.results_ref.handle));
  }
} finally {
  for (const harness of harnesses) await harness.cleanup();
}

const previewHarness = await newHarness({ stepMs: 2 });
try {
  const accepted = await call(previewHarness.server, "derive_coverage", { schema_version: "2.1", client_request_id: "m9-baseline-preview", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", tier: "fast", diff_ref: "NOOP" });
  if (accepted.kind === "accepted") {
    let result;
    for (let attempt = 0; attempt < 240; attempt += 1) { result = await call(previewHarness.server, "get_operation_result", { schema_version: "2.1", workspace_id: "ws_demo", operation_id: accepted.operation_id }); if (result.kind === "ok") break; await sleep(25); }
    check("m9-fast-matrix-projection", result?.kind === "ok" && result.summary.projected_execution_instances === golden.fast_projection.projected_execution_instances && result.summary.projection.browsers.chromium === golden.fast_projection.projected_execution_instances);
  } else check("m9-fast-matrix-projection", false, "preview not accepted");
} finally { await previewHarness.cleanup(); }

console.log(`\nM9.0 baseline verify: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
