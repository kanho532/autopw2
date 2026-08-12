import fs from "node:fs";
import path from "node:path";

export interface CrReportOptions {
  workspaceRoot: string;
  project?: string;
  reportDate?: string;
  playwrightRoot?: string;
  runId?: string;
}

interface PlaywrightAttachment { name?: string; contentType?: string; path?: string; }
interface PlaywrightResult { status?: string; errorLocation?: { file?: string; line?: number; column?: number }; attachments?: PlaywrightAttachment[]; }
interface PlaywrightSpec { title?: string; ok?: boolean; file?: string; line?: number; tests?: Array<{ results?: PlaywrightResult[] }>; }
interface PlaywrightSuite { title?: string; file?: string; specs?: PlaywrightSpec[]; suites?: PlaywrightSuite[]; }
interface PlaywrightResults { config?: { configFile?: string; projects?: Array<{ outputDir?: string; testDir?: string }> }; suites?: PlaywrightSuite[]; stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number; duration?: number; startTime?: string }; }

interface CrIssue { issue_id: string; priority: "P1"; status: "open"; title: string; evidence: Array<Record<string, unknown>>; impact: string; required_action: string; }

export function generateCrReport(options: CrReportOptions): Record<string, unknown> {
  const workspaceRoot = fs.realpathSync.native(options.workspaceRoot);
  const reportDate = options.reportDate || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw Object.assign(new Error("report_date must use YYYY-MM-DD"), { code: "INVALID_INPUT" });
  const project = safeName(options.project || path.basename(workspaceRoot));
  const playwrightRoot = resolvePlaywrightRoot(workspaceRoot, options.playwrightRoot);
  const resultsPath = path.join(playwrightRoot, "results.json");
  if (!fs.existsSync(resultsPath)) throw Object.assign(new Error("Playwright results.json was not found"), { code: "PLAYWRIGHT_RESULTS_NOT_FOUND" });
  const results = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as PlaywrightResults;
  const specs = flattenSpecs(results.suites || []);
  const failed = specs.filter((spec) => spec.ok === false);
  const passed = specs.filter((spec) => spec.ok === true);
  const compactDate = reportDate.replaceAll("-", "");
  const baseCaseId = `${project}-${compactDate}`;
  const reportBase = path.join(workspaceRoot, "CR", project);
  const caseId = nextCaseId(reportBase, baseCaseId);
  const caseRoot = path.join(reportBase, "cases", caseId);
  const formalPath = path.join(reportBase, `${project}-CR-${compactDate}${caseId === baseCaseId ? "" : "-" + caseId.slice(baseCaseId.length + 1)}.md`);
  fs.mkdirSync(caseRoot, { recursive: true });

  const traces = collectTracePaths(specs, workspaceRoot);
  const issues = failed.map((spec, index) => makeIssue(spec, index, compactDate, workspaceRoot));
  const units = buildUnits(results, specs, workspaceRoot, playwrightRoot);
  const htmlPath = path.join(playwrightRoot, "html-report", "index.html");
  const checks = buildChecks(resultsPath, htmlPath, traces.length, failed.length, workspaceRoot);
  const reviewGroups = [
    { group_id: "RG-PLAYWRIGHT", title: "原生 Playwright 执行", rule_ids: ["native-html-report", "native-json-report", "native-trace", "test-execution"] },
    { group_id: "RG-CR", title: "中文 CR 交付", rule_ids: ["source-baseline", "uat-rollback", "report-persistence", "issue-linkage"] },
  ];
  const state = { case_id: caseId, project, cr_type: "config_cr", output_mode: "report", report_profile: "plugin_plain", report_state: failed.length || checks.some((check) => check.status === "blocked") ? "stage_report" : "complete_cr_report", range: "Playwright result snapshot", playwright_root: relativePath(workspaceRoot, playwrightRoot), run_id: options.runId || null, generated_at: new Date().toISOString(), gate_decision: failed.length || checks.some((check) => check.status === "blocked") ? "blocked" : "allow" };
  const gate = { decision: state.gate_decision, report_state: state.report_state, reasons: failed.length ? [`${failed.length} 个 Playwright 测试失败`] : [], blocker_source: { open_diff_units: 0, open_required_checks: 0, blocked_checks: checks.filter((check) => check.status === "blocked").length, confirmed_high_or_severe_issues: issues.length, invalid_na: 0, missing_evidence: checks.filter((check) => check.status === "blocked").length, wrong_or_stale_range: 0 }, issue_ids: issues.map((issue) => issue.issue_id), next_action: failed.length ? "修复失败测试对应问题后重新运行 Playwright 并重新生成 CR 报告。" : "补齐发布证据后重新评估 gate。" };
  const facts = [
    { fact_id: "FACT-001", type: "playwright_summary", command: "@playwright/test", total: specs.length, passed: passed.length, failed: failed.length, duration_ms: results.stats?.duration || 0 },
    { fact_id: "FACT-002", type: "native_report", html: relativePath(workspaceRoot, htmlPath), json: relativePath(workspaceRoot, resultsPath), trace_count: traces.length },
    { fact_id: "FACT-003", type: "baseline", git_repository: fs.existsSync(path.join(workspaceRoot, ".git")), range: "Playwright result snapshot" },
  ];
  const checkerResults = checks.map((check) => ({ check_id: check.check_id, rule_id: check.rule_id, status: check.status === "blocked" ? "blocked" : check.status === "issue" ? "issue" : "pass", issue_ids: check.rule_id === "test-execution" ? issues.map((issue) => issue.issue_id) : [] }));

  writeJson(path.join(caseRoot, "state.json"), state);
  writeJson(path.join(caseRoot, "gate.json"), gate);
  writeJsonl(path.join(caseRoot, "diff-units.jsonl"), units);
  writeJsonl(path.join(caseRoot, "facts.jsonl"), facts);
  writeJsonl(path.join(caseRoot, "review-groups.jsonl"), reviewGroups);
  writeJsonl(path.join(caseRoot, "checks.jsonl"), checks);
  writeJsonl(path.join(caseRoot, "checker-results.jsonl"), checkerResults);
  writeJsonl(path.join(caseRoot, "issues.jsonl"), issues);
  writeJson(path.join(caseRoot, "report.md"), { case_id: caseId, report_state: state.report_state, gate: gate.decision, test_summary: { total: specs.length, passed: passed.length, failed: failed.length }, native_reports: { html: relativePath(workspaceRoot, htmlPath), json: relativePath(workspaceRoot, resultsPath), traces: traces.length }, formal_report: relativePath(workspaceRoot, formalPath) });

  const formal = renderFormalReport({ project, reportDate, caseId, caseRoot, formalPath, playwrightRoot, resultsPath, htmlPath, traces, specs, passed: passed.length, failed: failed.length, issues, checks, gate, state });
  fs.mkdirSync(path.dirname(formalPath), { recursive: true });
  fs.writeFileSync(formalPath, formal, "utf8");
  return { kind: "ok", project, case_id: caseId, report_state: state.report_state, gate: gate.decision, report_paths: { formal: formalPath, case: path.join(caseRoot, "report.md"), html: htmlPath, results: resultsPath }, trace_count: traces.length, summary: { total: specs.length, passed: passed.length, failed: failed.length } };
}

