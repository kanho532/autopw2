// M3 Coverage Intelligence acceptance verifier.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const harnessPath = pathToFileURL(path.join(root, "apps", "mcp-host-harness", "dist", "index.js")).href;
const discoveryPath = pathToFileURL(path.join(root, "packages", "discovery", "dist", "index.js")).href;
const derivationPath = pathToFileURL(path.join(root, "packages", "derivation", "dist", "index.js")).href;
const plannerPath = pathToFileURL(path.join(root, "packages", "planner", "dist", "index.js")).href;
const fixturePath = pathToFileURL(path.join(root, "packages", "execution-fixture", "dist", "index.js")).href;
const { newHarness, call } = await import(harnessPath);
const { discover } = await import(discoveryPath);
const { analyzeDiff, deriveCoverage } = await import(derivationPath);
const { planExecutionInstances } = await import(plannerPath);
const { startDemoTarget } = await import(fixturePath);

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") { if (condition) passed += 1; else failed += 1; console.log((condition ? "PASS" : "FAIL") + "  " + name + (detail ? "  (" + detail + ")" : "")); }
async function waitPreview(server, operationId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await call(server, "get_operation_result", { schema_version: "2.1", workspace_id: "ws_demo", operation_id: operationId });
    if (result.kind === "ok") return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return call(server, "get_operation_result", { schema_version: "2.1", workspace_id: "ws_demo", operation_id: operationId });
}

