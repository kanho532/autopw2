import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface DetailedReportOptions {
  workspaceRoot: string;
  runRoot: string;
  runId: string;
  targetOrigin?: string;
}

type Json = Record<string, unknown>;
interface PlanCase extends Json { case_id: string; title?: string; feature_id?: string; requirement_refs?: string[]; setup?: Json[]; steps?: Json[]; cleanup?: Json[]; }
interface ExecutionStep extends Json { step_index?: number; phase?: string; action?: string; locator_ref?: string; endpoint_ref?: string; status?: string; duration_ms?: number; output_summary?: unknown; error?: string; evidence_refs?: ArtifactRef[]; }
interface ExecutionResult extends Json { execution_id: string; case_id: string; status?: string; browser?: string; viewport?: Json; locale?: string; auth_scope_id?: string; classification?: string; failure_signal?: Json; error?: string; path?: ExecutionStep[]; evidence_refs?: ArtifactRef[]; }
interface ArtifactRef { handle?: string; kind?: string; }
interface ArtifactEntry { relative_path: string; kind: string; size_bytes: number; sha256: string; display_name?: string; }
interface ReportLocation { path: string; line?: number; reason: string; confidence: "高" | "中" | "低"; }
interface ReportEvidence { handle: string; kind: string; relative_path: string; sha256: string; }
interface ReportRecord { plan: PlanCase; result?: ExecutionResult; issue?: Json; flow: Array<Record<string, unknown>>; causes: string[]; locations: ReportLocation[]; evidence: ReportEvidence[]; }

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java", ".kt", ".kts", ".vue", ".svelte", ".html", ".cs", ".py", ".go", ".php", ".json", ".yaml", ".yml"]);
const IGNORED_DIRECTORIES = new Set([".git", ".autopw", "node_modules", "dist", "build", "coverage", "target", ".next", ".nuxt"]);

