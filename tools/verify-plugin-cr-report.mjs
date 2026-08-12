import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-cr-plugin-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-cr-workspace-"));
const nativeRoot = path.join(workspace, "CR", "native", "playwright");
fs.mkdirSync(path.join(nativeRoot, "html-report"), { recursive: true });
fs.mkdirSync(path.join(nativeRoot, "test-results", "failed-test"), { recursive: true });
fs.writeFileSync(path.join(nativeRoot, "html-report", "index.html"), "<!doctype html><title>Playwright</title>", "utf8");
fs.writeFileSync(path.join(nativeRoot, "test-results", "failed-test", "trace.zip"), "trace", "utf8");
fs.writeFileSync(path.join(nativeRoot, "results.json"), JSON.stringify({
  config: { configFile: path.join(workspace, "playwright.config.js") },
  suites: [{ title: "fixture.spec.js", file: path.join(workspace, "tests", "fixture.spec.js"), specs: [
    { title: "passes", ok: true, tests: [{ results: [{ status: "passed", attachments: [] }] }] },
    { title: "fails", ok: false, tests: [{ results: [{ status: "failed", errorLocation: { file: path.join(workspace, "tests", "fixture.spec.js"), line: 12, column: 3 }, attachments: [{ name: "trace", contentType: "application/zip", path: path.join(nativeRoot, "test-results", "failed-test", "trace.zip") }] }] }] },
  ] }], stats: { expected: 1, unexpected: 1, duration: 12 },
}, null, 2), "utf8");

let passed = 0; let failed = 0;
function check(name, value, detail = "") { console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); if (value) passed += 1; else failed += 1; }
function output(result) { const text = result.content?.find((item) => item.type === "text")?.text || "{}"; try { return JSON.parse(text); } catch { return {}; } }

const trust = spawnSync(process.execPath, [path.join(root, "packages", "codex-plugin-runtime", "dist", "cli.js"), "trust", workspace, "--target", "http://127.0.0.1:4173"], { env: { ...process.env, AUTOPW_CONFIG_HOME: configRoot }, encoding: "utf8" });
check("cr-report-fixture-trusted", trust.status === 0, trust.stderr.trim());
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "packages", "codex-plugin-runtime", "dist", "stdio.js")], env: { ...process.env, AUTOPW_CONFIG_HOME: configRoot }, stderr: "pipe" });
const client = new Client({ name: "autopw-cr-report-verifier", version: "1.0.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  check("cr-report-tool-is-exposed", tools.tools.some((tool) => tool.name === "generate_cr_report"));
  const result = output(await client.callTool({ name: "generate_cr_report", arguments: { workspace_path: workspace, project: "fixture", report_date: "2026-08-12", playwright_root: "CR/native/playwright" } }));
  check("cr-report-generates-formal-and-case-artifacts", result.kind === "ok" && result.gate === "blocked" && result.summary?.failed === 1 && fs.existsSync(result.report_paths?.formal) && fs.existsSync(result.report_paths?.case));
  check("cr-report-preserves-native-evidence", result.report_paths?.html === path.join(nativeRoot, "html-report", "index.html") && result.report_paths?.results === path.join(nativeRoot, "results.json") && result.trace_count === 1);
} finally {
  await client.close().catch(() => {});
  fs.rmSync(configRoot, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}
console.log(`\nPlugin CR report verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
