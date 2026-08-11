import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const load = async (relative) => import(pathToFileURL(path.join(root, relative)).href);
const discoveryModule = await load("packages/discovery/dist/index.js");
const graphModule = await load("packages/application-graph/dist/index.js");
const synthesisModule = await load("packages/payload-synthesis/dist/index.js");
const derivation = await load("packages/derivation/dist/index.js");
const planner = await load("packages/planner/dist/index.js");
const compiler = await load("packages/compiler/dist/index.js");
let passed = 0; let failed = 0;
function check(name, value, detail = "") { if (value) { passed += 1; console.log("PASS", name, detail); } else { failed += 1; console.log("FAIL", name, detail); } }

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m11-payload-"));
fs.writeFileSync(path.join(fixture, "openapi.yaml"), `openapi: 3.1.0
info: { title: Payload Synthesis Fixture, version: 1.0.0 }
paths:
  /api/users:
    post:
      tags: [users]
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/UserInput' } } } }
      responses:
        '201': { description: created, content: { application/json: { schema: { $ref: '#/components/schemas/User' } } } }
        '400': { description: invalid }
  /api/users/{userId}:
    get: { tags: [users], responses: { '200': { description: ok }, '404': { description: missing } } }
    patch:
      tags: [users]
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/UserInput' } } } }
      responses: { '200': { description: updated }, '400': { description: invalid } }
    delete: { tags: [users], responses: { '204': { description: deleted } } }
  /api/orders:
    post:
      tags: [orders]
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/OrderInput' } } } }
      responses:
        '201': { description: created, headers: { Location: { schema: { type: string } } } }
        '400': { description: invalid }
  /api/orders/{orderId}:
    get: { tags: [orders], responses: { '200': { description: ok } } }
    delete: { tags: [orders], responses: { '204': { description: deleted } } }
  /api/reports/{reportId}:
    get: { tags: [reports], responses: { '200': { description: ok } } }
components:
  schemas:
    User:
      type: object
      properties: { id: { type: string }, name: { type: string }, role: { type: string } }
    UserInput:
      type: object
      required: [name, role]
      properties:
        name: { type: string, minLength: 3, maxLength: 20, example: Alice }
        role: { type: string, enum: [admin, member] }
        age: { type: integer, minimum: 18, maximum: 120 }
        email: { type: string, format: email }
    OrderInput:
      type: object
      required: [sku]
      properties: { sku: { type: string, minLength: 2 }, quantity: { type: integer, minimum: 1 } }
`, "utf8");

try {
  const discovery = await discoveryModule.discover({ root: fixture, budget: { max_files: 20, static_timeout_ms: 5000 } });
  const built = graphModule.buildApplicationGraph(discovery);
  const synthesized = synthesisModule.synthesizeApplicationPayloads(built.graph);
  const users = built.graph.nodes.resources.find((item) => item.collection_path === "/api/users");
  const orders = built.graph.nodes.resources.find((item) => item.collection_path === "/api/orders");
  const reports = built.graph.nodes.resources.find((item) => item.operation_ids.some((id) => built.graph.nodes.operations.find((operation) => operation.id === id)?.feature_ids.includes("reports")));
  const usersCreate = built.graph.nodes.operations.find((item) => item.resource_id === users?.id && item.method === "POST");
  const userPayload = synthesized.payloads.find((item) => item.operation_id === usersCreate?.id);
  check("m11.4-schema-fields-retain-types-and-examples", built.graph.nodes.fields.some((item) => item.name === "name" && item.schema_types.includes("string") && item.examples.includes("Alice")));
  check("m11.4-valid-payload-is-deterministic", userPayload?.valid.name === "Alice" && userPayload.valid.role === "admin" && userPayload.valid.age === 18 && userPayload.valid.email === "autopw@example.test");
  check("m11.4-invalid-and-boundary-variants-are-independent", userPayload?.invalid.some((item) => item.rule === "required" && !("name" in item.payload)) && userPayload.invalid.some((item) => item.rule === "enum") && userPayload.boundaries.some((item) => item.rule === "min_length"));
  const userFixture = synthesized.fixtures.find((item) => item.resource_id === users?.id);
  const orderFixture = synthesized.fixtures.find((item) => item.resource_id === orders?.id);
  check("m11.4-response-schema-identity-is-resolved", userFixture?.identity.kind === "response_body" && userFixture.identity.path === "id" && userFixture.proven);
  check("m11.4-location-header-identity-is-resolved", orderFixture?.identity.kind === "location_header" && orderFixture.identity.header === "location" && orderFixture.proven);
  check("m11.4-fixture-operations-stay-with-resource", synthesized.fixtures.every((item) => item.operation_ids.every((operationId) => built.graph.nodes.resources.find((resource) => resource.id === item.resource_id)?.operation_ids.includes(operationId))));
  const reportFixture = synthesized.fixtures.find((item) => item.resource_id === reports?.id);
  check("m11.4-read-only-resource-blocks-without-explicit-fixture", reportFixture?.kind === "blocked" && reportFixture.reason === "EXPLICIT_SEED_OR_MANUAL_FIXTURE_REQUIRED");
  const overridden = synthesisModule.synthesizeApplicationPayloads(built.graph, { [reports.id]: { kind: "seed", identity: "report-1", read_path: "/api/reports/report-1" } });
  check("m11.4-explicit-seed-unblocks-read-only-resource", overridden.fixtures.find((item) => item.resource_id === reports.id)?.proven === true);

  const requirements = derivation.deriveRequirements({ discovery, application_graph: built.graph, evidence: built.evidence, tier: "full", destructive_allowed: true });
  const detail = requirements.find((item) => item.resource_id === users.id && item.intent === "route_detail");
  check("m11.4-requirement-carries-synthesized-fixture-and-payload", detail?.status === "REQUIRED" && detail.fixture_strategy.create?.path === "/api/users" && detail.fixture_strategy.read?.path === "/api/users/:userId" && detail.payload_strategy.valid_payload?.name === "Alice");
  const catalog = planner.buildCandidateCatalog({ discovery, requirements });
  const skeletons = planner.buildRequirementPlannerInput(requirements, catalog);
  const output = await new planner.DeterministicFixturePlanner().fill({ schemaVersion: "2.1", skeletons, candidates: catalog, contractRefs: [], untrustedObservations: [] }, { provider_id: "fixture-deterministic", provider_version: "1", model_id: "local", timeout_ms: 1000, token_budget: 1000, temperature: 0 });
  const compiled = compiler.compileTestPlan({ requirements, candidateCatalog: catalog, plannerOutput: output });
  const detailCase = compiled.plan.cases.find((item) => item.requirement_refs.includes(detail.requirement_id));
  check("m11.4-compiler-uses-resource-create-not-first-catalog-post", detailCase?.setup?.[0]?.path === "/api/users" && JSON.stringify(detailCase).includes("/api/users/${responses.") && !JSON.stringify(detailCase).includes("/api/orders/${responses."));
  const orderDetail = requirements.find((item) => item.resource_id === orders.id && item.intent === "route_detail");
  const orderCase = compiled.plan.cases.find((item) => item.requirement_refs.includes(orderDetail.requirement_id));
  check("m11.4-compiler-supports-location-identity", JSON.stringify(orderCase).includes("${responses.setup_") && JSON.stringify(orderCase).includes("headers.location"));
  const repeated = synthesisModule.synthesizeApplicationPayloads(built.graph);
  check("m11.4-synthesis-output-is-deterministic", JSON.stringify(synthesized) === JSON.stringify(repeated));
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }

console.log(`\nM11 phase 4 payload synthesis verification: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