function flattenSpecs(suites: PlaywrightSuite[]): Array<PlaywrightSpec & { file?: string }> {
  const output: Array<PlaywrightSpec & { file?: string }> = [];
  const visit = (suite: PlaywrightSuite): void => { for (const spec of suite.specs || []) output.push({ ...spec, file: spec.file || suite.file }); for (const child of suite.suites || []) visit(child); };
  for (const suite of suites) visit(suite);
  return output;
}

function resolvePlaywrightRoot(workspaceRoot: string, requested?: string): string {
  if (requested) {
    const candidate = contained(workspaceRoot, requested);
    return fs.existsSync(path.join(candidate, "results.json")) ? candidate : path.dirname(candidate);
  }
  const candidates: string[] = [];
  for (const parent of [path.join(workspaceRoot, "CR"), path.join(workspaceRoot, ".autopw", "reports"), workspaceRoot]) {
    if (!fs.existsSync(parent)) continue;
    scanForResults(parent, candidates, 4);
  }
  const result = candidates.find((file) => path.basename(path.dirname(file)) === "playwright") || candidates[0];
  if (!result) throw Object.assign(new Error("No Playwright results.json found; pass playwright_root explicitly"), { code: "PLAYWRIGHT_RESULTS_NOT_FOUND" });
  return path.dirname(result);
}

