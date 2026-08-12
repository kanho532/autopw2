import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const todo = await import(pathToFileURL(path.join(root, "apps", "todo-fixture-target", "dist", "index.js")).href);
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-cr-evidence-"));
const workspace = path.join(root, "apps", "todo-fixture-target");
const target = await todo.startTodoTarget();
let passed = 0;
let failed = 0;
function check(name, value, detail = "") { console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); if (value) passed += 1; else failed += 1; }
function output(result) { const value = result.content?.find((item) => item.type === "text")?.text || "{}"; try { return JSON.parse(value); } catch { return {}; } }

const trust = spawnSync(process.execPath, [path.join(root, "packages", "codex-plugin-runtime", "dist", "cli.js"), "trust", workspace, "--target", target.baseUrl], { env: { ...process.env, AUTOPW_CONFIG_HOME: configRoot }, encoding: "utf8" });
check("cr-evidence-workspace-trusted", trust.status === 0, trust.stderr.trim());
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "packages", "codex-plugin-runtime", "dist", "stdio.js")], env: { ...process.env, AUTOPW_CONFIG_HOME: configRoot }, stderr: "pipe" });
const client = new Client({ name: "autopw-cr-evidence-verifier", version: "1.0.0" });
let evidenceDir;
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const prepareTool = tools.tools.find((tool) => tool.name === "prepare_cr_evidence");
  check("prepare-cr-evidence-tool-exposed", Boolean(prepareTool));
  check("smoke-cannot-enter-cr-evidence-tool", JSON.stringify(prepareTool?.inputSchema || {}).includes('"fast"') && JSON.stringify(prepareTool?.inputSchema || {}).includes('"full"') && !JSON.stringify(prepareTool?.inputSchema || {}).includes('"smoke"'));
  const accepted = output(await client.callTool({ name: "run_audit", arguments: { workspace_path: workspace, base_tier: "fast" } }));
  let result = {};
  for (let attempt = 0; attempt < 300; attempt += 1) {
    result = output(await client.callTool({ name: "get_run_result", arguments: { workspace_path: workspace, run_id: accepted.run_handle } }));
    if (result.kind === "ok" || result.kind === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check("fast-run-terminal-before-cr-handoff", result.kind === "ok" || result.kind === "failed", JSON.stringify(result));
  const prepared = output(await client.callTool({ name: "prepare_cr_evidence", arguments: { workspace_path: workspace, run_id: accepted.run_handle, review_tier: "fast", project: "todo-fixture" } }));
  evidenceDir = prepared.evidence_dir;
  const manifest = prepared.manifest_path ? JSON.parse(fs.readFileSync(prepared.manifest_path, "utf8")) : {};
  check("fast-cr-evidence-is-checksummed-and-focused", prepared.kind === "ok" && prepared.review_tier === "fast" && prepared.artifact_count > 3 && manifest.cr_handoff?.required_phases?.includes("cr-evidence") && !manifest.cr_handoff?.required_phases?.includes("cr-technical-review") && manifest.cr_handoff?.authoritative_gate === "cr-gate", JSON.stringify(prepared));
  check("cr-evidence-does-not-render-formal-cr", !fs.existsSync(path.join(workspace, "CR", "todo-fixture")) && !Object.hasOwn(prepared, "formal_report"));
  const full = output(await client.callTool({ name: "prepare_cr_evidence", arguments: { workspace_path: workspace, run_id: accepted.run_handle, review_tier: "full", project: "todo-fixture" } }));
  const fullManifest = full.manifest_path ? JSON.parse(fs.readFileSync(full.manifest_path, "utf8")) : {};
  check("full-cr-evidence-routes-complete-lifecycle", full.kind === "ok" && fullManifest.cr_handoff?.required_phases?.includes("cr-branch-governance") && fullManifest.cr_handoff?.required_phases?.includes("cr-technical-review") && fullManifest.cr_handoff?.skipped_phases?.length === 0);
} finally {
  await client.close().catch(() => {});
  await target.close();
  fs.rmSync(configRoot, { recursive: true, force: true });
  if (evidenceDir && String(evidenceDir).startsWith(path.join(workspace, ".autopw", "cr-evidence"))) fs.rmSync(evidenceDir, { recursive: true, force: true });
}
console.log(`\nPlugin CR evidence verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
