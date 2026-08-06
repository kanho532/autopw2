// M1 Persistent Control Plane acceptance verifier.
// Exercises the public MCP-facing path through the real server, control plane,
// registry and fixture worker. Every accepted response is also validated by
// the Control Plane against its frozen tool result contract.
import path from "node:path";
import { setTimeout as timerSleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const harnessPath = pathToFileURL(path.join(root, "apps", "mcp-host-harness", "dist", "index.js")).href;
const { newHarness, call } = await import(harnessPath);

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) passed += 1;
  else failed += 1;
  console.log((condition ? "PASS" : "FAIL") + "  " + name + (detail ? "  (" + detail + ")" : ""));
}

async function sleep(ms) { await timerSleep(ms); }
async function close(harness) { harness.cleanup(); await sleep(5); }

const runReq = {
  schema_version: "2.1", client_request_id: "cr_run_1", workspace_id: "ws_demo",
  project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast"
};

// Idempotency: a retry returns the same Operation and the same stable Run handle.
{
  const harness = await newHarness({ retention: { operation_ttl_ms: 60_000, run_ttl_ms: 60_000, evidence_ttl_ms: 60_000, high_watermark: 1000, low_watermark: 100 }, stepMs: 20 });
  const outputs = [];
  for (let index = 0; index < 20; index += 1) outputs.push(await call(harness.server, "run_audit", { ...runReq }));
  const operationIds = new Set(outputs.map((output) => output.operation_id));
  const runHandles = new Set(outputs.map((output) => output.run_handle));
  check("idempotency-20-create-one-operation", operationIds.size === 1, "operations=" + operationIds.size);
  check("idempotency-stable-run-handle", runHandles.size === 1, "run_handles=" + runHandles.size);
  check("idempotency-no-duplicate-runs", harness.server.workerRef().runs.size === 1, "runs=" + harness.server.workerRef().runs.size);
  const conflict = await call(harness.server, "run_audit", { ...runReq, base_tier: "full" });
  check("idempotency-conflict-on-param-change", conflict.kind === "error" && conflict.error.code === "IDEMPOTENCY_CONFLICT", "code=" + (conflict.error && conflict.error.code));
  const reordered = await call(harness.server, "run_audit", {
    schema_version: "2.1", client_request_id: "cr_run_1", workspace_id: "ws_demo",
    base_tier: "fast", profile_path: ".autopw/profile.yaml", project_subpath: "."
  });
  check("idempotency-ignores-object-key-order", reordered.kind === "accepted" && reordered.operation_id === outputs[0].operation_id, "operation=" + reordered.operation_id);
  const runningStatus = await call(harness.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: outputs[0].run_handle });
  check("running-status-omits-null-contract-fields", runningStatus.kind === "ok" && !Object.prototype.hasOwnProperty.call(runningStatus, "gate") && !Object.prototype.hasOwnProperty.call(runningStatus, "audit_status"), "kind=" + runningStatus.kind);
  const explanation = await call(harness.server, "explain_run", { schema_version: "2.1", workspace_id: "ws_demo", run_id: outputs[0].run_handle });
  check("running-explanation-omits-null-contract-fields", explanation.kind === "ok" && !Object.prototype.hasOwnProperty.call(explanation, "gate") && !Object.prototype.hasOwnProperty.call(explanation, "audit_status"), "kind=" + explanation.kind);
  await close(harness);
}

// Host authorization and workspace path containment.
{
  const harness = await newHarness({ stepMs: 4 });
  const unknownWorkspace = await call(harness.server, "run_audit", { ...runReq, workspace_id: "ws_evil" });
  check("auth-unauthorized-workspace-rejected", unknownWorkspace.kind === "error" && unknownWorkspace.error.code === "UNAUTHORIZED_WORKSPACE", "code=" + (unknownWorkspace.error && unknownWorkspace.error.code));
  const escape = await call(harness.server, "run_audit", { ...runReq, project_subpath: "../../" });
  check("auth-project-subpath-escape-rejected", escape.kind === "error" && escape.error.code === "WORKSPACE_ESCAPE", "code=" + (escape.error && escape.error.code));
  const badScope = await call(harness.server, "run_audit", { ...runReq, auth_scope_id: "as_unapproved" });
  check("auth-unapproved-auth-scope-rejected", badScope.kind === "error" && badScope.error.code === "AUTH_SCOPE_NOT_APPROVED", "code=" + (badScope.error && badScope.error.code));
  await close(harness);
}

