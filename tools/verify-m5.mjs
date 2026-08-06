import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { newHarness, call } from "../apps/mcp-host-harness/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lease = await import(pathToFileURL(path.join(root, "packages", "worker", "dist", "lease.js")).href);
const { RunStorage } = await import(pathToFileURL(path.join(root, "packages", "run-storage", "dist", "index.js")).href);
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

const casRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m5-cas-"));
try {
  const storage = new RunStorage(casRoot); const runId = "run_cas";
  storage.writeJson(runId, "run_state.json", { run_id: runId, lease: { state_version: 1 }, value: "old" });
  const lock = path.join(storage.runDir(runId), "run_state.json.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, created_at: Date.now() - 120000 }), "utf8");
  const recovered = storage.compareAndSwapJson(runId, "run_state.json", 1, (value) => ({ ...value, lease: { state_version: 2 }, value: "recovered" }));
  check("m5-orphan-cas-lock-is-reclaimed", recovered?.value === "recovered" && !fs.existsSync(lock));
  const winner = storage.compareAndSwapJson(runId, "run_state.json", 2, (value) => ({ ...value, lease: { state_version: 3 }, winner: "one" }));
  const loser = storage.compareAndSwapJson(runId, "run_state.json", 2, (value) => ({ ...value, lease: { state_version: 3 }, winner: "two" }));
  check("m5-cas-has-single-winner", winner?.winner === "one" && loser === undefined);
} finally { fs.rmSync(casRoot, { recursive: true, force: true }); }

const raceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m5-cas-race-"));
try {
  const raceStorage = new RunStorage(raceRoot); const raceRun = "run_race";
  raceStorage.writeJson(raceRun, "run_state.json", { run_id: raceRun, lease: { state_version: 1 } });
  const storageUrl = pathToFileURL(path.join(root, "packages", "run-storage", "dist", "index.js")).href;
  const raceScript = `import { RunStorage } from ${JSON.stringify(storageUrl)}; const storage = new RunStorage(process.argv[1]); const result = storage.compareAndSwapJson("run_race", "run_state.json", 1, (value) => ({ ...value, lease: { state_version: 2 }, winner: process.pid })); process.stdout.write(result ? "winner" : "loser");`;
  const runChild = () => new Promise((resolve) => { const child = spawn(process.execPath, ["--input-type=module", "-e", raceScript, raceRoot], { stdio: ["ignore", "pipe", "pipe"] }); let output = ""; child.stdout.on("data", (chunk) => { output += chunk.toString(); }); child.on("close", (code) => resolve(code === 0 ? output : "error")); });
  const outcomes = await Promise.all([runChild(), runChild()]);
  check("m5-cross-process-cas-has-single-winner", outcomes.filter((value) => value === "winner").length === 1 && outcomes.filter((value) => value === "loser").length === 1, outcomes.join(","));
} finally { fs.rmSync(raceRoot, { recursive: true, force: true }); }

const harness = await newHarness({ stepMs: 4 });
try {
  const request = { schema_version: "2.1", client_request_id: "m5-durable-run", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast" };
  const accepted = await call(harness.server, "run_audit", request);
  let status;
  for (let i = 0; i < 200; i += 1) { status = await call(harness.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle }); if (status.phase === "GATED" || status.run_status === "FAILED") break; await new Promise((resolve) => setTimeout(resolve, 50)); }
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

const recoveryHarness = await newHarness({ stepMs: 20 });
const recoveryDataRoot = recoveryHarness.dataRoot;
try {
  const accepted = await call(recoveryHarness.server, "run_audit", { schema_version: "2.1", client_request_id: "m5-recovery", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast" });
  recoveryHarness.server.workerRef().simulateWorkerCrash(accepted.run_handle);
  await recoveryHarness.server.stop();
  const restarted = await newHarness({ dataRoot: recoveryDataRoot, stepMs: 4 });
  try {
    const worker = restarted.server.workerRef();
    worker.observeRunLease(accepted.run_handle);
    worker.observeRunLease(accepted.run_handle);
    const resumed = await call(restarted.server, "resume_run", { schema_version: "2.1", client_request_id: "m5-recovery-resume", workspace_id: "ws_demo", run_id: accepted.run_handle });
    let status;
    for (let i = 0; i < 200; i += 1) { status = await call(restarted.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle }); if (status.phase === "GATED" || status.run_status === "FAILED") break; await new Promise((resolve) => setTimeout(resolve, 50)); }
    check("m5-stale-run-resumes-through-mcp", resumed.kind === "accepted" && status.phase === "GATED" && status.gate === "pass");
    check("m5-worker-restart-restores-interrupted-run", status.run_status === "COMPLETED" && status.next_action === "get_run_result");
  } finally { await restarted.cleanup(); }
} catch (error) { check("m5-stale-run-resumes-through-mcp", false, error instanceof Error ? error.message : String(error)); }

const exhaustedHarness = await newHarness({ stepMs: 4 });
try {
  const operation = exhaustedHarness.server.registryRef().create({ tool: "run_audit", client_request_id: "m5-exhausted-source", workspace_id: "ws_demo", kind: "run", params: { workspace_id: "ws_demo" } });
  const run = exhaustedHarness.server.workerRef().createFixtureRun({ workspace_id: "ws_demo", operation_id: operation.operation_id });
  run.phase = "RUNNING"; run.run_status = "INTERRUPTED"; run.resume_attempts = 3; run.lease.heartbeat_at = Date.now() - run.lease.policy.lease_ttl_ms - run.lease.policy.takeover_grace_ms - run.lease.policy.clock_skew_tolerance_ms - 1;
  exhaustedHarness.server.auditRuntime.storage.writeJson(run.run_id, "run_state.json", run);
  exhaustedHarness.server.registryRef().updateRun(run, { operationStatus: "RUNNING" });
  const resume = await call(exhaustedHarness.server, "resume_run", { schema_version: "2.1", client_request_id: "m5-exhausted-resume", workspace_id: "ws_demo", run_id: run.run_id });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const status = await call(exhaustedHarness.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: run.run_id });
  const result = await call(exhaustedHarness.server, "get_run_result", { schema_version: "2.1", workspace_id: "ws_demo", run_id: run.run_id });
  check("m5-max-resume-is-incomplete-not-planner-defect", resume.kind === "accepted" && status.phase === "GATED" && status.gate === "incomplete" && result.gate_summary?.reason === "resume attempts exhausted", JSON.stringify(result));
} finally { await exhaustedHarness.cleanup(); }

const crashHarness = await newHarness({ stepMs: 4 });
try {
  const crashStates = [];
  for (let i = 0; i < 100; i += 1) {
    const operation = crashHarness.server.registryRef().create({ tool: "run_audit", client_request_id: "m5-crash-" + i, workspace_id: "ws_demo", kind: "run", params: { workspace_id: "ws_demo" } });
    const run = crashHarness.server.workerRef().createFixtureRun({ workspace_id: "ws_demo", operation_id: operation.operation_id });
    crashHarness.server.registryRef().updateRun(run, { operationStatus: "RUNNING" });
    crashHarness.server.workerRef().simulateWorkerCrash(run.run_id);
    crashStates.push(JSON.parse(fs.readFileSync(path.join(crashHarness.dataRoot, "runs", run.run_id, "run_state.json"), "utf8")));
  }
  check("m5-100-crash-injections-have-no-completed-pending-run", crashStates.length === 100 && crashStates.every((state) => state.run_status === "INTERRUPTED" && state.phase !== "GATED"));
} finally { await crashHarness.cleanup(); }

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
