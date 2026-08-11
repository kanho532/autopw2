import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const todo = await import(pathToFileURL(path.join(root, "apps", "todo-fixture-target", "dist", "index.js")).href);
const { newHarness, call } = await import(pathToFileURL(path.join(root, "apps", "mcp-host-harness", "dist", "index.js")).href);
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-plugin-stdio-"));
const workspace = path.join(root, "apps", "todo-fixture-target");
const target = await todo.startTodoTarget();
let passed = 0; let failed = 0;
function check(name, value, detail = "") { console.log((value ? "PASS " : "FAIL ") + name + (detail ? " " + detail : "")); if (value) passed += 1; else failed += 1; }
function output(result) { const text = result.content?.find((item) => item.type === "text")?.text || "{}"; try { return JSON.parse(text); } catch { return {}; } }
async function connect(configRoot, name) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "packages", "codex-plugin-runtime", "dist", "stdio.js")], env: { ...process.env, AUTOPW_CONFIG_HOME: configRoot }, stderr: "pipe" });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}
async function terminate(client, transport) { if (transport.pid) process.kill(transport.pid, "SIGTERM"); await client.close().catch(() => {}); }
async function waitForOperation(client, workspacePath, operationId) {
  let status = {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = output(await client.callTool({ name: "get_operation_status", arguments: { workspace_path: workspacePath, operation_id: operationId } }));
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return status;
}
async function waitForTerminal(server, runId) {
  let status = {};
  for (let attempt = 0; attempt < 200; attempt += 1) {
    status = await call(server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: runId });
    if (status.phase === "GATED" || status.run_status === "FAILED") return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return status;
}
async function waitForWorkerOperation(server, operationId) {
  let status = {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = await call(server, "get_operation_status", { schema_version: "2.1", workspace_id: "ws_demo", operation_id: operationId });
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return status;
}
function staleRun(harness, requestId) {
  const operation = harness.server.registryRef().create({ tool: "run_audit", client_request_id: requestId, workspace_id: "ws_demo", kind: "run", params: { workspace_id: "ws_demo" } });
  const run = harness.server.workerRef().createFixtureRun({ workspace_id: "ws_demo", operation_id: operation.operation_id });
  run.phase = "RUNNING";
  harness.server.registryRef().updateRun(run, { operationStatus: "RUNNING" });
  harness.server.workerRef().simulateWorkerCrash(run.run_id);
  return run;
}
try {
  const cli = path.join(root, "packages", "codex-plugin-runtime", "dist", "cli.js");
  const { spawnSync } = await import("node:child_process");
  const trusted = spawnSync(process.execPath, [cli, "trust", workspace, "--target", target.baseUrl], { env: { ...process.env, AUTOPW_CONFIG_HOME: configRoot }, encoding: "utf8" });
  check("plugin-stdio-trust-cli", trusted.status === 0, trusted.stderr.trim());
  const { client } = await connect(configRoot, "autopw-plugin-verifier");
  try {
    const tools = await client.listTools();
    check("plugin-stdio-tools-list", ["autopw_status", "derive_coverage", "run_audit", "get_run_status", "get_run_result", "explain_run", "resume_run"].every((name) => tools.tools.some((tool) => tool.name === name)));
    const status = output(await client.callTool({ name: "autopw_status", arguments: { workspace_path: workspace } }));
    check("plugin-stdio-status-resolves-trust", status.trusted === true && status.target_configured === true);
    const accepted = output(await client.callTool({ name: "run_audit", arguments: { workspace_path: workspace, base_tier: "smoke" } }));
    check("plugin-stdio-run-is-accepted", accepted.kind === "accepted" && typeof accepted.run_handle === "string");
    let result = {};
    for (let attempt = 0; attempt < 200; attempt += 1) { result = output(await client.callTool({ name: "get_run_result", arguments: { workspace_path: workspace, run_id: accepted.run_handle } })); if (result.kind === "ok" || result.kind === "failed") break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    const finalStatus = output(await client.callTool({ name: "get_run_status", arguments: { workspace_path: workspace, run_id: accepted.run_handle } }));
    check("plugin-stdio-audit-e2e", result.kind === "ok" && result.gate === "pass" && result.audit_status === "COMPLETE", JSON.stringify({ result, finalStatus }));
  } finally { await client.close(); }

  const { client: firstRuntime, transport: firstTransport } = await connect(configRoot, "autopw-plugin-resume-origin");
  let interruptedRun;
  try {
    const accepted = output(await firstRuntime.callTool({ name: "run_audit", arguments: { workspace_path: workspace, base_tier: "smoke" } }));
    let active = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      active = output(await firstRuntime.callTool({ name: "get_run_status", arguments: { workspace_path: workspace, run_id: accepted.run_handle } }));
      if (active.run_status === "ACTIVE" && active.phase === "RUNNING") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    interruptedRun = accepted.run_handle;
    check("plugin-stdio-active-run-before-restart", accepted.kind === "accepted" && typeof interruptedRun === "string" && active.run_status === "ACTIVE" && active.phase === "RUNNING", JSON.stringify(active));
  } finally { await terminate(firstRuntime, firstTransport); }

  await new Promise((resolve) => setTimeout(resolve, 46_000));
  const { client: restartedRuntime } = await connect(configRoot, "autopw-plugin-resume-restarted");
  try {
    const firstResume = output(await restartedRuntime.callTool({ name: "resume_run", arguments: { workspace_path: workspace, run_id: interruptedRun, client_request_id: "plugin_resume_restart_1" } }));
    let result = {};
    let finalStatus = {};
    for (let attempt = 0; attempt < 300; attempt += 1) {
      result = output(await restartedRuntime.callTool({ name: "get_run_result", arguments: { workspace_path: workspace, run_id: interruptedRun } }));
      if (result.kind === "ok" || result.kind === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    finalStatus = output(await restartedRuntime.callTool({ name: "get_run_status", arguments: { workspace_path: workspace, run_id: interruptedRun } }));
    check("plugin-stdio-active-run-restart-resume", firstResume.kind === "accepted" && result.kind === "ok" && result.gate === "pass" && result.audit_status === "COMPLETE", JSON.stringify({ firstResume, finalStatus, result }));
  } finally { await restartedRuntime.close(); }

  const origin = await newHarness({ stepMs: 100 });
  const resumeDataRoot = origin.dataRoot;
  let restarted;
  try {
    const run = staleRun(origin, "plugin-resume-observation-origin");
    const initialVersion = run.lease.state_version;
    await origin.server.stop();
      const firstWorker = await newHarness({ dataRoot: resumeDataRoot, stepMs: 100 });
    try {
      const first = await call(firstWorker.server, "resume_run", { schema_version: "2.1", client_request_id: "plugin-resume-observation-1", workspace_id: "ws_demo", run_id: run.run_id });
      await waitForWorkerOperation(firstWorker.server, first.operation_id);
      const observedState = JSON.parse(fs.readFileSync(path.join(resumeDataRoot, "runs", run.run_id, "run_state.json"), "utf8"));
      check("worker-stale-observation-is-cas-persisted", first.kind === "accepted" && observedState.lease.stale_confirmations === 1 && observedState.lease.state_version === initialVersion + 1, JSON.stringify(observedState.lease));
      await firstWorker.server.stop();
      restarted = await newHarness({ dataRoot: resumeDataRoot, stepMs: 100 });
      const reloadedState = JSON.parse(fs.readFileSync(path.join(resumeDataRoot, "runs", run.run_id, "run_state.json"), "utf8"));
      check("worker-stale-observation-survives-restart", reloadedState.lease.stale_confirmations === 1, JSON.stringify(reloadedState.lease));
      const resumed = await call(restarted.server, "resume_run", { schema_version: "2.1", client_request_id: "plugin-resume-observation-2", workspace_id: "ws_demo", run_id: run.run_id });
      let takeoverState = {};
      for (let attempt = 0; attempt < 50; attempt += 1) {
        takeoverState = JSON.parse(fs.readFileSync(path.join(resumeDataRoot, "runs", run.run_id, "run_state.json"), "utf8"));
        if (takeoverState.resume_attempts === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const terminal = await waitForTerminal(restarted.server, run.run_id);
      check("worker-second-observation-takes-over", resumed.kind === "accepted" && takeoverState.lease?.owner === restarted.server.workerRef().workerId && takeoverState.lease?.state_version > reloadedState.lease.state_version && takeoverState.resume_attempts === 1 && terminal.phase === "GATED", JSON.stringify({ takeoverState: takeoverState.lease, resume_attempts: takeoverState.resume_attempts, terminal }));
    } finally {
      if (restarted) await restarted.cleanup();
      else await firstWorker.cleanup();
    }
  } catch (error) { check("worker-durable-resume", false, error instanceof Error ? error.message : String(error)); }

  const liveOwner = await newHarness({ stepMs: 100 });
  try {
    const run = liveOwner.server.workerRef().createFixtureRun({ workspace_id: "ws_demo", operation_id: liveOwner.server.registryRef().create({ tool: "run_audit", client_request_id: "plugin-live-owner-source", workspace_id: "ws_demo", kind: "run", params: { workspace_id: "ws_demo" } }).operation_id });
    run.phase = "RUNNING";
    liveOwner.server.auditRuntime.storage.writeJson(run.run_id, "run_state.json", run);
    liveOwner.server.registryRef().updateRun(run, { operationStatus: "RUNNING" });
    const contender = await newHarness({ dataRoot: liveOwner.dataRoot, stepMs: 100 });
    try {
      const first = await call(contender.server, "resume_run", { schema_version: "2.1", client_request_id: "plugin-live-owner-resume-1", workspace_id: "ws_demo", run_id: run.run_id });
      const second = await call(contender.server, "resume_run", { schema_version: "2.1", client_request_id: "plugin-live-owner-resume-2", workspace_id: "ws_demo", run_id: run.run_id });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const state = JSON.parse(fs.readFileSync(path.join(liveOwner.dataRoot, "runs", run.run_id, "run_state.json"), "utf8"));
      check("worker-live-owner-cannot-be-taken-over", first.kind === "accepted" && second.kind === "accepted" && state.lease.owner === liveOwner.server.workerRef().workerId && state.resume_attempts === 0, JSON.stringify(state.lease));
    } finally { await contender.server.stop(); }
  } finally { await liveOwner.cleanup(); }
} finally { await target.close(); fs.rmSync(configRoot, { recursive: true, force: true }); }
console.log(`\nPlugin STDIO verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