// Durable restart: a fresh server instance can query the persisted terminal Run.
{
  const first = await newHarness({ retention: { operation_ttl_ms: 60_000, run_ttl_ms: 60_000, evidence_ttl_ms: 60_000, high_watermark: 1000, low_watermark: 100 }, stepMs: 4 });
  const created = await call(first.server, "run_audit", { ...runReq, client_request_id: "cr_persist_1" });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const running = await call(first.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: created.run_handle });
    if (running.kind === "ok" && running.phase === "GATED") break;
    await sleep(100);
  }
  first.server.stop();
  const second = await newHarness({ dataRoot: first.dataRoot, retention: { operation_ttl_ms: 60_000, run_ttl_ms: 60_000, evidence_ttl_ms: 60_000, high_watermark: 1000, low_watermark: 100 }, stepMs: 4 });
  const status = await call(second.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: created.run_handle });
  check("persistence-fresh-server-run-queryable", status.kind === "ok" && status.run_id === created.run_handle, "kind=" + status.kind);
  check("persistence-fresh-server-state-restored", status.kind === "ok" && status.phase === "GATED" && status.gate === "pass", "phase=" + status.phase + ", gate=" + status.gate);
  const repeated = await call(second.server, "run_audit", { ...runReq, client_request_id: "cr_persist_1" });
  check("persistence-restart-same-operation-and-handle", repeated.operation_id === created.operation_id && repeated.run_handle === created.run_handle, "operation=" + repeated.operation_id);
  const operationStatus = await call(second.server, "get_operation_status", { schema_version: "2.1", workspace_id: "ws_demo", operation_id: created.operation_id });
  check("operation-status-query-works", operationStatus.kind === "ok" && operationStatus.operation_id === created.operation_id, "kind=" + operationStatus.kind);
  await close(second);
}