export function exportDetailedReport(options: DetailedReportOptions): Record<string, unknown> {
  const workspaceRoot = fs.realpathSync.native(options.workspaceRoot);
  const runRoot = path.resolve(options.runRoot);
  const plan = readJson(path.join(runRoot, "plan.json"));
  const executions = arrayOf(readJson(path.join(runRoot, "execution-results.json")));
  const results = readJson(path.join(runRoot, "artifacts", "results.json"));
  if (!plan || !Array.isArray(plan.cases) || !results) throw reportError("REPORT_NOT_AVAILABLE", "completed run data is not available for " + options.runId);

  const issues = arrayOf(results.issues);
  const coverage = readJson(path.join(runRoot, "requirement-coverage.json"));
  const completionAudit = readJson(path.join(runRoot, "completion-audit.json"));
  const mappingAudit = readJson(path.join(runRoot, "mapping-audit.json"));
  const discovery = readJson(path.join(runRoot, "discovery.json"));
  const derivation = readJson(path.join(runRoot, "derivation.json"));
  const artifactIndex = readJson(path.join(runRoot, "artifact-index.json"));
  const entries = isRecord(artifactIndex?.artifacts) ? artifactIndex.artifacts as Record<string, ArtifactEntry> : {};
  const destination = path.join(workspaceRoot, ".autopw", "reports", options.runId);
  const playwrightRoot = path.join(destination, "playwright-report");
  if (!contained(path.join(workspaceRoot, ".autopw", "reports"), destination)) throw reportError("PATH_OUTSIDE_WORKSPACE", "report path escaped the trusted workspace");
  if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.join(playwrightRoot, "test-results"), { recursive: true });

  const sourceIndex = buildSourceIndex(workspaceRoot);
  const discoveryLocations = collectDiscoveryLocations(discovery);
  const requirementSources = collectRequirementSources(derivation, coverage);
  const executionByCase = new Map(executions.filter(isRecord).map((item) => [String(item.case_id), item as ExecutionResult]));
  const issueByExecution = new Map(issues.filter(isRecord).map((item) => [String(item.execution_id), item]));
  const records: ReportRecord[] = (plan.cases as unknown[]).filter(isRecord).map((item) => {
    const testCase = item as PlanCase;
    const execution = executionByCase.get(String(testCase.case_id));
    const issue = execution ? issueByExecution.get(execution.execution_id) : undefined;
    const evidence = exportEvidence({ runRoot, playwrightRoot, testCase, execution, entries });
    return {
      plan: testCase,
      result: execution,
      issue,
      flow: operationFlow(testCase, execution),
      causes: conciseCauses(execution, issue),
      locations: locateCode(testCase, execution, discoveryLocations, requirementSources, sourceIndex),
      evidence,
    };
  });

  const model = {
    generated_at: new Date().toISOString(),
    run_id: options.runId,
    target_origin: options.targetOrigin || "未记录",
    gate: String(results.gate || "unknown"),
    audit_status: String(results.audit_status || "unknown"),
    summary: isRecord(results.summary) ? results.summary : {},
    coverage: coverage || null,
    completion_audit: completionAudit || null,
    mapping_audit: mappingAudit || null,
    records,
    note: "本报告由 AutoPW 运行证据生成；可能原因是基于失败信号的精简候选，需结合源码复核。",
  };
  const markdownPath = path.join(destination, "report.md");
  const htmlPath = path.join(destination, "report.html");
  const resultsPath = path.join(destination, "results.json");
  const playwrightIndexPath = path.join(playwrightRoot, "index.html");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(markdownPath, renderMarkdown(model), "utf8");
  fs.writeFileSync(htmlPath, renderHtml(model), "utf8");
  fs.writeFileSync(resultsPath, JSON.stringify(redact(results), null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(playwrightRoot, "results.json"), JSON.stringify(redact({ run_id: options.runId, executions, records: records.map((record) => ({ case_id: record.plan.case_id, execution_id: record.result?.execution_id, status: record.result?.status, evidence: record.evidence })) }), null, 2) + "\n", "utf8");
  fs.writeFileSync(playwrightIndexPath, renderPlaywrightIndex(model), "utf8");

  const reportFiles = listFiles(destination).filter((file) => path.basename(file) !== "report-manifest.json");
  const manifest = { schema_version: "1.0", run_id: options.runId, generated_at: model.generated_at, files: reportFiles.map((file) => ({ path: portable(path.relative(destination, file)), size_bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) })) };
  const manifestPath = path.join(destination, "report-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { kind: "ok", run_id: options.runId, export_dir: destination, report_paths: { markdown: markdownPath, html: htmlPath, results: resultsPath, manifest: manifestPath, playwright: playwrightIndexPath }, summary: { total: records.length, passed: records.filter((record) => record.result?.status === "PASSED").length, failed: records.filter((record) => record.result?.status === "FAILED").length, evidence_files: records.reduce((sum, record) => sum + record.evidence.length, 0) } };
}

function operationFlow(testCase: PlanCase, execution?: ExecutionResult): Array<Record<string, unknown>> {
  const planned = ([...(testCase.setup || []).map((step) => ({ phase: "setup", step })), ...(testCase.steps || []).map((step) => ({ phase: "test", step })), ...(testCase.cleanup || []).map((step) => ({ phase: "cleanup", step }))]);
  const actual = execution?.path || [];
  const count = Math.max(planned.length, actual.length);
  return Array.from({ length: count }, (_, index) => {
    const planStep = planned[index]; const actualStep = actual[index]; const step = planStep?.step || {};
    return {
      sequence: index + 1,
      phase: actualStep?.phase || planStep?.phase || "unknown",
      operation: String(actualStep?.action || step.action || "unknown"),
      target: stepTarget(step, actualStep),
      input: safeStepInput(step),
      expected: expectedValue(step),
      actual: compact(redact(actualStep?.error || actualStep?.output_summary || (actualStep ? "执行完成" : "未执行"))),
      status: actualStep?.status || "NOT_RUN",
      duration_ms: Number(actualStep?.duration_ms || 0),
    };
  });
}

