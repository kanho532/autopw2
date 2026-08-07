// M9.7 Planner-Compiler closed-loop acceptance verifier.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const discovery = await import(pathToFileURL(path.join(root, "packages", "discovery", "dist", "index.js")).href);
const derivation = await import(pathToFileURL(path.join(root, "packages", "derivation", "dist", "index.js")).href);
const planner = await import(pathToFileURL(path.join(root, "packages", "planner", "dist", "index.js")).href);
const compiler = await import(pathToFileURL(path.join(root, "packages", "compiler", "dist", "index.js")).href);
const testPlan = await import(pathToFileURL(path.join(root, "packages", "test-plan", "dist", "index.js")).href);
const execution = await import(pathToFileURL(path.join(root, "packages", "execution", "dist", "index.js")).href);
const storageModule = await import(pathToFileURL(path.join(root, "packages", "run-storage", "dist", "index.js")).href);
const todo = await import(pathToFileURL(path.join(root, "apps", "todo-fixture-target", "dist", "index.js")).href);
let passed = 0; let failed = 0;
function check(name, condition, detail = "") { if (condition) { passed += 1; console.log("PASS", name, detail ? "(" + detail + ")" : ""); } else { failed += 1; console.log("FAIL", name, detail); } }

const target = await todo.startTodoTarget();
try {
  const projectRoot = path.join(root, "apps", "todo-fixture-target");
  const origin = new URL(target.baseUrl).origin;
  const result = await discovery.discover({ root: projectRoot, target_url: target.baseUrl, budget: { max_depth: 4, max_files: 50, static_timeout_ms: 3000, live_timeout_ms: 3000, route_timeout_ms: 1000, max_routes: 50, allowed_origins: [origin] } });
  const coverage = derivation.deriveCoverage({ discovery: result, tier: "full" });
  const requirements = coverage.cdd.requirements;
  const catalog = planner.buildCandidateCatalog({ discovery: result, requirements, manualOverlay: { allowed_origin: origin } });
  const skeletons = planner.buildRequirementPlannerInput(requirements, catalog);
  const input = { schemaVersion: "2.1", skeletons, candidates: catalog, contractRefs: [{ contractId: "test-requirement-plan", version: "2.1", ref: "requirement://derived" }], untrustedObservations: [{ observationId: "obs_0", untrusted: true, kind: "discovery", value: "structured facts" }] };
  const provider = new planner.LocalStructuredPlannerProvider();
  const output = await provider.fill(input, { provider_id: provider.provider_id, provider_version: provider.provider_version, model_id: "local-deterministic", timeout_ms: 2000, token_budget: 2048, temperature: 0 });
  const validation = planner.validatePlannerOutput(input, output, { allowedOrigin: origin });
  check("m9.7-planner-input-comes-from-requirements", skeletons.length === requirements.length && skeletons.every((item) => item.requirement_id));
  check("m9.7-candidate-metadata-is-complete", Object.values(catalog.actions).every((item) => item.requirement_id && item.source && typeof item.confidence === "number" && item.risk));
  check("m9.7-planner-output-is-candidate-only", validation.ok, validation.errors.join("; "));
  check("m9.7-no-arbitrary-url-or-selector", !JSON.stringify(output).match(/https?:\/\/|css|xpath/i));
  const compiled = compiler.compileTestPlan({ requirements, candidateCatalog: catalog, plannerOutput: output });
  const compiledAgain = compiler.compileTestPlan({ requirements, candidateCatalog: catalog, plannerOutput: output });
  check("m9.7-generated-plan-is-valid", testPlan.validatePlan(compiled.plan, { authority: "generated" }).ok && compiled.mappingAudit.match === "COMPLETE");
  check("m9.7-plan-digest-is-deterministic", compiled.digest === compiledAgain.digest);
  check("m9.7-requirements-map-to-cases-and-steps", Object.keys(compiled.mappingAudit.requirement_case_map).length === requirements.length && Object.keys(compiled.mappingAudit.case_step_map).length === compiled.plan.cases.length);
  check("m9.7-oracles-bind-to-generated-assertions", Object.keys(compiled.mappingAudit.requirement_oracle_map).length === requirements.length && Object.values(compiled.mappingAudit.requirement_oracle_map).every((items) => items.every((item) => item.includes(":"))));
  check("m9.7-generated-case-count-is-requirement-driven", compiled.plan.cases.length === requirements.filter((item) => !["BLOCKED", "TIER_SKIPPED", "NOT_APPLICABLE"].includes(item.status)).length && compiled.plan.cases.length > 0);
  check("m9.7-generated-source-is-safe", !compiled.source.match(/node:|child_process|playwright/i));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m9.7-generated-"));
  try {
    const outcome = await new execution.PlaywrightPlanRunner().run({ runId: "run_m9_7_generated", baseUrl: target.baseUrl, plan: compiled.plan, planAuthority: "generated", tier: "full", allowedOrigins: [origin], storage: new storageModule.RunStorage(dataRoot), trace: true });
    check("m9.7-generated-plan-executes-all-eligible-cases", outcome.results.length === compiled.plan.cases.length && outcome.results.every((item) => item.status === "PASSED"));
    check("m9.7-generated-mutating-cleanup-succeeds", outcome.results.filter((item) => item.cleanup_status !== "SKIPPED").every((item) => item.cleanup_status === "PASSED"));
    const reconciled = derivation.reconcileRequirementCoverage(requirements, compiled.mappingAudit.requirement_case_map, outcome.results);
    check("m9.7-requirement-coverage-reconciles-after-execution", reconciled.required === requirements.length && reconciled.planned === requirements.length && reconciled.executable === requirements.length && reconciled.executed === requirements.length && reconciled.passed === requirements.length && reconciled.evidence_complete === requirements.length);
    check("m9.7-generated-run-leaves-no-dirty-data", target.getItems().length === 0);
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
} finally { await target.close(); }

console.log(`\nM9.7 generated plan verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