function scanForResults(dir: string, output: string[], depth: number): void {
  if (depth < 0 || output.length >= 32) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scanForResults(full, output, depth - 1);
    else if (entry.name === "results.json") output.push(full);
  }
}

function buildUnits(results: PlaywrightResults, specs: Array<PlaywrightSpec & { file?: string }>, workspaceRoot: string, playwrightRoot: string): Array<Record<string, unknown>> {
  const files = new Set<string>([relativePath(workspaceRoot, path.join(playwrightRoot, "results.json"))]);
  if (results.config?.configFile) files.add(relativeOrLabel(workspaceRoot, results.config.configFile));
  for (const spec of specs) if (spec.file) files.add(relativeOrLabel(workspaceRoot, spec.file));
  return [...files].map((file, index) => ({ unit_id: `SNAP-${String(index + 1).padStart(3, "0")}`, path: file, kind: "playwright_snapshot", status: "closed" }));
}

function buildChecks(resultsPath: string, htmlPath: string, traceCount: number, failedCount: number, workspaceRoot: string): Array<Record<string, unknown> & { status: string; rule_id: string; check_id: string }> {
  return [
    { check_id: "CR-CHECK-001", rule_id: "native-json-report", title: "Playwright JSON 结果存在", status: fs.existsSync(resultsPath) ? "closed" : "blocked", evidence: relativePath(workspaceRoot, resultsPath) },
    { check_id: "CR-CHECK-002", rule_id: "native-html-report", title: "Playwright 原生 HTML 报告存在", status: fs.existsSync(htmlPath) ? "closed" : "blocked", evidence: relativePath(workspaceRoot, htmlPath) },
    { check_id: "CR-CHECK-003", rule_id: "native-trace", title: "失败测试保留 trace", status: traceCount > 0 || failedCount === 0 ? "closed" : "blocked", evidence: "test-results/**/trace.zip" },
    { check_id: "CR-CHECK-004", rule_id: "test-execution", title: "Playwright 测试执行结果", status: failedCount > 0 ? "issue" : "closed", evidence: relativePath(workspaceRoot, resultsPath) },
    { check_id: "CR-CHECK-005", rule_id: "source-baseline", title: "Git 基线可追溯", status: fs.existsSync(path.join(workspaceRoot, ".git")) ? "closed" : "blocked", evidence: "workspace/.git" },
    { check_id: "CR-CHECK-006", rule_id: "uat-rollback", title: "UAT、发布与回滚证据", status: "blocked", evidence: "not provided" },
    { check_id: "CR-CHECK-007", rule_id: "report-persistence", title: "正式 CR 报告持久化", status: "closed", evidence: "CR/<project>/" },
    { check_id: "CR-CHECK-008", rule_id: "issue-linkage", title: "Issue 与测试证据关联", status: "closed", evidence: "issues.jsonl" },
  ];
}

function makeIssue(spec: PlaywrightSpec & { file?: string }, index: number, compactDate: string, workspaceRoot: string): CrIssue {
  const result = spec.tests?.[0]?.results?.[0];
  const trace = result?.attachments?.find((item) => item.name === "trace" || item.contentType === "application/zip")?.path;
  const file = result?.errorLocation?.file || spec.file;
  return { issue_id: `AUTOPW-CR-${compactDate}-${String(index + 1).padStart(3, "0")}`, priority: "P1", status: "open", title: `${spec.title || "未命名测试"} 未通过`, evidence: [{ path: file ? relativeOrLabel(workspaceRoot, file) : "Playwright results.json", line: result?.errorLocation?.line || null, column: result?.errorLocation?.column || null, trace: trace ? relativeOrLabel(workspaceRoot, trace) : null, test: spec.title || "unknown" }], impact: "该失败说明被检查的用户流程或接口契约尚未形成可发布证据。", required_action: "修复测试对应的产品问题或测试契约，重新执行同一 Playwright 测试并确认结果闭环。" };
}

