import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const discovery = await import(pathToFileURL(path.join(root, "packages", "discovery", "dist", "index.js")).href);
let passed = 0; let failed = 0; let mutations = 0;
function check(name, value, detail = "") { if (value) { passed += 1; console.log("PASS", name, detail); } else { failed += 1; console.log("FAIL", name, detail); } }
const html = (details = false) => `<!doctype html><main><h1>${details ? "Details" : "Home"}</h1>${details ? '<a id="home" href="/">Home</a>' : '<a id="details" href="/details">Details</a><a id="details-copy" href="/details">Details copy</a>'}<button id="toggle" type="button">Show details</button><button id="refresh" type="button">Refresh</button><div id="panel" hidden>Panel</div><form id="editor"><input name="name"><button id="save" type="submit">Save changes</button></form></main><script>toggle.onclick=()=>{panel.hidden=!panel.hidden;fetch('/api/info').then(r=>r.json()).then(v=>panel.textContent=v.message)};refresh.onclick=()=>fetch('/api/mutate',{method:'POST',body:'sneaky'});editor.onsubmit=e=>{e.preventDefault();fetch('/api/mutate',{method:'POST',body:'x'})}</script>`;
const server = http.createServer((request, response) => { if (request.url === "/api/info") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ message: "Loaded" })); return; } if (request.url === "/api/mutate" && request.method === "POST") { mutations += 1; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ok: true })); return; } response.setHeader("content-type", "text/html"); response.end(html(request.url === "/details")); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); const origin = `http://127.0.0.1:${address.port}`;
const project = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m11-live-project-"));
const budget = { max_files: 5, static_timeout_ms: 2000, live_timeout_ms: 12000, route_timeout_ms: 1500, max_depth: 2, max_routes: 3, max_controls_per_route: 12, max_network_observations: 50, max_interactions_per_route: 6, allowed_origins: [origin] };
try {
  const result = await discovery.discover({ root: project, target_url: origin, budget });
  const facts = result.observations.filter((item) => item.kind === "fact");
  const routeFacts = facts.filter((item) => item.fact_type === "route");
  const interactions = facts.filter((item) => item.fact_type === "interaction");
  const uiMutations = facts.filter((item) => item.fact_type === "ui_mutation");
  const correlations = facts.filter((item) => item.fact_type === "correlation" && item.interaction_fact_id);
  check("m11.7-bounded-bfs-discovers-linked-routes", routeFacts.some((item) => item.route === "/") && routeFacts.some((item) => item.route === "/details") && routeFacts.length <= budget.max_routes, JSON.stringify(routeFacts.map((item) => item.route)));
  check("m11.7-route-and-dom-state-are-fingerprinted", routeFacts.every((item) => typeof item.dom_fingerprint === "string") && new Set(routeFacts.map((item) => `${item.route}|${item.dom_fingerprint}`)).size === routeFacts.length);
  check("m11.7-default-exploration-is-read-only", mutations === 0 && interactions.every((item) => item.mutating === false));
  check("m11.7-mutating-controls-are-recorded-but-not-submitted", facts.some((item) => item.fact_type === "control" && item.control_id === "save" && item.mutating === true && item.exploration_allowed === false));
  check("m11.7-ui-mutations-are-associated-to-interactions", uiMutations.length > 0 && uiMutations.every((item) => item.interaction_fact_id && item.before_state && item.after_state));
  check("m11.7-interaction-network-response-correlation-is-preserved", facts.some((item) => item.fact_type === "endpoint" && item.interaction_fact_id) && facts.some((item) => item.fact_type === "runtime_response" && item.interaction_fact_id) && correlations.length > 0);
  check("m11.7-budget-is-persisted", result.budget.max_interactions_per_route === 6 && result.budget.max_routes === 3);

  const beforeTrusted = mutations;
  const trusted = await discovery.discover({ root: project, target_url: origin, budget: { ...budget, max_routes: 1 }, live_exploration_policy: { trusted: true, allow_mutating_interactions: true, isolated_fixture_strategy: true } });
  const trustedFacts = trusted.observations.filter((item) => item.kind === "fact");
  check("m11.7-trusted-isolated-policy-can-enable-mutation", mutations > beforeTrusted && trustedFacts.some((item) => item.fact_type === "interaction" && item.mutating === true && item.policy === "trusted_isolated"));
} finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(project, { recursive: true, force: true }); }

console.log(`\nM11 phase 7 live UI exploration verification: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
