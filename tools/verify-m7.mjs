import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { newHarness, call } from "../apps/mcp-host-harness/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contracts = await import(pathToFileURL(path.join(root, "packages", "mcp-contracts", "src", "tools.mjs")).href);
const security = await import(pathToFileURL(path.join(root, "packages", "security", "dist", "index.js")).href);
const maintenance = await import(pathToFileURL(path.join(root, "packages", "maintenance-cli", "dist", "index.js")).href);
let passed = 0;
let failed = 0;
function check(name, condition, detail = "") { if (condition) { passed += 1; console.log("PASS", name, detail ? "(" + detail + ")" : ""); } else { failed += 1; console.log("FAIL", name, detail); } }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

if (!process.argv.includes("--agent")) {
  const generated = path.join(root, "packages", "mcp-contracts", "contracts", "tools");
  const source = contracts.buildToolContracts();
  const names = contracts.TOOL_NAMES;
  check("m7-contract-tool-surface-frozen", names.length === 10 && new Set(names).size === 10);
  for (const name of names) {
    const file = readJson(path.join(generated, name + ".tool.json"));
    check("m7-contract-golden-" + name, file.name === name && file.description.includes("Agent guidance") && JSON.stringify(file.input_schema) === JSON.stringify(source[name].input_schema));
    check("m7-contract-" + name + "-workflow-description", /accepted|poll|persisted|untrusted|scope/i.test(file.description));
  }
  const manifest = readJson(path.join(root, "packages", "mcp-contracts", "contracts", "manifest.json"));
  check("m7-contract-manifest-unchanged-tool-count", manifest.tools.length === 10);
  const statusSchema = readJson(path.join(root, "packages", "schemas", "schemas", "mcp-status-view.schema.json"));
  check("m7-status-schema-agent-fields", Boolean(statusSchema.properties.counts && statusSchema.properties.by_tier && statusSchema.properties.recent_events));
}

if (!process.argv.includes("--contracts")) {
  const artifact = new security.SecureArtifactService();
  check("m7-secure-artifact-kind-binding", artifact.resolveArtifactName({ handle: "art_12345678_results.json", kind: "results.json" }) === "results.json");
  check("m7-secure-artifact-rejects-kind-confusion", artifact.resolveArtifactName({ handle: "art_12345678_results.json", kind: "report.md" }) === undefined);

  const migrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m7-migration-"));
  try {
    const first = maintenance.migrateDataRoot(migrationRoot);
    const second = maintenance.migrateDataRoot(migrationRoot);
    check("m7-migration-is-idempotent", first.changed && !second.changed && second.schema_version === "2.1");
    const unsupported = path.join(migrationRoot, "unsupported"); fs.mkdirSync(unsupported); fs.writeFileSync(path.join(unsupported, "storage-meta.json"), JSON.stringify({ schema_version: "3.0" }));
    check("m7-migration-rejects-unsupported-version", maintenance.migrateDataRoot(unsupported).warnings.length === 1);
    check("m7-doctor-reports-bundle", maintenance.doctor(root, migrationRoot).checks.every((item) => item.ok));
  } finally { fs.rmSync(migrationRoot, { recursive: true, force: true }); }

  const harness = await newHarness({ stepMs: 4 });
  try {
    const previewRequest = { schema_version: "2.1", client_request_id: "m7-preview", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", tier: "fast" };
    const previewAccepted = await call(harness.server, "derive_coverage", previewRequest);
    check("m7-agent-preview-accepted", previewAccepted.kind === "accepted");
    let previewResult;
    for (let i = 0; i < 200; i += 1) { previewResult = await call(harness.server, "get_operation_result", { schema_version: "2.1", workspace_id: "ws_demo", operation_id: previewAccepted.operation_id, page: 1, page_size: 2 }); if (previewResult.kind === "ok") break; await new Promise((resolve) => setTimeout(resolve, 20)); }
    check("m7-agent-preview-paginates-cdd", previewResult?.kind === "ok" && previewResult.pagination && previewResult.pagination.page_size === 2 && previewResult.result_ref.kind === "cdd.json");

    const runAccepted = await call(harness.server, "run_audit", { schema_version: "2.1", client_request_id: "m7-run", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast" });
    check("m7-agent-run-accepted", runAccepted.kind === "accepted" && typeof runAccepted.run_handle === "string");
    harness.server.restart();
    let status;
    for (let i = 0; i < 300; i += 1) { status = await call(harness.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: runAccepted.run_handle }); if (status.phase === "GATED" || status.run_status === "FAILED") break; await new Promise((resolve) => setTimeout(resolve, 25)); }
    check("m7-session-reconnect-status-view", status?.kind === "ok" && status.counts && status.by_tier && Array.isArray(status.recent_events) && status.poll_after_ms === 0, JSON.stringify(status));
    check("m7-progress-notifications-are-best-effort", harness.progress.length > 0 && new Set(harness.progress.map((item) => item.notification_id)).size === harness.progress.length);

    const run = harness.server.workerRef().getRun(runAccepted.run_handle);
    const result = await call(harness.server, "get_run_result", { schema_version: "2.1", workspace_id: "ws_demo", run_id: runAccepted.run_handle, page: 1, page_size: 1 });
    check("m7-result-pagination-and-artifact-refs", result.kind === "ok" && result.pagination && result.pagination.page_size === 1 && result.results_ref.handle.endsWith("results.json") && !JSON.stringify(result).includes(root));
    const focus = run?.cases?.[0]?.case_id;
    const explanation = await call(harness.server, "explain_run", { schema_version: "2.1", workspace_id: "ws_demo", run_id: runAccepted.run_handle, focus_case_id: focus, page: 1, page_size: 1 });
    check("m7-explain-focus-case-birth-certificate", explanation.kind === "ok" && explanation.pagination && explanation.cases.length === 1 && explanation.cases[0].case_id === focus && explanation.gate_summary);
    const missing = await call(harness.server, "explain_run", { schema_version: "2.1", workspace_id: "ws_demo", run_id: runAccepted.run_handle, focus_case_id: "case_missing" });
    check("m7-explain-missing-case-is-typed-error", missing.kind === "error" && missing.error.code === "CASE_NOT_FOUND");

    const resultsPath = path.join(harness.dataRoot, "runs", runAccepted.run_handle, "artifacts", "results.json");
    const ci = maintenance.readResultsForCi(resultsPath);
    check("m7-ci-adapter-reads-persisted-gate", ci.gate === "pass" && ci.quality_exit_code === 0);
    const cli = spawnSync(process.execPath, [path.join(root, "tools", "ci-adapter.mjs"), resultsPath], { encoding: "utf8" });
    check("m7-ci-adapter-does-not-orchestrate", cli.status === 0 && !cli.stdout.includes("run_audit"));
  } finally { await harness.cleanup(); }
}

console.log(`\nM7 verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