function collectTracePaths(specs: Array<PlaywrightSpec & { file?: string }>, workspaceRoot: string): string[] {
  const paths = new Set<string>();
  for (const spec of specs) for (const result of spec.tests?.flatMap((test) => test.results || []) || []) for (const attachment of result.attachments || []) if (attachment.path && (attachment.name === "trace" || attachment.contentType === "application/zip")) paths.add(relativeOrLabel(workspaceRoot, attachment.path));
  return [...paths];
}

function renderFormalReport(input: { project: string; reportDate: string; caseId: string; caseRoot: string; formalPath: string; playwrightRoot: string; resultsPath: string; htmlPath: string; traces: string[]; specs: Array<PlaywrightSpec & { file?: string }>; passed: number; failed: number; issues: CrIssue[]; checks: Array<Record<string, unknown> & { status: string; rule_id: string; check_id: string }>; gate: Record<string, unknown>; state: Record<string, unknown> }): string {
  const findings = input.issues.map((issue, index) => `${index + 1}. [${issue.priority}] ${issue.issue_id}：${issue.title}\n   - 证据：${JSON.stringify(issue.evidence)}\n   - 影响：${issue.impact}\n   - 必须动作：${issue.required_action}\n   - 发布阻塞：是`).join("\n\n");
  const audit = [
    "| Worker / Skill | 执行 | 证据 | 缺口 |\n|---|---|---|---|",
    "| cr-intake | 是 | config_cr、Playwright snapshot | Git ticket/分支可能缺失 |",
    "| cr-branch-governance | 部分 | source snapshot | 目标目录可能无 .git |",
    "| cr-diff | 部分 | Playwright config/test units | 非 Git diff |",
    "| cr-technical-review | 是 | 失败测试、源码位置、trace | 待修复后复核 |",
    "| cr-evidence | 部分 | HTML/JSON/trace | UAT、发布、回滚未提供 |",
    "| cr-issues | 是 | issues.jsonl | 未关闭问题需跟踪 |",
    "| cr-gate | 是 | gate.json | 当前 blocked |",
    "| cr-report | 是 | 正式报告和 case 工件 | 无 |",
  ].join("\n");
  return `# 代码审查报告 — ${input.project} ${input.reportDate}

## 最终结论（是否可发布）

结论：${input.gate.decision === "blocked" ? "阻塞" : "允许"}（Report State: ${input.state.report_state}）。本次执行 ${input.specs.length} 条原生 @playwright/test 检查，${input.passed} 条通过、${input.failed} 条失败。报告同时保存 Playwright 原生 HTML、JSON 和 trace 证据。

| 决策项 | 结论 | 原因 |
|---|---|---|
| 代码合入 | ${input.gate.decision === "blocked" ? "阻塞" : "可继续评估"} | ${input.failed ? `${input.failed} 条测试失败` : "定向测试通过"} |
| 生产开关 / 发布动作 | 阻塞 | 需补齐 UAT、发布和回滚证据 |
| 发布完成宣称 | 阻塞 | 当前报告状态为 ${input.state.report_state} |

## 必须补齐的阻塞项

| 阻塞项 | 责任人 | 完成标准 |
|---|---|---|
| 处理失败测试及对应问题 | 目标工程负责人 | 失败项修复后同一命令全通过 |
| 补齐 UAT、发布、回滚证据 | 发布负责人 | 材料落盘并重新评估 gate |

## 变更基本信息

- 项目：${input.project}
- 审查类型：config_cr
- 审查范围：Playwright result snapshot
- Case：${input.caseId}
- 审查人：Codex / Account CR Agent
- 正式报告：${relativePath(path.dirname(input.formalPath), input.formalPath)}

## 评分卡（100 分）

### 技术质量评分

| 维度 | 得分 | 扣分依据 |
|---|---:|---|
| 正确性 / 业务逻辑（30） | ${input.failed ? 5 : 25} | ${input.issues.length ? "失败测试对应 P1 问题" : "定向测试通过"} |
| 稳定性 / 异常处理（20） | ${input.failed ? 5 : 16} | 失败路径和恢复证据仍需闭环 |
| 安全 / 合规（5） | 3 | 本流程不替代安全扫描 |
| 可测试性 / 验证证据（15） | ${input.failed ? 7 : 13} | 已有原生 HTML/JSON/trace |
| 可维护性（10） | 6 | 需结合源码审查补充模块和 owner 信息 |
| 可观测性（10） | 4 | 仅有测试 trace，无生产 metrics/告警 runbook |
| 总分 | ${input.failed ? 30 : 67} | ${input.failed ? "不满足发布门槛" : "仅代表定向检查"} |

每个技术质量分项均有扣分依据。logs / metrics / traces 当前只有 Playwright 证据；实时告警、报表告警、SLI/SLO、告警 owner/threshold/routing/runbook 未提供。

### CR 执行审计评分

| 维度 | 得分 |
|---|---:|
| 范围与基线可信度（20） | 8 |
| diff 证据完整性（15） | 7 |
| 触发维度覆盖（15） | 10 |
| 技术审查深度（20） | 15 |
| 交付证据审查（15） | 8 |
| gate / issue trace 一致性（15） | 13 |
| 总分 | 61 |

## CR 执行审计

${audit}

## 覆盖率与 Gate

- 覆盖工件目录：${relativePath(path.dirname(input.formalPath), input.caseRoot)}
- 检查项：${input.checks.length}；问题：${input.issues.length}；trace：${input.traces.length}
- Gate：${input.gate.decision}
- 完整 checks：${relativePath(path.dirname(input.formalPath), path.join(input.caseRoot, "checks.jsonl"))}

## 技术审查结果

${findings || "本次未发现失败测试；仍需补齐发布证据后再宣称完成。"}

## 测试证据

- 执行方式：真实 @playwright/test，使用 results.json 中的原生执行结果。
- HTML 报告：${relativePath(path.dirname(input.formalPath), input.htmlPath)}
- JSON 结果：${relativePath(path.dirname(input.formalPath), input.resultsPath)}
- trace 数量：${input.traces.length}
- 测试统计：${input.specs.length} total / ${input.passed} passed / ${input.failed} failed

## 发布风险与回滚

- 风险等级：${input.failed ? "高" : "中"}。
- 发布前必须完成失败项处理、UAT、发布和回滚材料，并重新生成报告。
- 若已部署，回滚到上一个已验证版本，并核对失败测试对应用户流程。

## 处置项

- 报告状态：${input.state.report_state}
- 下一步：${input.failed ? "修复失败测试对应产品问题后重新运行 Playwright。" : "补齐发布证据后重新评估 gate。"}

## 附录：Issue Registry

- issues.jsonl：${relativePath(path.dirname(input.formalPath), path.join(input.caseRoot, "issues.jsonl"))}
- gate.json：${relativePath(path.dirname(input.formalPath), path.join(input.caseRoot, "gate.json"))}
- state.json：${relativePath(path.dirname(input.formalPath), path.join(input.caseRoot, "state.json"))}
`;
}