function conciseCauses(execution?: ExecutionResult, issue?: Json): string[] {
  if (!execution) return ["未生成执行结果，需检查运行是否完整结束。"];
  if (execution.status === "PASSED") return ["未发现失败信号。"];
  const signal = isRecord(execution.failure_signal) ? execution.failure_signal : isRecord(issue?.failure_signal) ? issue?.failure_signal as Json : {};
  const code = String(signal.code || "").toUpperCase(); const actual = Number(signal.actual); const message = String(execution.error || issue?.message || "").toLowerCase();
  if (actual === 401 || actual === 403 || /unauthor|forbidden|auth/.test(message)) return ["鉴权状态或权限范围与测试前提不一致。"];
  if (actual === 404) return ["请求路径或前置资源与当前实现不一致。"];
  if (actual >= 500) return ["服务端处理该请求时发生异常，优先核对对应接口实现与日志。"];
  if (actual === 400 || /valid|bad request/.test(message)) return ["请求数据与接口校验契约不一致。"];
  if (code.includes("TIMEOUT") || /timeout|timed out/.test(message)) return ["页面/服务未在时限内达到预期状态。"];
  if (code.includes("JSON") || code.includes("SCHEMA")) return ["响应字段或结构与测试契约不一致。"];
  if (code.includes("RELATION") || code.includes("COLLECTION")) return ["业务状态、持久化结果或集合关系未满足断言。"];
  if (String(issue?.classification || execution.classification) === "PLAN_DEFECT") return ["生成的测试步骤或断言可能与已发现契约不一致。"];
  if (String(issue?.classification || execution.classification) === "INFRA_DEFECT") return ["运行环境、浏览器或目标服务不可用。"];
  return ["现有失败信号不足以确定原因，需结合 trace 与对应源码复核。"];
}

function locateCode(testCase: PlanCase, execution: ExecutionResult | undefined, discovery: Map<string, ReportLocation[]>, requirementSources: Map<string, string[]>, sourceIndex: SourceIndex): ReportLocation[] {
  const locations: ReportLocation[] = [];
  for (const ref of testCase.requirement_refs || []) for (const location of discovery.get(ref) || []) addLocation(locations, location);
  for (const requirement of testCase.requirement_refs || []) for (const ref of requirementSources.get(requirement) || []) for (const location of discovery.get(ref) || []) addLocation(locations, location);
  for (const ref of testCase.requirement_refs || []) for (const [key, values] of discovery) if (key.includes(ref) || ref.includes(key)) for (const location of values) addLocation(locations, location);
  const needles = locationNeedles(testCase, execution);
  for (const needle of needles) for (const match of sourceIndex.find(needle)) addLocation(locations, { ...match, reason: `源码包含 ${JSON.stringify(needle)}`, confidence: "中" });
  if (locations.length === 0 && testCase.origin && isRecord(testCase.origin) && typeof testCase.origin.source_ref === "string") addLocation(locations, { path: testCase.origin.source_ref, reason: "测试计划来源", confidence: "低" });
  return locations.slice(0, 3);
}

function collectRequirementSources(...values: unknown[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isRecord(value)) return;
    if (typeof value.requirement_id === "string") {
      const refs = [...(Array.isArray(value.source_refs) ? value.source_refs : []), ...(Array.isArray(value.source) ? value.source : [])].filter((item): item is string => typeof item === "string");
      if (refs.length) map.set(value.requirement_id, [...new Set([...(map.get(value.requirement_id) || []), ...refs])]);
    }
    Object.values(value).forEach(visit);
  };
  values.forEach(visit); return map;
}

function collectDiscoveryLocations(discovery: unknown): Map<string, ReportLocation[]> {
  const map = new Map<string, ReportLocation[]>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isRecord(value)) return;
    const ref = isRecord(value.source_ref) ? value.source_ref : undefined;
    if (ref && typeof ref.path === "string" && !ref.path.startsWith("<")) {
      const location = { path: ref.path, ...(Number.isInteger(ref.line) ? { line: Number(ref.line) } : {}), reason: "发现证据定位", confidence: (String(value.source_kind || "").match(/AST|OPENAPI/) ? "高" : "中") as "高" | "中" };
      for (const key of [value.fact_id, value.evidence_id, value.requirement_id, value.feature_id].filter((item): item is string => typeof item === "string")) (map.get(key) || map.set(key, []).get(key)!).push(location);
    }
    Object.values(value).forEach(visit);
  };
  visit(discovery); return map;
}

interface SourceIndex { find(needle: string): Array<{ path: string; line: number }>; }
function buildSourceIndex(root: string): SourceIndex {
  const files: Array<{ relative: string; lines: string[] }> = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > 12 || files.length >= 2000) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && entry.name !== "package-lock.json" && fs.statSync(full).size <= 2_000_000) {
        try { files.push({ relative: portable(path.relative(root, full)), lines: fs.readFileSync(full, "utf8").split(/\r?\n/) }); } catch { /* unreadable source is skipped */ }
      }
      if (files.length >= 2000) break;
    }
  };
  walk(root, 0);
  return { find(needle) { if (needle.length < 3) return []; const matches: Array<{ path: string; line: number }> = []; for (const file of files) { const index = file.lines.findIndex((line) => line.includes(needle)); if (index >= 0) matches.push({ path: file.relative, line: index + 1 }); if (matches.length >= 3) break; } return matches; } };
}