// Result queries expose their frozen discriminators while work is in flight;
// unknown tools preserve TOOL_NOT_FOUND instead of being relabeled as an
// internal contract failure.
{
  const harness = await newHarness({ stepMs: 40 });
  const preview = await call(harness.server, "derive_coverage", { schema_version: "2.1", client_request_id: "cr_result_query_1", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", tier: "smoke" });
  const operationResult = await call(harness.server, "get_operation_result", { schema_version: "2.1", workspace_id: "ws_demo", operation_id: preview.operation_id });
  check("operation-result-nonterminal-is-not-ready", operationResult.kind === "not_ready" && operationResult.operation_id === preview.operation_id, "kind=" + operationResult.kind);
  const run = await call(harness.server, "run_audit", { ...runReq, client_request_id: "cr_result_query_run_1" });
  const runResult = await call(harness.server, "get_run_result", { schema_version: "2.1", workspace_id: "ws_demo", run_id: run.run_handle });
  check("run-result-nonterminal-is-not-ready", runResult.kind === "not_ready" && runResult.run_id === run.run_handle, "kind=" + runResult.kind);
  const unknown = await call(harness.server, "not_a_tool", { schema_version: "2.1", workspace_id: "ws_demo" });
  check("unknown-tool-preserves-tool-not-found", unknown.kind === "error" && unknown.error.code === "TOOL_NOT_FOUND", "code=" + (unknown.error && unknown.error.code));
  await close(harness);
}

// Controlled cancellation and cleanup are real MCP operations, not no-op accepts.
{
  const harness = await newHarness({ stepMs: 20 });
  const created = await call(harness.server, "run_audit", { ...runReq, client_request_id: "cr_cancel_1" });
  const cancelled = await call(harness.server, "cancel_run", { schema_version: "2.1", client_request_id: "cr_cancel_request_1", workspace_id: "ws_demo", run_id: created.run_handle });
  check("cancel-returns-contract-valid-accepted", cancelled.kind === "accepted" && cancelled.run_id === created.run_handle, "kind=" + cancelled.kind);
  await sleep(100);
  const status = await call(harness.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: created.run_handle });
  check("cancel-produces-incomplete-gate", status.kind === "ok" && status.phase === "GATED" && status.audit_status === "INCOMPLETE" && status.gate === "incomplete", "phase=" + status.phase + ", gate=" + status.gate);
  check("cancel-terminal-path-persists-finalization-fields", status.kind === "ok" && status.phase === "GATED" && status.run_status === "COMPLETED" && status.next_action === "get_run_result", "phase=" + status.phase + ", status=" + status.run_status);
  const cleaned = await call(harness.server, "cleanup_run", { schema_version: "2.1", client_request_id: "cr_cleanup_1", workspace_id: "ws_demo", run_id: created.run_handle });
  check("cleanup-returns-contract-valid-accepted", cleaned.kind === "accepted" && cleaned.run_id === created.run_handle, "kind=" + cleaned.kind);
  await close(harness);
}

// Resume is idempotently wired to the same Run rather than creating a second Run.
{
  const harness = await newHarness({ stepMs: 8 });
  const created = await call(harness.server, "run_audit", { ...runReq, client_request_id: "cr_resume_target_1" });
  const resumed = await call(harness.server, "resume_run", { schema_version: "2.1", client_request_id: "cr_resume_1", workspace_id: "ws_demo", run_id: created.run_handle });
  check("resume-returns-same-run-handle", resumed.kind === "accepted" && resumed.run_id === created.run_handle, "kind=" + resumed.kind);
  await sleep(180);
  const resumeStatus = await call(harness.server, "get_operation_status", { schema_version: "2.1", workspace_id: "ws_demo", operation_id: resumed.operation_id });
  check("resume-operation-reaches-terminal-status", resumeStatus.kind === "ok" && resumeStatus.status === "COMPLETED", "status=" + resumeStatus.status);
  await close(harness);
}

// Backpressure refuses new Operations once no expired record is reclaimable.
{
  const harness = await newHarness({ retention: { operation_ttl_ms: 60_000, run_ttl_ms: 60_000, evidence_ttl_ms: 60_000, high_watermark: 4, low_watermark: 1 }, stepMs: 4 });
  const results = [];
  for (let index = 0; index < 12; index += 1) {
    results.push(await call(harness.server, "derive_coverage", { schema_version: "2.1", client_request_id: "cr_bp_" + index, workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", tier: "smoke" }));
  }
  const refused = results.findIndex((result) => result.kind === "error" && result.error.code === "BACKPRESSURE_REFUSED");
  const ids = results.filter((result) => result.operation_id).map((result) => result.operation_id);
  check("backpressure-refused-at-high-watermark", refused >= 0, "refused_at=" + refused);
  check("backpressure-no-duplicate-operations", new Set(ids).size === ids.length, "unique=" + new Set(ids).size + ", total=" + ids.length);
  await close(harness);
}

// Retention leaves a tombstone, removes the live record/index and permits a new idempotency key.
{
  const ttlMs = 80;
  const harness = await newHarness({ retention: { operation_ttl_ms: ttlMs, run_ttl_ms: ttlMs, evidence_ttl_ms: ttlMs, high_watermark: 1000, low_watermark: 1 }, stepMs: 4 });
  const created = await call(harness.server, "derive_coverage", { schema_version: "2.1", client_request_id: "cr_sweep_1", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", tier: "smoke" });
  await sleep(ttlMs + 20);
  const sweep = harness.server.sweep();
  check("sweeper-reclaims-expired", sweep.reclaimed >= 1, "reclaimed=" + sweep.reclaimed);
  check("sweeper-removes-live-registry-record", !harness.server.registryRef().byId.has(created.operation_id), "live_records=" + harness.server.registryRef().byId.size);
  let expired = false;
  try { harness.server.registryRef().queryAfterTombstone(created.operation_id); }
  catch (error) { expired = error.code === "RESULT_EXPIRED"; }
  check("tombstone-query-returns-result-expired", expired, "expired=" + expired);
  const recreated = await call(harness.server, "derive_coverage", { schema_version: "2.1", client_request_id: "cr_sweep_1", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", tier: "smoke" });
  check("expired-idempotency-key-can-be-recreated", recreated.kind === "accepted" && recreated.operation_id !== created.operation_id, "operation=" + recreated.operation_id);
  await close(harness);
}

// Handshake remains available after all control-plane wiring.
{
  const harness = await newHarness({ stepMs: 4 });
  const info = harness.server.serverInfo();
  check("server-info-handshake", Boolean(info.server_info) && info.server_info.name === "autopw-mcp", "name=" + (info.server_info && info.server_info.name));
  check("server-info-exposes-contract-tools", info.server_info.tools.includes("run_audit") && info.server_info.tools.includes("get_run_status"), "tools=" + info.server_info.tools.length);
  await close(harness);
}

console.log("\nM1 verify: " + passed + " passed, " + failed + " failed");
if (failed > 0) {
  console.log("BLOCKED — M1 Persistent Control Plane not satisfied.");
  process.exit(1);
}
console.log("OK — M1 Persistent Control Plane acceptance met.");
process.exit(0);
