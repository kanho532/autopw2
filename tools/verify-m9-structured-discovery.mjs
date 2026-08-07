// M9.5 Structured Discovery acceptance verifier.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const discovery = await import(pathToFileURL(path.join(root, "packages", "discovery", "dist", "index.js")).href);
const todo = await import(pathToFileURL(path.join(root, "apps", "todo-fixture-target", "dist", "index.js")).href);
let passed = 0; let failed = 0;
function check(name, condition, detail = "") { if (condition) { passed += 1; console.log("PASS", name, detail ? "(" + detail + ")" : ""); } else { failed += 1; console.log("FAIL", name, detail); } }
function facts(result) { return result.observations.filter((item) => item.kind === "fact"); }
function hasFact(result, predicate) { return facts(result).some(predicate); }

const target = await todo.startTodoTarget();
try {
  const projectRoot = path.join(root, "apps", "todo-fixture-target");
  const allowedOrigin = new URL(target.baseUrl).origin;
  const before = target.getStats();
  const result = await discovery.discover({ root: projectRoot, target_url: target.baseUrl, budget: { max_depth: 4, max_files: 50, static_timeout_ms: 3000, live_timeout_ms: 3000, route_timeout_ms: 1000, max_routes: 50, max_controls_per_route: 24, max_network_observations: 50, allowed_origins: [allowedOrigin] } });
  const after = target.getStats();
  check("m9.5-structured-facts-present", facts(result).length > 0);
  check("m9.5-discovers-create", hasFact(result, (fact) => fact.fact_type === "endpoint" && fact.method === "POST" && fact.operation === "create"));
  check("m9.5-discovers-update", hasFact(result, (fact) => fact.fact_type === "endpoint" && fact.method === "PATCH" && fact.operation === "update"));
  check("m9.5-discovers-delete", hasFact(result, (fact) => fact.fact_type === "endpoint" && fact.method === "DELETE" && fact.operation === "delete"));
  check("m9.5-discovers-search", hasFact(result, (fact) => fact.fact_type === "endpoint" && fact.operation === "search"));
  check("m9.5-discovers-summary-and-count", hasFact(result, (fact) => fact.fact_type === "endpoint" && fact.operation === "summary") && hasFact(result, (fact) => fact.fact_type === "endpoint" && fact.operation === "count"));
  check("m9.5-discovers-required-and-max-length", hasFact(result, (fact) => fact.fact_type === "validation" && fact.rule === "required") && hasFact(result, (fact) => fact.fact_type === "validation" && fact.rule === "maxLength" && fact.value === 80));
  check("m9.5-discovers-priority-enum", hasFact(result, (fact) => fact.fact_type === "validation" && fact.rule === "enum" && Array.isArray(fact.values) && fact.values.includes("high")));
  check("m9.5-discovers-patch-cors", hasFact(result, (fact) => fact.fact_type === "endpoint" && fact.method === "OPTIONS" && fact.operation === "cors"));
  check("m9.5-correlates-search-control-and-api", hasFact(result, (fact) => fact.fact_type === "correlation" && fact.relation === "control_api"));
  check("m9.5-live-discovery-does-not-mutate", before.creates === after.creates && before.updates === after.updates && before.deletes === after.deletes && after.creates === 0 && after.deletes === 0);
  check("m9.5-cross-origin-request-is-blocked", result.network.blocked_origins.includes("https://disallowed.example.invalid"));
  check("m9.5-separated-budget-metrics", result.metrics.static_discovery_wall_ms >= 0 && result.metrics.live_discovery_wall_ms >= 0 && result.metrics.correlation_cpu_ms >= 0 && result.metrics.total_discovery_wall_ms >= result.metrics.static_discovery_wall_ms);

  const repeated = await discovery.discover({ root: projectRoot, budget: { max_depth: 4, max_files: 50, static_timeout_ms: 3000, allowed_origins: [allowedOrigin] } });
  const firstIds = facts(repeated).map((fact) => fact.fact_id).sort();
  const second = await discovery.discover({ root: projectRoot, budget: { max_depth: 4, max_files: 50, static_timeout_ms: 3000, allowed_origins: [allowedOrigin] } });
  check("m9.5-fact-ids-are-stable", JSON.stringify(firstIds) === JSON.stringify(facts(second).map((fact) => fact.fact_id).sort()));

  const budgetLimited = await discovery.discover({ root: projectRoot, budget: { max_depth: 4, max_files: 1, static_timeout_ms: 3000, allowed_origins: [allowedOrigin] } });
  check("m9.5-budget-exceeded-is-explicit-blocker", budgetLimited.budget.budget_exceeded && budgetLimited.budget.blockers.includes("DISCOVERY_STATIC_FILE_BUDGET_EXCEEDED") && budgetLimited.observations.some((item) => item.kind === "objective_blocker"));

  let rejectedOrigin = false;
  try { await discovery.discover({ root: projectRoot, target_url: target.baseUrl, budget: { allowed_origins: ["https://invalid.example"] } }); } catch (error) { rejectedOrigin = error?.message === "DISCOVERY_ORIGIN_NOT_ALLOWED"; }
  check("m9.5-origin-policy-rejects-target", rejectedOrigin);
} finally { await target.close(); }

console.log(`\nM9.5 structured discovery verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