function exportEvidence({ runRoot, playwrightRoot, testCase, execution, entries }: { runRoot: string; playwrightRoot: string; testCase: PlanCase; execution?: ExecutionResult; entries: Record<string, ArtifactEntry> }): ReportEvidence[] {
  const output: ReportEvidence[] = []; const caseRoot = path.join(playwrightRoot, "test-results", safeSegment(testCase.case_id)); fs.mkdirSync(caseRoot, { recursive: true });
  const handles = new Set<string>();
  for (const ref of [...(execution?.evidence_refs || []), ...(execution?.path || []).flatMap((step) => step.evidence_refs || [])]) if (typeof ref.handle === "string") handles.add(ref.handle);
  for (const handle of handles) {
    const entry = entries[handle]; if (!entry || !safeRelative(entry.relative_path)) continue;
    const input = path.resolve(runRoot, entry.relative_path); if (!contained(runRoot, input) || !fs.existsSync(input)) continue;
    let name = safeFileName(entry.display_name || path.basename(entry.relative_path)); let outputFile = path.join(caseRoot, name);
    if (fs.existsSync(outputFile) && sha256(fs.readFileSync(outputFile)) !== entry.sha256) { name = handle.slice(-10) + "-" + name; outputFile = path.join(caseRoot, name); }
    fs.copyFileSync(input, outputFile);
    output.push({ handle, kind: entry.kind, relative_path: portable(path.relative(playwrightRoot, outputFile)), sha256: entry.sha256 });
  }
  return output;
}

function renderMarkdown(model: Json & { records: ReportRecord[] }): string {
  const summary = isRecord(model.summary) ? model.summary : {};
  const sections = model.records.map((record, index) => {
    const result = record.result; const issue = record.issue;
    const flow = record.flow.map((step) => `| ${step.sequence} | ${md(String(step.phase))} | ${md(String(step.operation))} | ${md(String(step.target || "-"))} | ${md(String(step.expected || "-"))} | ${md(String(step.actual || "-"))} | ${md(String(step.status))} | ${step.duration_ms} |`).join("\n") || "| - | - | - | - | - | - | 未执行 | 0 |";
    const locations = record.locations.map((location) => `- \`${md(location.path)}${location.line ? ":" + location.line : ""}\`（${location.confidence}）：${md(location.reason)}`).join("\n") || "- 未定位到可信源码位置；请从操作目标和 trace 继续复核。";
    const evidence = record.evidence.map((item) => `- [${md(item.kind + " / " + path.basename(item.relative_path))}](playwright-report/${encodeLink(item.relative_path)}) · \`${item.sha256.slice(0, 12)}\``).join("\n") || "- 无可导出的证据文件。";
    return `## ${index + 1}. ${md(record.plan.title || record.plan.case_id)}\n\n- 用例：\`${md(record.plan.case_id)}\`\n- 执行：\`${md(result?.execution_id || "未执行")}\`\n- 状态：**${md(result?.status || "NOT_RUN")}**\n- 分类：${md(String(issue?.classification || result?.classification || "无"))}\n- 需求：${md((record.plan.requirement_refs || []).join(", ") || "未关联")}\n\n### 具体操作流程\n\n| # | 阶段 | 操作 | 目标 | 预期 | 实际 | 状态 | 耗时(ms) |\n|---:|---|---|---|---|---|---|---:|\n${flow}\n\n### 可能原因（精简）\n\n${record.causes.map((cause) => "- " + md(cause)).join("\n")}\n\n### 具体代码位置\n\n${locations}\n\n### Playwright 证据\n\n${evidence}`;
  }).join("\n\n");
  const incomplete = String(model.gate) === "incomplete" || String(model.audit_status) === "INCOMPLETE" ? "\n> **整体审计不完整，不得将已执行子集通过解读为项目通过。**\n" : "";
  return `# AutoPW 正式中文审查报告\n\n- 运行：\`${md(String(model.run_id))}\`\n- 目标：${md(String(model.target_origin))}\n- Gate：**${md(String(model.gate))}**\n- 审计状态：**${md(String(model.audit_status))}**\n- 生成时间：${md(String(model.generated_at))}\n- 汇总：${Number(summary.total_cases || model.records.length)} 个用例 / ${Number(summary.passed || 0)} 通过 / ${Number(summary.failed || 0)} 失败 / ${Number(summary.blocked || 0)} 阻塞\n- Playwright 证据索引：[打开 index.html](playwright-report/index.html)\n${incomplete}\n${auditOverviewMarkdown(model)}\n\n> 本报告只使用 AutoPW 自动发现并生成的测试计划、实际执行路径和证据；不读取项目测试套件的断言或结论。可能原因仅保留高概率候选，仍需结合源码与 trace 复核。\n\n${sections}\n`;
}