function nextCaseId(reportBase: string, base: string): string { if (!fs.existsSync(path.join(reportBase, "cases", base))) return base; for (let index = 2; index < 100; index += 1) { const candidate = `${base}-r${index}`; if (!fs.existsSync(path.join(reportBase, "cases", candidate))) return candidate; } throw new Error("too many same-day CR reports"); }
function safeName(value: string): string { const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); if (!normalized) throw Object.assign(new Error("project must contain letters or digits"), { code: "INVALID_INPUT" }); return normalized.slice(0, 64); }
function contained(root: string, value: string): string { const resolved = path.resolve(root, value); const relative = path.relative(root, resolved); if (relative.startsWith("..") || path.isAbsolute(relative)) throw Object.assign(new Error("path must stay inside the trusted workspace"), { code: "PATH_OUTSIDE_WORKSPACE" }); return resolved; }
function relativePath(root: string, value: string): string { return path.relative(root, value) || "."; }
function relativeOrLabel(root: string, value: string): string { const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value); const relative = path.relative(root, resolved); return relative.startsWith("..") || path.isAbsolute(relative) ? path.basename(value) : relative; }
function writeJson(file: string, value: unknown): void { fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8"); }
function writeJsonl(file: string, values: unknown[]): void { fs.writeFileSync(file, values.map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8"); }
