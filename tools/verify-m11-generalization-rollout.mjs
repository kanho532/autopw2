import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const load = async (relative) => import(pathToFileURL(path.join(root, relative)).href);
const discoveryModule = await load("packages/discovery/dist/index.js");
const graphModule = await load("packages/application-graph/dist/index.js");
const synthesisModule = await load("packages/payload-synthesis/dist/index.js");
const triageModule = await load("packages/triage/dist/index.js");
const coreModule = await load("packages/core/dist/index.js");
let passed = 0;
let failed = 0;
function check(name, value, detail = "") { if (value) { passed += 1; console.log("PASS", name, detail); } else { failed += 1; console.log("FAIL", name, detail); } }

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m11-generalization-"));
const urlOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m11-url-only-"));
const rolloutDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m11-rollout-artifacts-"));
fs.mkdirSync(path.join(fixture, "app", "api", "reports", "[id]"), { recursive: true });
fs.writeFileSync(path.join(fixture, "openapi.json"), JSON.stringify({
  openapi: "3.1.0", info: { title: "Generalization API", version: "1" },
  paths: {
    "/api/users": {
      get: { operationId: "listUsers", tags: ["users"], responses: { "200": { description: "ok" } } },
      post: { operationId: "createUser", tags: ["users"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/UserInput" } } } }, responses: { "201": { description: "created", content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } } }
    },
    "/api/users/{id}": {
      get: { operationId: "getUser", tags: ["users"], responses: { "200": { description: "ok" } } },
      patch: { operationId: "updateUser", tags: ["users"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/UserInput" } } } }, responses: { "200": { description: "ok" } } },
      delete: { operationId: "deleteUser", tags: ["users"], responses: { "204": { description: "deleted" } } }
    },
    "/api/catalog": { get: { operationId: "catalog", tags: ["catalog"], responses: { "200": { description: "ok" } } } },
    "/api/reports?page=1&limit=20": { get: { operationId: "reports", tags: ["reports"], security: [{ oauth: ["reports:read"] }], responses: { "200": { description: "ok" } } } }
  },
  components: { schemas: {
    UserInput: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 2 }, role: { type: "string", enum: ["admin", "member"] } } },
    User: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } }
  } }
}, null, 2), "utf8");
fs.writeFileSync(path.join(fixture, "clients.ts"), `
import axios from "axios";
export const users = () => axios.get("/api/users");
export const graphUsers = () => apollo.query({ query: gql\`query Users { users { id } }\` });
export const rpcUsers = () => trpc.user.list.query();
`, "utf8");
fs.writeFileSync(path.join(fixture, "nested-router.ts"), `
app.use("/api", apiRouter);
apiRouter.use("/v1", usersRouter);
usersRouter.get("/nested-users", handler);
`, "utf8");
fs.writeFileSync(path.join(fixture, "app", "api", "reports", "[id]", "route.ts"), `export async function GET() { return Response.json({ ok: true }); }`, "utf8");

const server = http.createServer((request, response) => {
  if (request.url === "/api/url-only") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); return; }
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<html><body><a href="/details">Details</a><button id="load">Load</button><script>fetch('/api/url-only')</script></body></html>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const targetUrl = `http://127.0.0.1:${address.port}`;