function renderHtml(model: Json & { records: ReportRecord[] }): string {
  const sections = model.records.map((record, index) => `<section><h2>${index + 1}. ${html(record.plan.title || record.plan.case_id)}</h2><div class="meta"><span>${html(record.plan.case_id)}</span><span class="status ${html(String(record.result?.status || "NOT_RUN").toLowerCase())}">${html(String(record.result?.status || "NOT_RUN"))}</span><span>${html(String(record.issue?.classification || record.result?.classification || "无分类"))}</span></div><h3>具体操作流程</h3>${flowTable(record.flow)}<h3>可能原因（精简）</h3><ul>${record.causes.map((cause) => `<li>${html(cause)}</li>`).join("")}</ul><h3>具体代码位置</h3><ul>${record.locations.length ? record.locations.map((location) => `<li><code>${html(location.path + (location.line ? ":" + location.line : ""))}</code>（${location.confidence}）${html(location.reason)}</li>`).join("") : "<li>未定位到可信源码位置；请从操作目标和 trace 继续复核。</li>"}</ul><h3>Playwright 证据</h3><ul>${record.evidence.length ? record.evidence.map((item) => `<li><a href="playwright-report/${html(encodeLink(item.relative_path))}">${html(item.kind + " / " + path.basename(item.relative_path))}</a></li>`).join("") : "<li>无可导出的证据文件。</li>"}</ul></section>`).join("");
  const warning = String(model.gate) === "incomplete" || String(model.audit_status) === "INCOMPLETE" ? `<section><h2>总体结论</h2><p><strong>整体审计不完整，不得将已执行子集通过解读为项目通过。</strong></p></section>` : "";
  return page("AutoPW 正式中文审查报告", `<header><p class="eyebrow">AUTOPW REVIEW</p><h1>正式中文审查报告</h1><div class="meta"><span>Run ${html(String(model.run_id))}</span><span>Gate ${html(String(model.gate))}</span><span>Audit ${html(String(model.audit_status))}</span></div><p>报告只使用 AutoPW 自动发现并生成的测试计划、实际操作路径和 Playwright 证据。<a href="playwright-report/index.html">打开 Playwright 证据索引</a></p></header>${warning}${auditOverviewHtml(model)}${sections}`);
}

function renderPlaywrightIndex(model: Json & { records: ReportRecord[] }): string {
  const sections = model.records.map((record) => `<section><h2>${html(record.plan.title || record.plan.case_id)}</h2><div class="meta"><span>${html(record.plan.case_id)}</span><span>${html(String(record.result?.browser || "browser unknown"))}</span><span class="status ${html(String(record.result?.status || "NOT_RUN").toLowerCase())}">${html(String(record.result?.status || "NOT_RUN"))}</span></div>${flowTable(record.flow)}<h3>运行附件</h3><ul>${record.evidence.length ? record.evidence.map((item) => `<li><a href="${html(encodeLink(item.relative_path))}">${html(item.kind + " / " + path.basename(item.relative_path))}</a><small> ${html(item.sha256.slice(0, 12))}</small></li>`).join("") : "<li>无附件</li>"}</ul></section>`).join("");
  return page("AutoPW Playwright 执行报告", `<header><p class="eyebrow">PLAYWRIGHT EVIDENCE</p><h1>AutoPW Playwright 执行报告</h1><p>这里集中展示 AutoPW 自动生成用例的执行路径、trace、截图、控制台和接口响应。trace.zip 可用 <code>npx playwright show-trace &lt;path&gt;</code> 打开。</p><p><a href="../report.html">返回中文审查报告</a></p></header>${sections}`);
}

