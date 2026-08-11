import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const audit = await import(pathToFileURL(path.join(root, "packages", "audit", "dist", "index.js")).href);
const gate = await import(pathToFileURL(path.join(root, "packages", "gate", "dist", "index.js")).href);
const derivation = await import(pathToFileURL(path.join(root, "packages", "derivation", "dist", "index.js")).href);
const reporting = await import(pathToFileURL(path.join(root, "packages", "reporting", "dist", "index.js")).href);
const storage = await import(pathToFileURL(path.join(root, "packages", "run-storage", "dist", "index.js")).href);

let passed = 0;
let failed = 0;
function check(name, value, detail = "") { if (value) { passed += 1; console.log("PASS", name, detail ? "(" + detail + ")" : ""); } else { failed += 1; console.log("FAIL", name, detail); } }

const coverage = { required: 1, planned: 1, executable: 1, executed: 1, passed: 1, evidence_complete: 1, p0_required: 1, p0_planned: 1, p0_executable: 1, p0_executed: 1, p0_passed: 1 };
const result = { execution_id: "EXE-m9.8", case_id: "case_p0", status: "PASSED", evidence_refs: [{ handle: "art_api", kind: "api-response" }], cleanup_status: "PASSED", attempts: [], path: [] };
const manifest = { instances: [{ execution_id: result.execution_id, batch_id: "batch" }] };
const cases = [{ case_id: result.case_id, kind: "api", risk: "mutating" }];
const complete = audit.auditExecution([result.case_id], [result], manifest, { requirements: [{ requirement_id: "req_p0", priority: "P0", oracle: { kind: "status", assertion: "returns 200" } }], requirementCaseMap: { req_p0: [result.case_id] }, requirementOracleMap: { req_p0: ["case_p0:step_0"] }, coverage, cases });
check("m9.8-requirement-reconciliation-complete", complete.requirement_reconciliation === "COMPLETE");
check("m9.8-evidence-reconciliation-complete", complete.evidence_complete === true);
check("m9.8-cleanup-reconciliation-complete", complete.cleanup_complete === true);
check("m9.8-pass-gate-uses-coverage", gate.evaluateGate({ audit: complete, coverage, gatePolicy: { min_p0_coverage_pct: 100 }, issues: complete.issues }).gate === "pass");
check("m9.8-p0-gap-is-incomplete", gate.evaluateGate({ audit: complete, coverage: { ...coverage, p0_planned: 0, p0_executable: 0 }, gatePolicy: { min_p0_coverage_pct: 100 }, issues: [] }).gate === "incomplete");
check("m9.8-product-defect-is-fail", gate.evaluateGate({ audit: complete, coverage, issues: [{ classification: "PRODUCT_DEFECT" }] }).gate === "fail");
check("m9.8-infra-defect-is-infra", gate.evaluateGate({ audit: complete, coverage, issues: [{ classification: "INFRA_DEFECT" }] }).gate === "infra");
check("m9.8-plan-defect-is-incomplete", gate.evaluateGate({ audit: complete, coverage, issues: [{ classification: "PLAN_DEFECT" }] }).gate === "incomplete");
check("m9.8-test-defect-is-incomplete", gate.evaluateGate({ audit: complete, coverage, issues: [{ classification: "TEST_DEFECT" }] }).gate === "incomplete");
check("m9.8-flaky-threshold-is-unstable", gate.evaluateGate({ audit: complete, coverage, issues: [{ classification: "UNSTABLE" }], gatePolicy: { max_flaky_cases: 0 } }).gate === "unstable");

const planFailure = audit.auditExecution([result.case_id], [{ ...result, status: "FAILED", classification: "PLAN_DEFECT", error: "generated endpoint mismatch" }], manifest, { requirements: [{ requirement_id: "req_p0", priority: "P0", oracle: { kind: "status", assertion: "returns 200" } }], requirementCaseMap: { req_p0: [result.case_id] }, requirementOracleMap: { req_p0: ["case_p0:step_0"] }, coverage, cases: [{ ...cases[0], confidence: 0.9, origin: { type: "generated" } }] });
check("m9.8-plan-defect-confidence-is-not-high", planFailure.issues[0]?.classification === "PLAN_DEFECT" && planFailure.issues[0]?.confidence === "MEDIUM");

const cleanupFailed = audit.auditExecution([result.case_id], [{ ...result, cleanup_status: "FAILED" }], manifest, { requirements: [{ requirement_id: "req_p0", priority: "P0", oracle: { kind: "status", assertion: "returns 200" } }], requirementCaseMap: { req_p0: [result.case_id] }, requirementOracleMap: { req_p0: ["case_p0:step_0"] }, coverage, cases: [{ ...cases[0], risk: "mutating", execution_policy: { isolated_fixture_required: true } }] });
check("m9.8-isolation-policy-does-not-forgive-cleanup", cleanupFailed.cleanup_complete === false && gate.evaluateGate({ audit: cleanupFailed, coverage, issues: cleanupFailed.issues }).gate === "incomplete");

const secondResult = { ...result, execution_id: "EXE-m9.8-second", case_id: "case_p0_second", status: "FAILED" };
const multiCoverage = derivation.reconcileRequirementCoverage([{ requirement_id: "req_p0", feature_id: "todo", intent: "route_loads", scenario: "normal", priority: "P0", source_refs: [], preconditions: [], oracle: { kind: "status", assertion: "returns 200" }, risk: "read_only", confidence: 1, status: "REQUIRED" }], { req_p0: [result.case_id, secondResult.case_id] }, [result, secondResult]);
check("m9.8-multi-case-requires-all-cases", multiCoverage.executed === 1 && multiCoverage.passed === 0);

const missingOracle = audit.auditExecution([result.case_id], [result], manifest, { requirements: [{ requirement_id: "req_p0", priority: "P0", oracle: { kind: "status", assertion: "returns 200" } }], requirementCaseMap: { req_p0: [result.case_id] }, requirementOracleMap: {}, coverage, cases });
check("m9.9-manual-plan-cannot-launder-oracle", missingOracle.oracle_reconciliation === "MISMATCH" && gate.evaluateGate({ audit: missingOracle, coverage, issues: missingOracle.issues }).gate === "incomplete");

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m9.8-"));
try {
  const runId = "run_m9_8_report";
  const runStorage = new storage.RunStorage(dataRoot);
  const resultsRef = runStorage.writeArtifact(runId, "results.json", "results.json", "{}");
  const report = reporting.writeReport({ storage: runStorage, runId, gate: "pass", auditStatus: "COMPLETE", summary: { passed: 1 }, issues: [], resultsRef, planSource: "generated", target: "external", coverage: [{ requirement_id: "req_p0", priority: "P0", intent: "route_loads", source: ["fact_1"], plan_status: "PLANNED", execution_status: "PASSED", evidence: "COMPLETE" }], cases: [{ case_id: "case_p0", title: "P0 case", requirement_refs: ["req_p0"], origin: { type: "generated" }, risk: "read_only", steps: [] }] });
  const markdown = runStorage.readArtifact(runId, "report.md").toString("utf8");
  check("m9.8-report-has-requirement-coverage", markdown.includes("Requirement Coverage") && markdown.includes("req_p0"));
  check("m9.8-report-has-case-paths-and-plan-source", markdown.includes("Case Paths") && markdown.includes("generated") && report.htmlRef.kind === "report.html");
} finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }

console.log("\nM9.8 coverage/gate verify: " + passed + " passed, " + failed + " failed");
if (failed) process.exitCode = 1;
