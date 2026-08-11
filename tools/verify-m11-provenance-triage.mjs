import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const load = async (relative) => import(pathToFileURL(path.join(root, relative)).href);
const triage = await load("packages/triage/dist/index.js");
const audit = await load("packages/audit/dist/index.js");
const gate = await load("packages/gate/dist/index.js");
const execution = await load("packages/execution/dist/index.js");
const reporting = await load("packages/reporting/dist/index.js");
const storageModule = await load("packages/run-storage/dist/index.js");
let passed = 0; let failed = 0;
function check(name, value, detail = "") { if (value) { passed += 1; console.log("PASS", name, detail); } else { failed += 1; console.log("FAIL", name, detail); } }

const strong = { proposed_classification: "PLAN_DEFECT", signal: { code: "ASSERT_RELATION", kind: "assertion", phase: "test", expected: 2, actual: 3 }, plan_origin: "generated", case_confidence: 0.96, evidence_refs: ["api-response"], requirement_evidence_refs: ["evidence_openapi"], oracle: { kind: "relation", proven: true } };
check("m11.6-strong-generated-oracle-mismatch-is-product-defect", triage.triageFailure(strong).classification === "PRODUCT_DEFECT" && triage.triageFailure(strong).confidence === "HIGH");
check("m11.6-setup-failure-remains-plan-defect", triage.triageFailure({ ...strong, signal: { ...strong.signal, phase: "setup" } }).classification === "PLAN_DEFECT");
check("m11.6-unproven-oracle-cannot-create-product-defect", triage.triageFailure({ ...strong, oracle: { kind: "relation", proven: false } }).classification === "PLAN_DEFECT");
check("m11.6-network-signal-is-infrastructure", triage.triageFailure({ ...strong, signal: { code: "ERR_CONNECTION", kind: "network", phase: "test" } }).classification === "INFRA_DEFECT");

const server = http.createServer((_request, response) => { response.statusCode = 500; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ error: "broken" })); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const plan = { plan_schema: "autopw.test-plan/1.0", plan_id: "triage_signal", generated_at: "2026-08-11T00:00:00.000Z", origin: { type: "generated" }, coverage_eligible: true, cases: [{ case_id: "case_signal", origin: { type: "generated" }, title: "signal", feature_id: "signal", requirement_refs: ["req_signal"], oracle_bindings: [{ requirement_id: "req_signal", step_refs: ["step_1"] }], scenario: "normal", priority: "P0", effective_tier: "smoke", kind: "api", risk: "read_only", confidence: 0.95, execution_policy: { production_allowed: true }, steps: [{ action: "api_request", method: "GET", path: "/", save_as: "response" }, { action: "expect_status", source: "responses.response", equals: 200 }] }] };
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m11-triage-"));
try {
  const storage = new storageModule.RunStorage(dataRoot);
  const outcome = await new execution.PlaywrightPlanRunner().run({ runId: "run_triage_signal", baseUrl: origin, allowedOrigins: [origin], plan, planAuthority: "generated", storage });
  const signal = outcome.results[0]?.failure_signal;
  check("m11.6-execution-emits-low-level-expected-actual", signal?.code === "ASSERT_STATUS" && signal.phase === "test" && signal.expected === 200 && signal.actual === 500);
  const requirements = [{ requirement_id: "req_signal", status: "REQUIRED", priority: "P0", evidence_refs: ["evidence_openapi"], oracle: { kind: "http", assertion: "returns 200" }, oracle_specification: { kind: "relation", proven: true } }];
  const audited = audit.auditExecution(["case_signal"], outcome.results, outcome.manifest, { requirements, requirementCaseMap: { req_signal: ["case_signal"] }, requirementOracleMap: { req_signal: ["case_signal:step_1"] }, coverage: { required: 1, planned: 1, executable: 1, executed: 1, passed: 0, evidence_complete: 1, p0_required: 1, p0_planned: 1, p0_executable: 1, p0_executed: 1, p0_passed: 0 }, cases: plan.cases });
  check("m11.6-audit-applies-provenance-aware-triage", audited.issues[0]?.classification === "PRODUCT_DEFECT" && audited.issues[0]?.triage?.reason === "EVIDENCE_BACKED_TEST_ORACLE_MISMATCH");
  check("m11.6-gate-consumes-triaged-product-defect", gate.evaluateGate({ audit: audited, coverage: audited.coverage, issues: audited.issues }).gate === "fail");

  const passResult = { ...outcome.results[0], status: "PASSED", error: undefined, classification: undefined, failure_signal: undefined, cleanup_status: "PASSED" };
  const coverageAudit = audit.auditExecution(["case_signal"], [passResult], { batches: [], instances: [{ execution_id: passResult.execution_id }] }, { requirements: [...requirements, { requirement_id: "req_skipped", status: "TIER_SKIPPED", priority: "P1", evidence_refs: ["evidence_ast"], oracle: { kind: "relation", assertion: "semantic" }, oracle_specification: { kind: "relation", proven: true } }], requirementCaseMap: { req_signal: ["case_signal"] }, requirementOracleMap: { req_signal: ["case_signal:step_1"] }, cases: [{ ...plan.cases[0], risk: "mutating" }] });
  check("m11.6-tier-and-discovered-coverage-are-separated", coverageAudit.coverage_metrics.tier_coverage_pct === 100 && coverageAudit.coverage_metrics.discovered_scope_coverage_pct === 50);
  check("m11.6-quality-metrics-are-reported", coverageAudit.coverage_metrics.generated_case_precision_pct === 100 && coverageAudit.coverage_metrics.false_product_defect_rate_pct === 0 && coverageAudit.coverage_metrics.semantic_oracle_coverage_pct === 100 && coverageAudit.coverage_metrics.cleanup_integrity_pct === 100, JSON.stringify(coverageAudit.coverage_metrics));
  const resultsRef = storage.writeArtifact("run_triage_signal", "results.json", "results.json", JSON.stringify({ results: [passResult] }));
  const report = reporting.writeReport({ storage, runId: "run_triage_signal", gate: "pass", auditStatus: coverageAudit.audit_status, summary: coverageAudit.summary, issues: coverageAudit.issues, resultsRef, coverageMetrics: coverageAudit.coverage_metrics });
  const markdown = fs.readFileSync(path.join(dataRoot, "runs", "run_triage_signal", "artifacts", "report.md"), "utf8");
  check("m11.6-report-renders-coverage-metrics", report.reportRef.handle && markdown.includes("Coverage Metrics") && markdown.includes("discovered_scope_coverage_pct"));
} finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dataRoot, { recursive: true, force: true }); }

console.log(`\nM11 phase 6 provenance triage verification: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