function auditOverviewMarkdown(model: Json): string {
  const audit = isRecord(model.completion_audit) ? model.completion_audit : {};
  const coverage = isRecord(audit.coverage) ? audit.coverage : isRecord(model.coverage) ? model.coverage : {};
  const metrics = isRecord(audit.coverage_metrics) ? audit.coverage_metrics : {};
  const mapping = isRecord(model.mapping_audit) ? model.mapping_audit : {};
  const unmapped = arrayOf(mapping.unmapped_requirements).filter(isRecord);
  const rows = unmapped.map((item) => `| ${md(String(item.requirement_id || "-"))} | ${md(String(item.reason || "-"))} |`).join("\n") || "| - | 无 |";
  return `## 覆盖与不完整原因\n\n| 指标 | 值 |\n|---|---:|\n| 本 Tier 要求 | ${Number(coverage.required || 0)} |\n| 已计划 | ${Number(coverage.planned || 0)} |\n| 已执行 | ${Number(coverage.executed || 0)} |\n| 已通过 | ${Number(coverage.passed || 0)} |\n| 已发现范围覆盖 | ${Number(metrics.discovered_scope_coverage_pct || 0)}% |\n| 语义 Oracle 覆盖 | ${Number(metrics.semantic_oracle_coverage_pct || 0)}% |\n\n| 未映射需求 | 原因 |\n|---|---|\n${rows}`;
}
function auditOverviewHtml(model: Json): string {
  const audit = isRecord(model.completion_audit) ? model.completion_audit : {};
  const coverage = isRecord(audit.coverage) ? audit.coverage : isRecord(model.coverage) ? model.coverage : {};
  const metrics = isRecord(audit.coverage_metrics) ? audit.coverage_metrics : {};
  const mapping = isRecord(model.mapping_audit) ? model.mapping_audit : {};
  const unmapped = arrayOf(mapping.unmapped_requirements).filter(isRecord);
  return `<section><h2>覆盖与不完整原因</h2><div class="table"><table><tbody><tr><th>本 Tier 要求</th><td>${Number(coverage.required || 0)}</td></tr><tr><th>已计划</th><td>${Number(coverage.planned || 0)}</td></tr><tr><th>已执行</th><td>${Number(coverage.executed || 0)}</td></tr><tr><th>已通过</th><td>${Number(coverage.passed || 0)}</td></tr><tr><th>已发现范围覆盖</th><td>${Number(metrics.discovered_scope_coverage_pct || 0)}%</td></tr><tr><th>语义 Oracle 覆盖</th><td>${Number(metrics.semantic_oracle_coverage_pct || 0)}%</td></tr></tbody></table></div><h3>未映射需求</h3><ul>${unmapped.length ? unmapped.map((item) => `<li><code>${html(String(item.requirement_id || "-"))}</code>：${html(String(item.reason || "-"))}</li>`).join("") : "<li>无</li>"}</ul></section>`;
}

