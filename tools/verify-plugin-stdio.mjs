import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const todo = await import(pathToFileURL(path.join(root, "apps", "todo-fixture-target", "dist", "index.js")).href);
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-plugin-stdio-"));
const workspace = path.join(root, "apps", "todo-fixture-target");
const target = await todo.startTodoTarget();
let passed = 0; let failed = 0;
function check(name, value, detail = "") { console.log((value ? "PASS " : "FAIL ") + name + (detail ? " " + detail : "")); if (value) passed += 1; else failed += 1; }
function output(result) { const text = result.content?.find((item) => item.type === "text")?.text || "{}"; try { return JSON.parse(text); } catch { return {}; } }
try {
  const cli = path.join(root, "packages", "codex-plugin-runtime", "dist", "cli.js");
  const { spawnSync } = await import("node:child_process");
  const trusted = spawnSync(process.execPath, [cli, "trust", workspace, "--target", target.baseUrl], { env: { ...process.env, AUTOPW_CONFIG_HOME: configRoot }, encoding: "utf8" });
  check("plugin-stdio-trust-cli", trusted.status === 0, trusted.stderr.trim());
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "packages", "codex-plugin-runtime", "dist", "stdio.js")], env: { ...process.env, AUTOPW_CONFIG_HOME: configRoot }, stderr: "pipe" });
  const client = new Client({ name: "autopw-plugin-verifier", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    check("plugin-stdio-tools-list", ["autopw_status", "derive_coverage", "run_audit", "get_run_status", "get_run_result", "explain_run"].every((name) => tools.tools.some((tool) => tool.name === name)));
    const status = output(await client.callTool({ name: "autopw_status", arguments: { workspace_path: workspace } }));
    check("plugin-stdio-status-resolves-trust", status.trusted === true && status.target_configured === true);
    const accepted = output(await client.callTool({ name: "run_audit", arguments: { workspace_path: workspace, base_tier: "smoke" } }));
    check("plugin-stdio-run-is-accepted", accepted.kind === "accepted" && typeof accepted.run_handle === "string");
    let result = {};
    for (let attempt = 0; attempt < 200; attempt += 1) { result = output(await client.callTool({ name: "get_run_result", arguments: { workspace_path: workspace, run_id: accepted.run_handle } })); if (result.kind === "ok" || result.kind === "failed") break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    const finalStatus = output(await client.callTool({ name: "get_run_status", arguments: { workspace_path: workspace, run_id: accepted.run_handle } }));
    check("plugin-stdio-audit-e2e", result.kind === "ok" && result.gate === "pass" && result.audit_status === "COMPLETE", JSON.stringify({ result, finalStatus }));
  } finally { await client.close(); }
} finally { await target.close(); fs.rmSync(configRoot, { recursive: true, force: true }); }
console.log(`\nPlugin STDIO verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