{
  const harness = await newHarness({ stepMs: 2 });
  const accepted = await call(harness.server, "derive_coverage", { schema_version: "2.1", client_request_id: "m3_preview_1", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", tier: "fast", diff_ref: "NOOP" });
  const result = await waitPreview(harness.server, accepted.operation_id);
  check("m3-preview-accepted", accepted.kind === "accepted" && Boolean(accepted.operation_id));
  check("m3-preview-result-with-timings", result.kind === "ok" && result.summary.timings.discovery_wall_ms >= 0 && result.summary.timings.derivation_cpu_ms >= 0 && result.summary.timings.serialization_ms >= 0);
  check("m3-preview-cdd-artifact", result.kind === "ok" && result.result_ref.kind === "cdd.json" && result.result_ref.handle.endsWith("_cdd.json"));
  const previewRunId = "run_" + accepted.operation_id.slice(3);
  const cddPath = path.join(harness.dataRoot, "runs", previewRunId, "artifacts", "cdd.json");
  check("m3-preview-artifact-resolvable", fs.existsSync(cddPath) && JSON.parse(fs.readFileSync(cddPath, "utf8")).derivation.skeleton.length > 0, cddPath);
  check("m3-preview-has-no-gate", result.kind === "ok" && result.summary.gate === undefined);
  const runAccepted = await call(harness.server, "run_audit", { schema_version: "2.1", client_request_id: "m3_consistency_run", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast" });
  for (let attempt = 0; attempt < 120; attempt += 1) { const status = await call(harness.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: runAccepted.run_handle }); if (status.phase === "GATED") break; await new Promise((resolve) => setTimeout(resolve, 25)); }
  const runDerivation = JSON.parse(fs.readFileSync(path.join(harness.dataRoot, "runs", runAccepted.run_handle, "derivation.json"), "utf8"));
  const previewCdd = JSON.parse(fs.readFileSync(cddPath, "utf8"));
  check("m3-preview-run-input-versions-match", JSON.stringify(previewCdd.derivation.input_versions) === JSON.stringify(runDerivation.input_versions));
  await harness.cleanup();
}

{
  const target = await startDemoTarget("pass");
  const discovery = await discover({ root, target_url: target.baseUrl, budget: { max_depth: 2, max_files: 40, timeout_ms: 2000, allowed_origins: [new URL(target.baseUrl).origin] } });
  check("m3-discovery-real-target-candidate", discovery.candidates.some((candidate) => candidate.feature_id === "demo_form"));
  check("m3-discovery-untrusted-page-observation", discovery.observations.some((observation) => observation.untrusted === true && typeof observation.value === "string"));
  check("m3-discovery-budget-metrics", discovery.budget.files_scanned <= 40 && discovery.metrics.discovery_wall_ms >= 0);
  let originRejected = false;
  try { await discover({ root, target_url: target.baseUrl, budget: { allowed_origins: ["https://invalid.example"] } }); } catch (error) { originRejected = error.message === "DISCOVERY_ORIGIN_NOT_ALLOWED"; }
  check("m3-discovery-origin-guard", originRejected);
  await target.close();
}

const baseDiscovery = { schema_version: "2.1", observations: [], candidates: [], scenario_observations: [
  { feature_id: "legacy", scenario: "normal", observed: true, blocker: false, priority: "P0" },
  { feature_id: "new_feature", scenario: "normal", observed: true, blocker: false, priority: "P0" }
] };
const changed = analyzeDiff({ diffRef: "A...B", mappings: [{ file_glob: "B", features: ["legacy"], propagate: true }] });
const derived = deriveCoverage({ discovery: baseDiscovery, tier: "fast", diff: { ...changed, status: "CHANGED", changed_files: [{ status: "M", path: "B", feature_ids: ["legacy"], new_feature: false }], affected_features: ["legacy"], new_features: ["new_feature"] } });
check("m3-diff-empty-is-noop", analyzeDiff({ diffRef: "NOOP" }).status === "NOOP");
check("m3-effective-tier-is-derived-before-scope", derived.skeleton.find((item) => item.feature_id === "legacy")?.effective_tier === "smoke" && derived.skeleton.find((item) => item.feature_id === "new_feature")?.effective_tier === "fast");
const scopedDiff = analyzeDiff({ diffRef: "A...B", changedFiles: [{ status: "M", path: "src/legacy.ts" }, { status: "A", path: "src/new.ts" }], mappings: [{ file_glob: "src/legacy.ts", features: ["legacy"] }, { file_glob: "src/new.ts", features: ["new_feature"] }] });
check("m3-diff-real-git-path-is-not-silent-noop", analyzeDiff({ diffRef: "HEAD~1...HEAD", root }).status === "CHANGED");
check("m3-diff-failure-is-explicit", (() => { try { analyzeDiff({ diffRef: "HEAD", root: path.join(root, "missing-project") }); return false; } catch (error) { return error.code === "DIFF_UNAVAILABLE"; } })());
check("m3-diff-features-belong-to-their-file", scopedDiff.changed_files.find((file) => file.path === "src/legacy.ts")?.feature_ids.join(",") === "legacy" && scopedDiff.changed_files.find((file) => file.path === "src/new.ts")?.feature_ids.join(",") === "new_feature");

const p0ObservedBlocker = deriveCoverage({ discovery: { ...baseDiscovery, scenario_observations: [{ feature_id: "observed", scenario: "normal", observed: true, blocker: true, priority: "P0" }] }, tier: "smoke" });
const p0PlannedAndBlocked = deriveCoverage({ discovery: { ...baseDiscovery, scenario_observations: [{ feature_id: "planned", scenario: "normal", observed: true, blocker: false, priority: "P0" }, { feature_id: "blocked", scenario: "normal", observed: false, blocker: true, priority: "P0" }] }, tier: "smoke" });
const p0Missing = deriveCoverage({ discovery: { ...baseDiscovery, scenario_observations: [] }, tier: "smoke", mandatory_capabilities: [{ id: "authentication", priority: "P0", feature_ids: ["login"], on_missing: "incomplete" }] });
check("m3-p0-observed-not-blocked", p0ObservedBlocker.skeleton[0].blocked === false && p0ObservedBlocker.p0_coverage_pct === 100);
check("m3-p0-blocker-remains-in-denominator", p0PlannedAndBlocked.p0_coverage_pct === 50 && p0PlannedAndBlocked.cdd.p0_blocked === true);
check("m3-p0-missing-is-objective-blocker", p0Missing.skeleton.some((item) => item.blocked && item.reason === "MANDATORY_CAPABILITY_NOT_OBSERVED") && p0Missing.p0_coverage_pct === 0 && p0Missing.projection.projected_execution_instances === 0);

const scenarioDiscovery = { schema_version: "2.1", observations: [], candidates: [], scenario_observations: [
  { feature_id: "scenario_feature", scenario: "normal", observed: true, blocker: false, priority: "P0" },
  { feature_id: "scenario_feature", scenario: "boundary", observed: true, blocker: false, priority: "P0" },
  { feature_id: "scenario_feature", scenario: "invalid_input", observed: true, blocker: false, priority: "P1" },
  { feature_id: "scenario_feature", scenario: "service_error", observed: true, blocker: false, priority: "P2" }
] };
const smokeScenarios = deriveCoverage({ discovery: scenarioDiscovery, tier: "smoke" });
const fastScenarios = deriveCoverage({ discovery: scenarioDiscovery, tier: "fast" });
const fullScenarios = deriveCoverage({ discovery: scenarioDiscovery, tier: "full" });
check("m3-tier-scenario-pruning", smokeScenarios.skeleton.find((item) => item.scenario === "boundary")?.reason === "TIER_SKIPPED_SCENARIO" && fastScenarios.skeleton.find((item) => item.scenario === "invalid_input")?.status === "PLANNED" && fullScenarios.skeleton.find((item) => item.scenario === "service_error")?.status === "PLANNED");

const matrix = planExecutionInstances([{ case_id: "case_a" }, { case_id: "case_b" }], "full");
const matrixAgain = planExecutionInstances([{ case_id: "case_b" }, { case_id: "case_a" }], "full");
check("m3-full-matrix-expands-cartesian-product", matrix.projected_execution_instances === 12 && matrix.batches.length === 6);
check("m3-execution-ids-are-stable", JSON.stringify(matrix.instances) === JSON.stringify(matrixAgain.instances));
check("m3-matrix-dimensions-are-explainable", matrix.dimensions.browsers.chromium === 4 && matrix.dimensions.viewports["1440x900"] === 6);
check("m3-blocked-cases-do-not-consume-instances", p0PlannedAndBlocked.projection.projected_execution_instances === 1);

{
  const harness = await newHarness({ stepMs: 2 });
  const refused = await call(harness.server, "run_audit", { schema_version: "2.1", client_request_id: "m3_budget_1", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "full", matrix_budget: { max_execution_instances: 1 } });
  check("m3-budget-error-code-and-decomposition", refused.kind === "error" && refused.error.code === "MATRIX_BUDGET_EXCEEDED" && refused.error.details.projected_execution_instances > 1 && refused.error.details.narrowing_suggestions.length > 0);
  check("m3-budget-does-not-create-run", harness.server.registryRef().byId.size === 0 && harness.server.workerRef().runs.size === 0);
  const accepted = await call(harness.server, "run_audit", { schema_version: "2.1", client_request_id: "m3_idem_preflight", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast" });
  const conflict = await call(harness.server, "run_audit", { schema_version: "2.1", client_request_id: "m3_idem_preflight", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "full", matrix_budget: { max_execution_instances: 1 } });
  check("m3-idempotency-conflict-precedes-preflight", accepted.kind === "accepted" && conflict.kind === "error" && conflict.error.code === "IDEMPOTENCY_CONFLICT");
  const missing = await call(harness.server, "derive_coverage", { schema_version: "2.1", client_request_id: "m3_missing_subpath", workspace_id: "ws_demo", project_subpath: "missing-project", profile_path: ".autopw/profile.yaml", tier: "fast" });
  check("m3-missing-project-subpath-is-explicit", missing.kind === "error" && missing.error.code === "PROJECT_SUBPATH_NOT_FOUND");
  await harness.cleanup();
}

console.log("\nM3 verify: " + passed + " passed, " + failed + " failed");
if (failed > 0) { console.log("BLOCKED — M3 Coverage Intelligence not satisfied."); process.exit(1); }
console.log("OK — M3 Coverage Intelligence acceptance met.");
