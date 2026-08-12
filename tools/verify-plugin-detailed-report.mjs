import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-detailed-report-config-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-detailed-report-workspace-"));
let passed = 0; let failed = 0;
function check(name, value, detail = "") { console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? " " + detail : ""}`); if (value) passed += 1; else failed += 1; }
function output(result) { const text = result.content?.find((item) => item.type === "text")?.text || "{}"; try { return JSON.parse(text); } catch { return {}; } }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + "\n"); }

write(path.join(workspace, "src", "api.ts"), "export function createTodo() {\n  return router.post('/api/todos', handler);\n}\n");
const trust = spawnSync(process.execPath, [path.join(root, "packages", "codex-plugin-runtime", "dist", "cli.js"), "trust", workspace, "--target", "http://127.0.0.1:4173"], { env: { ...process.env, AUTOPW_CONFIG_HOME: configRoot }, encoding: "utf8" });
check("detailed-report-workspace-trusted", trust.status === 0, trust.stderr.trim());
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "packages", "codex-plugin-runtime", "dist", "stdio.js")], env: { ...process.env, AUTOPW_CONFIG_HOME: configRoot }, stderr: "pipe" });
const client = new Client({ name: "autopw-detailed-report-verifier", version: "1.0.0" });
try {
  await client.connect(transport);
  const status = output(await client.callTool({ name: "autopw_status", arguments: { workspace_path: workspace } }));
  const runId = "run_detailed_fixture";
  const runRoot = path.join(configRoot, "runs", status.workspace_id, "runs", runId);
  const trace = Buffer.from("native-playwright-trace-fixture");
  const traceHash = crypto.createHash("sha256").update(trace).digest("hex");
  const handle = "art_" + "a".repeat(64);
  const traceRelative = `cases/case_create/artifacts/${handle}.zip`;
  write(path.join(runRoot, "plan.json"), { plan_schema: "autopw.test-plan/1.1", plan_id: "fixture", generated_at: "2026-08-12T00:00:00.000Z", origin: { type: "generated", source_ref: "fixture" }, coverage_eligible: true, cases: [{ case_id: "case_create", title: "创建待办", feature_id: "todo.create", requirement_refs: ["req_create"], scenario: "normal", priority: "P0", effective_tier: "fast", kind: "api", risk: "mutating", confidence: 0.92, execution_policy: { production_allowed: false }, setup: [{ action: "api_request", method: "POST", path: "/api/todos", body: { title: "fixture" }, save_as: "create" }], steps: [{ action: "expect_status", source: "create", equals: 201 }], cleanup: [] }] });
  write(path.join(runRoot, "execution-results.json"), [{ execution_id: "exec_case_create", case_id: "case_create", status: "FAILED", browser: "chromium", viewport: { width: 1280, height: 720 }, locale: "zh-CN", classification: "PRODUCT_DEFECT", error: "expect_status failed", failure_signal: { code: "ASSERT_STATUS", kind: "assertion", phase: "test", action: "expect_status", expected: 201, actual: 404 }, path: [{ step_index: 0, phase: "setup", action: "api_request", endpoint_ref: "POST /api/todos", status: "PASSED", duration_ms: 18, output_summary: { status: 404 }, evidence_refs: [{ handle, kind: "playwright-trace" }] }, { step_index: 1, phase: "test", action: "expect_status", status: "FAILED", duration_ms: 1, error: "expected 201, received 404", evidence_refs: [] }], evidence_refs: [{ handle, kind: "playwright-trace" }] }]);
  write(path.join(runRoot, "artifacts", "results.json"), { schema_version: "2.1", run_id: runId, gate: "fail", audit_status: "COMPLETE", summary: { total_cases: 1, passed: 0, failed: 1, blocked: 0 }, issues: [{ execution_id: "exec_case_create", classification: "PRODUCT_DEFECT", message: "expected 201, received 404", failure_signal: { code: "ASSERT_STATUS", actual: 404 } }] });
  write(path.join(runRoot, "requirement-coverage.json"), { required: 1, planned: 1, executed: 1, passed: 0 });
  write(path.join(runRoot, "discovery.json"), { facts: [{ fact_id: "fact_create", source_kind: "AST", source_ref: { path: "src/api.ts", line: 2 } }] });
  write(path.join(runRoot, "derivation.json"), { cdd: { requirements: [{ requirement_id: "req_create", source_refs: ["fact_create"] }] } });
  write(path.join(runRoot, "artifact-index.json"), { schema_version: "1.0", artifacts: { [handle]: { relative_path: traceRelative, kind: "playwright-trace", size_bytes: trace.length, sha256: traceHash, display_name: "trace.zip" } } });
  write(path.join(runRoot, traceRelative), trace);

  const tools = await client.listTools();
  check("detailed-report-tool-exposed", tools.tools.some((tool) => tool.name === "export_run_report" && tool.description?.includes("concise cause analysis")));
  const result = output(await client.callTool({ name: "export_run_report", arguments: { workspace_path: workspace, run_id: runId } }));
  const markdown = fs.readFileSync(result.report_paths?.markdown || "missing", "utf8");
  check("detailed-report-colocates-delivery", result.kind === "ok" && result.export_dir === path.join(workspace, ".autopw", "reports", runId) && Object.values(result.report_paths || {}).every((file) => fs.existsSync(file)), JSON.stringify(result));
  check("detailed-report-records-operation-flow", markdown.includes("具体操作流程") && markdown.includes("POST /api/todos") && markdown.includes("expected 201, received 404"));
  check("detailed-report-keeps-cause-concise", markdown.split("请求路径或前置资源与当前实现不一致。").length === 2 && !markdown.includes("鉴权状态或权限范围与测试前提不一致。"));
  check("detailed-report-records-code-location", markdown.includes("src/api.ts:2"));
  check("detailed-report-exports-playwright-evidence", fs.existsSync(path.join(result.export_dir, "playwright-report", "test-results", "case_create", "trace.zip")) && fs.readFileSync(result.report_paths.playwright, "utf8").includes("npx playwright show-trace"));
  check("detailed-report-manifest-hashes-output", JSON.parse(fs.readFileSync(result.report_paths.manifest, "utf8")).files.some((item) => item.path === "playwright-report/test-results/case_create/trace.zip" && item.sha256 === traceHash));
} finally {
  await client.close().catch(() => {});
  fs.rmSync(configRoot, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}
console.log(`\nPlugin detailed report verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