try {
  const discovery = await discoveryModule.discover({ root: fixture, budget: { max_files: 100, static_timeout_ms: 5000 } });
  const urlOnly = await discoveryModule.discover({ root: urlOnlyRoot, target_url: targetUrl, budget: { max_files: 10, static_timeout_ms: 1000, live_timeout_ms: 5000, route_timeout_ms: 2000, max_interactions_per_route: 0, allowed_origins: [targetUrl] } });
  const facts = discovery.observations.filter((item) => item.kind === "fact");
  const endpoints = facts.filter((item) => item.fact_type === "endpoint");
  const built = graphModule.buildApplicationGraph(discovery);
  const reportResource = built.graph.nodes.resources.find((item) => item.collection_path === "/api/reports");
  const synthesis = synthesisModule.synthesizeApplicationPayloads(built.graph, reportResource ? { [reportResource.id]: { kind: "seed", identity: "report-1", read_path: "/api/reports/report-1" } } : {});
  const rollout = graphModule.buildApplicationGraphRolloutSnapshot({ discovery, graph: built.graph, requirement_ids: built.graph.nodes.operations.map((item) => `requirement:${item.id}`) });
  const generatorDecisions = [
    triageModule.triageFailure({ plan_origin: "generated", case_confidence: 0.95, evidence_refs: ["evidence:contract"], signal: { kind: "contract", phase: "test" } }),
    triageModule.triageFailure({ plan_origin: "generated", case_confidence: 0.95, evidence_refs: ["evidence:setup"], signal: { kind: "assertion", phase: "setup" } }),
    triageModule.triageFailure({ plan_origin: "generated", case_confidence: 0.2, signal: { kind: "unknown", phase: "test" } })
  ];
  const capabilities = {
    rest_multi_resource: built.graph.nodes.resources.some((item) => item.collection_path === "/api/users") && built.graph.nodes.resources.some((item) => item.collection_path === "/api/catalog"),
    axios: endpoints.some((item) => item.adapter === "axios"),
    nested_router: endpoints.some((item) => item.adapter === "server-router" && item.path_template === "/api/v1/nested-users"),
    nextjs: endpoints.some((item) => item.adapter === "nextjs-route" && item.path_template === "/api/reports/:id"),
    openapi_only: endpoints.some((item) => item.adapter === "openapi" && item.path_template === "/api/catalog"),
    rbac: endpoints.some((item) => item.adapter === "openapi" && item.auth_required === true && item.auth_scopes?.includes("oauth:reports:read")),
    pagination: built.graph.nodes.operations.some((item) => item.operation_kinds.includes("pagination")),
    seeded_data: synthesis.fixtures.some((item) => item.resource_id === reportResource?.id && item.kind === "seed" && item.proven),
    read_only: Boolean(reportResource) && !built.graph.nodes.operations.some((item) => item.resource_id === reportResource.id && item.method === "POST"),
    graphql: built.graph.nodes.operations.some((item) => item.protocol === "GRAPHQL" && item.operation_kinds.includes("graphql_query")),
    rpc: built.graph.nodes.operations.some((item) => item.protocol === "RPC" && item.operation_kinds.includes("rpc_query")),
    url_only: urlOnly.budget.files_scanned === 0 && urlOnly.observations.some((item) => item.kind === "fact" && (item.fact_type === "route" || item.fact_type === "endpoint"))
  };
  const acceptance = graphModule.evaluateGeneralizationAcceptance({ capabilities, graph: built.graph, fixtures: synthesis.fixtures, controlled_generator_classifications: generatorDecisions.map((item) => item.classification), dual_mode_snapshot: rollout });

  check("m11.8-generalization-target-matrix", Object.values(capabilities).every(Boolean), JSON.stringify(capabilities));
  check("m11.8-application-graph-dual-mode-is-non-authoritative-shadow", rollout.mode === "dual" && rollout.authoritative_lane === "application_graph" && rollout.shadow_lane === "legacy_observations" && rollout.application_graph.operation_count > 0);
  check("m11.8-read-only-resource-requires-explicit-seed", Boolean(reportResource) && synthesis.fixtures.some((item) => item.resource_id === reportResource.id && item.kind === "seed" && item.proven));
  check("m11.8-zero-cross-resource-fixture-bindings", acceptance.cross_resource_fixture_bindings.length === 0);
  check("m11.8-zero-false-product-defects-for-generator-errors", acceptance.false_product_defects === 0 && generatorDecisions.every((item) => item.classification !== "PRODUCT_DEFECT"), JSON.stringify(generatorDecisions.map((item) => item.classification)));
  check("m11.8-rollout-gate-ready", acceptance.status === "READY", JSON.stringify(acceptance.blockers));
  const runtime = new coreModule.AuditVerticalSlice({ root: fixture, dataRoot: rolloutDataRoot, targetProvider: new coreModule.ExternalTargetProvider(targetUrl) });
  const preview = await runtime.preview({ operationId: "op_m11_phase8", request: { project_subpath: ".", profile_path: "profiles/default/profile.json", base_tier: "fast", tier: "fast", __allowed_origins: [targetUrl] } });
  const persistedRollout = path.join(rolloutDataRoot, "runs", "run_m11_phase8", "application-graph-rollout.json");
  const persistedSnapshot = fs.existsSync(persistedRollout) ? JSON.parse(fs.readFileSync(persistedRollout, "utf8")) : {};
  check("m11.8-core-persists-dual-mode-rollout", preview.rollout?.mode === "dual" && persistedSnapshot.schema_version === graphModule.APPLICATION_GRAPH_ROLLOUT_SCHEMA_VERSION && persistedSnapshot.application_graph?.graph_id === preview.application_graph.graph_id);
  const tamperedFixture = synthesis.fixtures.find((item) => item.operation_ids.length > 0);
  const foreignOperation = tamperedFixture && built.graph.nodes.operations.find((item) => item.resource_id !== tamperedFixture.resource_id);
  const blocked = tamperedFixture && foreignOperation ? graphModule.evaluateGeneralizationAcceptance({ capabilities, graph: built.graph, fixtures: [{ resource_id: tamperedFixture.resource_id, operation_ids: [foreignOperation.id] }], controlled_generator_classifications: ["PRODUCT_DEFECT"], dual_mode_snapshot: rollout }) : undefined;
  check("m11.8-rollout-gate-blocks-regressions", blocked?.status === "BLOCKED" && blocked.cross_resource_fixture_bindings.length === 1 && blocked.false_product_defects === 1);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(urlOnlyRoot, { recursive: true, force: true });
  fs.rmSync(rolloutDataRoot, { recursive: true, force: true });
}

console.log(`\nM11 phase 8 generalization rollout verification: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
