// M2 MCP Audit Vertical Slice acceptance verifier.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as timerSleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const harnessPath = pathToFileURL(path.join(root, "apps", "mcp-host-harness", "dist", "index.js")).href;
const compilerPath = pathToFileURL(path.join(root, "packages", "compiler", "dist", "index.js")).href;
const { newHarness, call } = await import(harnessPath);
const { assertSafeGeneratedSource } = await import(compilerPath);
let passed = 0;
let failed = 0;
function check(name, condition, detail = "") { if (condition) passed += 1; else failed += 1; console.log((condition ? "PASS" : "FAIL") + "  " + name + (detail ? "  (" + detail + ")" : "")); }
async function sleep(ms) { await timerSleep(ms); }
async function waitForResult(server, runId, expectedGate) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await call(server, "get_run_result", { schema_version: "2.1", workspace_id: "ws_demo", run_id: runId });
    if (result.kind === "ok" && result.gate === expectedGate) return result;
    await sleep(100);
  }
  return await call(server, "get_run_result", { schema_version: "2.1", workspace_id: "ws_demo", run_id: runId });
}
function request(client_request_id, fixture_variant) { return { schema_version: "2.1", client_request_id, workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast", fixture_variant }; }

// Pass: a real Chromium run produces terminal artifacts and a pass Gate.
{
  const harness = await newHarness({ stepMs: 2 });
  const accepted = await call(harness.server, "run_audit", request("m2_pass_1", "pass"));
  check("m2-pass-accepted", accepted.kind === "accepted" && Boolean(accepted.run_handle), "kind=" + accepted.kind);
  const statusBefore = await call(harness.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle });
  const result = await waitForResult(harness.server, accepted.run_handle, "pass");
  check("m2-pass-gated", result.kind === "ok" && result.gate === "pass" && result.audit_status === "COMPLETE", "kind=" + result.kind + ", gate=" + result.gate);
  check("m2-pass-real-artifact-refs", result.kind === "ok" && result.results_ref.kind === "results.json" && result.report_ref.kind === "report.md", "results=" + (result.results_ref && result.results_ref.handle));
  const statusAfter = await call(harness.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle });
  check("m2-mcp-query-does-not-advance-phase", statusBefore.phase !== "GATED" && statusAfter.phase === "GATED", "before=" + statusBefore.phase + ", after=" + statusAfter.phase);
  const explanation = await call(harness.server, "explain_run", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle });
  check("m2-evidence-and-case-explanation", explanation.kind === "ok" && explanation.cases.length === 3 && explanation.evidence_refs.length >= 3, "cases=" + (explanation.cases && explanation.cases.length));
  const runDir = path.join(harness.dataRoot, "runs", accepted.run_handle);
  check("m2-results-and-report-files-exist", fs.existsSync(path.join(runDir, "artifacts", "results.json")) && fs.existsSync(path.join(runDir, "artifacts", "report.md")) && fs.existsSync(path.join(runDir, "artifacts", "report.html")), runDir);
  const dataRoot = harness.dataRoot;
  harness.server.stop();
  const restarted = await newHarness({ dataRoot, stepMs: 2 });
  const restartedResult = await call(restarted.server, "get_run_result", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle });
  const restartedExplanation = await call(restarted.server, "explain_run", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle });
  check("m2-restart-preserves-result-refs", restartedResult.kind === "ok" && restartedResult.gate === "pass" && restartedResult.results_ref.handle === result.results_ref.handle, "gate=" + restartedResult.gate);
  check("m2-restart-preserves-case-evidence", restartedExplanation.kind === "ok" && restartedExplanation.cases.length === 3 && restartedExplanation.evidence_refs.length >= 3, "cases=" + (restartedExplanation.cases && restartedExplanation.cases.length));
  restarted.server.stop();
  const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const phases = events.filter((event) => event.kind === "PHASE_COMMITTED").map((event) => event.phase);
  check("m2-phase-path-is-ordered", phases.join(",") === "TARGET_READY,SEED_RESOLVED,DISCOVERED,COVERAGE_DERIVED,PLAN_FILLED,PLAN_FROZEN,SUITE_GENERATED,SUITE_FROZEN,RUNNING,EXECUTION_FINISHED,RUNTIME_FINALIZED,AUDITED,REPORTED,GATED", "phases=" + phases.join(","));
  restarted.cleanup();
}

// Fail: a product defect and console error are captured, but other cases finish.
{
  const harness = await newHarness({ stepMs: 2 });
  const accepted = await call(harness.server, "run_audit", request("m2_fail_1", "fail"));
  const result = await waitForResult(harness.server, accepted.run_handle, "fail");
  check("m2-fail-gate-is-complete", result.kind === "ok" && result.gate === "fail" && result.audit_status === "COMPLETE", "gate=" + result.gate + ", audit=" + result.audit_status);
  const explanation = await call(harness.server, "explain_run", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle });
  check("m2-fail-has-product-issue", explanation.kind === "ok" && explanation.cases.some((item) => item.status === "FAILED") && explanation.evidence_refs.length >= 3, "cases=" + (explanation.cases && explanation.cases.length));
  await harness.cleanup();
}

// Incomplete: one declared fixture capability is blocked, producing incomplete.
{
  const harness = await newHarness({ stepMs: 2 });
  const accepted = await call(harness.server, "run_audit", request("m2_incomplete_1", "incomplete"));
  const result = await waitForResult(harness.server, accepted.run_handle, "incomplete");
  check("m2-incomplete-gate", result.kind === "ok" && result.gate === "incomplete" && result.audit_status === "INCOMPLETE", "gate=" + result.gate + ", audit=" + result.audit_status);
  const explanation = await call(harness.server, "explain_run", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle });
  check("m2-incomplete-identifies-blocked-case", explanation.kind === "ok" && explanation.cases.some((item) => item.status === "BLOCKED_RESUME"), "blocked=" + (explanation.cases && explanation.cases.filter((item) => item.status === "BLOCKED_RESUME").length));
  await harness.cleanup();
}

let rejected = false;
try { assertSafeGeneratedSource("import fs from 'node:fs';"); } catch (error) { rejected = error.message === "GENERATED_SUITE_FORBIDDEN_IMPORT"; }
check("m2-compiler-rejects-forbidden-import", rejected);

console.log("\nM2 verify: " + passed + " passed, " + failed + " failed");
if (failed > 0) { console.log("BLOCKED — M2 MCP Audit Vertical Slice not satisfied."); process.exit(1); }
console.log("OK — M2 MCP Audit Vertical Slice acceptance met.");
