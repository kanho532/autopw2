// M9.4 Legacy-12 parity acceptance verifier.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const execution = await import(pathToFileURL(path.join(root, "packages", "execution", "dist", "index.js")).href);
const storageModule = await import(pathToFileURL(path.join(root, "packages", "run-storage", "dist", "index.js")).href);
const todo = await import(pathToFileURL(path.join(root, "apps", "todo-fixture-target", "dist", "index.js")).href);
const plan = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "legacy-todo", "test-plan.json"), "utf8"));
const caseMap = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "legacy-todo", "legacy-case-map.json"), "utf8"));
const expected = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "legacy-todo", "expected-requirements.json"), "utf8"));

let passed = 0; let failed = 0;
function check(name, condition, detail = "") { if (condition) { passed += 1; console.log("PASS", name, detail ? "(" + detail + ")" : ""); } else { failed += 1; console.log("FAIL", name, detail); } }
function caseSummary(outcome) { return outcome.results.map((item) => ({ case_id: item.case_id, status: item.status, cleanup_status: item.cleanup_status })).sort((a, b) => a.case_id.localeCompare(b.case_id)); }

async function runOrder(order, suffix) {
  const target = await todo.startTodoTarget();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m9.4-legacy-"));
  try {
    const orderedPlan = { ...plan, cases: order.map((caseId) => structuredClone(plan.cases.find((item) => item.case_id === caseId))) };
    const outcome = await new execution.PlaywrightPlanRunner().run({ runId: "run_legacy_12_" + suffix, baseUrl: target.baseUrl, plan: orderedPlan, storage: new storageModule.RunStorage(dataRoot), allowedOrigins: [target.baseUrl], planAuthority: "trusted_manual", trace: true });
    return { outcome, target, dataRoot };
  } catch (error) {
    await target.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); throw error;
  }
}

const caseIds = Object.keys(caseMap.cases);
check("m9.4-plan-has-exactly-12-cases", plan.cases.length === 12 && caseIds.length === 12);
check("m9.4-every-case-has-requirement-ref", plan.cases.every((item) => item.requirement_refs.length > 0));
check("m9.4-requirement-golden-is-covered", expected.requirements.every((requirement) => plan.cases.some((item) => item.requirement_refs.includes(requirement))));

const first = await runOrder(caseIds, "a");
try {
  const firstSummary = caseSummary(first.outcome);
  check("m9.4-all-12-executed", first.outcome.results.length === 12 && first.outcome.results.every((item) => item.status === "PASSED"));
  check("m9.4-mutating-cleanup-succeeded", first.outcome.results.filter((item) => item.cleanup_status !== "SKIPPED").every((item) => item.cleanup_status === "PASSED"));
  check("m9.4-case-directories-are-independent", caseIds.every((caseId) => fs.existsSync(path.join(first.dataRoot, "runs", "run_legacy_12_a", "cases", caseId, "case.json"))));
  const ui = first.outcome.results.find((item) => item.case_id === "legacy_D_create_refresh");
  const api = first.outcome.results.find((item) => item.case_id === "legacy_A_not_found");
  check("m9.4-ui-evidence-is-complete", Boolean(ui?.evidence_refs.some((ref) => ref.kind === "playwright-trace")) && Boolean(ui?.evidence_refs.some((ref) => ref.kind === "screenshot")) && Boolean(ui?.evidence_refs.some((ref) => ref.kind === "console.json")));
  check("m9.4-api-evidence-is-case-scoped", Boolean(api?.evidence_refs.some((ref) => ref.kind === "api-response")) && fs.existsSync(path.join(first.dataRoot, "runs", "run_legacy_12_a", "cases", "legacy_A_not_found", "artifacts")));
  check("m9.4-no-dirty-data-after-run", first.target.getItems().length === 0 && first.target.getStats().creates === first.target.getStats().deletes);

  const shuffledIds = seededShuffle(caseIds, 0xA9_04);
  const second = await runOrder(shuffledIds, "b");
  try {
    check("m9.4-random-order-is-semantic-equivalent", JSON.stringify(firstSummary) === JSON.stringify(caseSummary(second.outcome)) && second.outcome.results.every((item) => item.status === "PASSED"));
    check("m9.4-repeat-run-leaves-no-dirty-data", second.target.getItems().length === 0 && second.target.getStats().creates === second.target.getStats().deletes);
  } finally { await second.target.close(); fs.rmSync(second.dataRoot, { recursive: true, force: true }); }
} finally { await first.target.close(); fs.rmSync(first.dataRoot, { recursive: true, force: true }); }

console.log(`\nM9.4 legacy-12 verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

function seededShuffle(items, seed) {
  const shuffled = [...items];
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(next() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}
