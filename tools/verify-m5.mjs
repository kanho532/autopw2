import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { newHarness, call } from "../apps/mcp-host-harness/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lease = await import(pathToFileURL(path.join(root, "packages", "worker", "dist", "lease.js")).href);
let passed = 0; let failed = 0;
function check(name, condition, detail = "") { if (condition) { passed += 1; console.log("PASS", name, detail ? " (" + detail + ")" : ""); } else { failed += 1; console.log("FAIL", name, detail); } }

const policy = lease.DEFAULT_LEASE_POLICY;
check("m5-lease-safety-factor", policy.lease_safety_factor >= 4);
check("m5-lease-ttl-invariant", policy.lease_ttl_ms >= policy.heartbeat_interval_ms * policy.lease_safety_factor);
check("m5-takeover-grace-invariant", policy.takeover_grace_ms >= policy.heartbeat_interval_ms * 2);
let current = lease.newLease("worker-a", 1, policy, 0);
const beforeGrace = lease.observeLease(current, policy.lease_ttl_ms + policy.takeover_grace_ms + policy.clock_skew_tolerance_ms - 1);
check("m5-no-early-stale", !lease.isLeaseStale(beforeGrace, policy.lease_ttl_ms + policy.takeover_grace_ms + policy.clock_skew_tolerance_ms - 1));
current = lease.observeLease(beforeGrace, policy.lease_ttl_ms + policy.takeover_grace_ms + policy.clock_skew_tolerance_ms + 1);
check("m5-first-stale-confirmation-not-enough", !lease.isLeaseStale(current, policy.lease_ttl_ms + policy.takeover_grace_ms + policy.clock_skew_tolerance_ms + 1));
current = lease.observeLease(current, policy.lease_ttl_ms + policy.takeover_grace_ms + policy.clock_skew_tolerance_ms + 2);
check("m5-consecutive-stale-confirmations-required", lease.isLeaseStale(current, policy.lease_ttl_ms + policy.takeover_grace_ms + policy.clock_skew_tolerance_ms + 2));
check("m5-live-worker-prohibits-takeover", !lease.isLeaseStale(current, Number.MAX_SAFE_INTEGER, { alive: true }));
check("m5-takeover-assigns-new-owner", lease.takeoverLease(current, "worker-b", 2, 100000, { alive: false })?.owner === "worker-b");

const harness = await newHarness({ stepMs: 4 });
try {
  const request = { schema_version: "2.1", client_request_id: "m5-durable-run", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast" };
  const accepted = await call(harness.server, "run_audit", request);
  let status;
  for (let i = 0; i < 120; i += 1) { status = await call(harness.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle }); if (status.phase === "GATED") break; await new Promise((resolve) => setTimeout(resolve, 25)); }
  const runDir = path.join(harness.dataRoot, "runs", accepted.run_handle);
  const state = JSON.parse(fs.readFileSync(path.join(runDir, "run_state.json"), "utf8"));
  check("m5-run-state-durable", status.phase === "GATED" && state.run_id === accepted.run_handle && state.state_version >= 1);
  check("m5-terminal-run-releases-lease", state.lease.owner === null && state.lease.expires_at === null);
  const checkpointDir = path.join(runDir, "checkpoints");
  check("m5-checkpoint-and-evidence-durable", fs.existsSync(path.join(runDir, "evidence-manifest.json")) && fs.existsSync(checkpointDir) && fs.readdirSync(checkpointDir).length >= 1);
  const cleanup1 = await call(harness.server, "cleanup_run", { schema_version: "2.1", client_request_id: "m5-cleanup-1", workspace_id: "ws_demo", run_id: accepted.run_handle });
  const cleanup2 = await call(harness.server, "cleanup_run", { schema_version: "2.1", client_request_id: "m5-cleanup-2", workspace_id: "ws_demo", run_id: accepted.run_handle });
  check("m5-cleanup-idempotent", cleanup1.kind === "accepted" && cleanup2.kind === "accepted");
  const result = await call(harness.server, "get_run_result", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle });
  check("m5-cleanup-does-not-change-gate", result.kind === "ok" && result.gate === "pass");
} finally { await harness.cleanup(); }

const cancelHarness = await newHarness({ stepMs: 20 });
try {
  const accepted = await call(cancelHarness.server, "run_audit", { schema_version: "2.1", client_request_id: "m5-cancel", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast" });
  await call(cancelHarness.server, "cancel_run", { schema_version: "2.1", client_request_id: "m5-cancel-op", workspace_id: "ws_demo", run_id: accepted.run_handle });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const status = await call(cancelHarness.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle });
  check("m5-cancel-is-incomplete-not-pass", status.phase === "GATED" && status.gate === "incomplete" && status.audit_status === "INCOMPLETE");
} finally { await cancelHarness.cleanup(); }

console.log(`\nM5 verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
