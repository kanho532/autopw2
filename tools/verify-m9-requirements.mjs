// M9.6 Requirement Derivation acceptance verifier.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const discovery = await import(pathToFileURL(path.join(root, "packages", "discovery", "dist", "index.js")).href);
const derivation = await import(pathToFileURL(path.join(root, "packages", "derivation", "dist", "index.js")).href);
const todo = await import(pathToFileURL(path.join(root, "apps", "todo-fixture-target", "dist", "index.js")).href);
const expected = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "legacy-todo", "expected-requirements.json"), "utf8"));
let passed = 0; let failed = 0;
function check(name, condition, detail = "") { if (condition) { passed += 1; console.log("PASS", name, detail ? "(" + detail + ")" : ""); } else { failed += 1; console.log("FAIL", name, detail); } }

const target = await todo.startTodoTarget();
try {
  const projectRoot = path.join(root, "apps", "todo-fixture-target");
  const budget = { max_depth: 4, max_files: 50, static_timeout_ms: 3000, live_timeout_ms: 3000, route_timeout_ms: 1000, max_routes: 50, allowed_origins: [new URL(target.baseUrl).origin] };
  const firstDiscovery = await discovery.discover({ root: projectRoot, target_url: target.baseUrl, budget });
  const first = derivation.deriveCoverage({ discovery: firstDiscovery, tier: "full" });
  const second = derivation.deriveCoverage({ discovery: firstDiscovery, tier: "full" });
  const requirements = first.cdd.requirements;
  const ids = requirements.map((item) => item.requirement_id).sort();
  check("m9.6-todo-requirement-golden-is-covered", expected.requirements.every((id) => ids.includes(id)) && ids.length === expected.requirements.length);
  check("m9.6-requirement-ids-are-stable", JSON.stringify(ids) === JSON.stringify(second.cdd.requirements.map((item) => item.requirement_id).sort()));
  check("m9.6-requirement-case-links-are-complete", Object.keys(first.cdd.requirement_case_links).length === requirements.length && requirements.every((item) => first.cdd.requirement_case_links[item.requirement_id]?.length === 1));
  check("m9.6-coverage-layers-are-present", ["required", "planned", "executable", "executed", "passed", "evidence_complete"].every((key) => typeof first.cdd.coverage[key] === "number"));
  check("m9.6-required-is-not-planned-before-planner", first.cdd.coverage.required === requirements.length && first.cdd.coverage.planned === 0 && first.cdd.coverage.executable === 0);
  const blocked = derivation.deriveCoverage({ discovery: firstDiscovery, tier: "full", destructive_allowed: false });
  check("m9.6-destructive-policy-blocks-delete", blocked.cdd.requirements.find((item) => item.requirement_id === "req_task_delete")?.status === "BLOCKED" && blocked.cdd.requirements.find((item) => item.requirement_id === "req_task_delete")?.reason === "DESTRUCTIVE_NOT_ALLOWED");
  const missingOracleDiscovery = structuredClone(firstDiscovery);
  missingOracleDiscovery.observations = missingOracleDiscovery.observations.filter((item) => !(item.kind === "fact" && item.fact_type === "endpoint" && item.operation === "count"));
  const missingOracle = derivation.deriveRequirements({ discovery: missingOracleDiscovery, tier: "full" });
  check("m9.6-missing-fact-does-not-invent-requirement", !missingOracle.some((item) => item.requirement_id === "req_task_count"));
  check("m9.6-p0-denominator-retains-blocked-requirements", blocked.cdd.coverage.p0_required >= blocked.cdd.coverage.p0_executable && blocked.cdd.coverage.p0_required > 0);
} finally { await target.close(); }

console.log(`\nM9.6 requirements verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