function flowTable(flow: Array<Record<string, unknown>>): string { return `<div class="table"><table><thead><tr><th>#</th><th>阶段</th><th>操作</th><th>目标</th><th>预期</th><th>实际</th><th>状态</th><th>ms</th></tr></thead><tbody>${flow.map((step) => `<tr><td>${step.sequence}</td><td>${html(String(step.phase))}</td><td><code>${html(String(step.operation))}</code></td><td>${html(String(step.target || "-"))}</td><td>${html(String(step.expected || "-"))}</td><td>${html(String(step.actual || "-"))}</td><td>${html(String(step.status))}</td><td>${step.duration_ms}</td></tr>`).join("")}</tbody></table></div>`; }
function page(title: string, body: string): string { return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><style>:root{color-scheme:light;--ink:#18212b;--muted:#65717d;--line:#d9e0e6;--accent:#0d6b5c;--paper:#fff;--wash:#f4f7f8}*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}header,section{max-width:1180px;margin:24px auto;padding:28px 32px;background:var(--paper);border:1px solid var(--line);border-radius:14px}h1{font-size:30px;margin:0 0 12px}h2{font-size:20px;border-bottom:1px solid var(--line);padding-bottom:10px}h3{margin-top:24px}.eyebrow{color:var(--accent);font-weight:700;letter-spacing:.14em}.meta{display:flex;gap:10px;flex-wrap:wrap}.meta span{background:#eef3f3;padding:3px 9px;border-radius:99px}.status.failed,.status.infra_blocked{background:#fee2e2;color:#991b1b}.status.passed{background:#dcfce7;color:#166534}.table{overflow:auto}table{border-collapse:collapse;width:100%;min-width:900px}th,td{border:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}th{background:#edf3f3}code{font-family:ui-monospace,Consolas,monospace}a{color:var(--accent)}small{color:var(--muted)}</style></head><body>${body}</body></html>`; }

function locationNeedles(testCase: PlanCase, execution?: ExecutionResult): string[] { const values: string[] = []; for (const step of [...(testCase.setup || []), ...(testCase.steps || []), ...(testCase.cleanup || [])]) { if (typeof step.path === "string") values.push(step.path.split("?")[0]); if (isRecord(step.locator) && typeof step.locator.value === "string") values.push(step.locator.value); } for (const step of execution?.path || []) if (typeof step.endpoint_ref === "string") values.push(step.endpoint_ref.replace(/^[A-Z]+\s+/, "").split("?")[0]); return [...new Set(values.map((value) => value.replace(/\{[^}]+\}/g, "")).filter((value) => value.length >= 3))].slice(0, 6); }
function stepTarget(step: Json, actual?: ExecutionStep): string { if (actual?.endpoint_ref) return actual.endpoint_ref; if (typeof step.path === "string") return `${String(step.method || "")} ${step.path}`.trim(); if (isRecord(step.locator)) return compact(step.locator); if (typeof actual?.locator_ref === "string") return actual.locator_ref; if (typeof step.source === "string") return step.source; return "-"; }
function safeStepInput(step: Json): string { const input = Object.fromEntries(Object.entries(step).filter(([key]) => !["action", "locator", "path", "source", "equals", "contains", "exists", "checked", "schema"].includes(key))); return compact(redact(input)); }
function expectedValue(step: Json): string { const expectation = Object.fromEntries(Object.entries(step).filter(([key]) => ["equals", "contains", "exists", "checked", "acceptable_statuses", "state", "operator", "predicate"].includes(key))); return Object.keys(expectation).length ? compact(redact(expectation)) : String(step.action || "").startsWith("expect_") ? "断言成立" : "操作成功"; }
function compact(value: unknown): string { if (value === undefined || value === null || value === "") return "-"; const text = typeof value === "string" ? value : JSON.stringify(value); return text.length > 220 ? text.slice(0, 217) + "..." : text.replace(/[\r\n]+/g, " "); }
function redact(value: unknown): unknown { if (Array.isArray(value)) return value.map(redact); if (!isRecord(value)) return value; return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|authorization|cookie|api.?key/i.test(key) ? "[REDACTED]" : redact(item)])); }
function addLocation(target: ReportLocation[], location: ReportLocation): void { if (!target.some((item) => item.path === location.path && item.line === location.line)) target.push(location); }
function safeSegment(value: string): string { return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 96) || "case"; }
function safeFileName(value: string): string { return path.basename(value).replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120) || "artifact"; }
function safeRelative(value: string): boolean { return !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."); }
function contained(root: string, candidate: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function listFiles(root: string): string[] { const output: string[] = []; const visit = (dir: string): void => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) visit(full); else if (entry.isFile()) output.push(full); } }; visit(root); return output.sort(); }
function readJson(file: string): Json | undefined { try { const value = JSON.parse(fs.readFileSync(file, "utf8")); return isRecord(value) ? value : Array.isArray(value) ? value as unknown as Json : undefined; } catch { return undefined; } }
function arrayOf(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function isRecord(value: unknown): value is Json { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function portable(value: string): string { return value.split(path.sep).join("/"); }
function sha256(value: Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function encodeLink(value: string): string { return portable(value).split("/").map(encodeURIComponent).join("/"); }
function html(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] || char)); }
function md(value: string): string { return value.replace(/[|`\\]/g, (char) => char === "|" ? "\\|" : char === "`" ? "\\`" : "\\\\").replace(/[\r\n]+/g, " "); }
function reportError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
