import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const load = async (relative) => import(pathToFileURL(path.join(root, relative)).href);
const discoveryModule = await load("packages/discovery/dist/index.js");
const graphModule = await load("packages/application-graph/dist/index.js");
const derivation = await load("packages/derivation/dist/index.js");
let passed = 0;
let failed = 0;
function check(name, value, detail = "") { if (value) { passed += 1; console.log("PASS", name, detail); } else { failed += 1; console.log("FAIL", name, detail); } }

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m11-requirements-"));
fs.writeFileSync(path.join(fixture, "openapi.yaml"), `openapi: 3.1.0
info: { title: Requirement Engine Fixture, version: 1.0.0 }
paths:
  /api/users:
    get:
      tags: [users]
      responses: { '200': { description: ok } }
    post:
      tags: [users]
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UserInput' }
      responses: { '201': { description: created }, '400': { description: invalid } }
  /api/users/{id}:
    get:
      tags: [users]
      responses: { '200': { description: ok }, '404': { description: missing } }
    patch:
      tags: [users]
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UserInput' }
      responses: { '200': { description: updated }, '400': { description: invalid } }
    delete:
      tags: [users]
      responses: { '204': { description: deleted } }
  /api/orders:
    get:
      tags: [orders]
      responses: { '200': { description: ok } }
    post:
      tags: [orders]
      responses: { '201': { description: created } }
components:
  schemas:
    UserInput:
      type: object
      required: [name]
      properties:
        name: { type: string, minLength: 2, maxLength: 80 }
        role: { type: string, enum: [admin, member] }
        age: { type: integer, minimum: 18, maximum: 120 }
        email: { type: string, format: email }
`, "utf8");

try {
  const discovery = await discoveryModule.discover({ root: fixture, budget: { max_files: 20, static_timeout_ms: 5000 } });
  discovery.observations.push({ observation_id: "fact_user_onboarding", kind: "fact", untrusted: true, fact_id: "fact_user_onboarding", fact_type: "workflow", name: "user onboarding", operation_fact_ids: [], confidence: 0.8, source_kind: "MANUAL", source_ref: { path: "workflow.yaml" } });
  const built = graphModule.buildApplicationGraph(discovery);
  const requirements = derivation.deriveRequirements({ discovery, application_graph: built.graph, evidence: built.evidence, tier: "full", destructive_allowed: true });
  const operationById = new Map(built.graph.nodes.operations.map((item) => [item.id, item]));
  const resourceById = new Map(built.graph.nodes.resources.map((item) => [item.id, item]));
  const constraintRules = new Set(requirements.filter((item) => item.field_id).map((item) => item.payload_strategy.rule));
  check("m11.3-requirements-are-derived-per-operation", built.graph.nodes.operations.every((operation) => requirements.some((item) => item.operation_id === operation.id)), JSON.stringify({ operations: built.graph.nodes.operations.length, requirements: requirements.length }));
  check("m11.3-multi-resource-bindings-never-cross", requirements.filter((item) => item.operation_id && item.resource_id).every((item) => resourceById.get(item.resource_id)?.operation_ids.includes(item.operation_id)));
  check("m11.3-validation-atoms-are-split", ["required", "min_length", "max_length", "enum", "minimum", "maximum", "format"].every((rule) => constraintRules.has(rule)), JSON.stringify([...constraintRules].sort()));
  check("m11.3-requirements-carry-graph-and-evidence-provenance", requirements.every((item) => item.evidence_refs.length > 0 && (item.operation_id || item.workflow_id) && item.oracle_specification && item.fixture_strategy && item.payload_strategy));
  check("m11.3-source-refs-remain-compatible-fact-ids", requirements.every((item) => item.source_refs.every((ref) => ref.startsWith("fact_"))));
  const usersResource = built.graph.nodes.resources.find((item) => item.collection_path === "/api/users");
  const ordersResource = built.graph.nodes.resources.find((item) => item.collection_path === "/api/orders");
  check("m11.3-user-fields-bind-only-to-users", built.graph.nodes.fields.filter((item) => item.resource_id).every((field) => field.resource_id === usersResource?.id) && !built.graph.nodes.fields.some((field) => field.resource_id === ordersResource?.id));
  const ordersCreate = requirements.find((item) => item.resource_id === ordersResource?.id && operationById.get(item.operation_id)?.method === "POST");
  check("m11.3-unproven-payload-or-fixture-is-blocked", ordersCreate?.status === "BLOCKED" && ["PAYLOAD_SYNTHESIS_PENDING", "MISSING_RESOURCE_FIXTURE_OPERATION"].includes(ordersCreate.reason));
  check("m11.3-read-contract-with-declared-oracle-remains-required", requirements.some((item) => item.resource_id === ordersResource?.id && item.intent === "route_loads" && item.status === "REQUIRED" && item.oracle_specification.proven));
  check("m11.3-workflow-without-oracle-is-explicitly-blocked", requirements.some((item) => item.workflow_id && item.status === "BLOCKED" && item.reason === "MISSING_WORKFLOW_ORACLE"));
  const repeated = derivation.deriveRequirements({ discovery, application_graph: built.graph, evidence: built.evidence, tier: "full", destructive_allowed: true });
  check("m11.3-requirement-output-is-deterministic", JSON.stringify(requirements) === JSON.stringify(repeated));
  const coverage = derivation.deriveCoverage({ discovery, application_graph: built.graph, evidence: built.evidence, tier: "full", matrix: { browsers: ["chromium"], viewports: [{ width: 1280, height: 720 }], locales: ["en-US"], auth_scope_ids: ["as_demo"] } });
  check("m11.3-cdd-persists-v2-requirement-metadata", coverage.cdd.requirements.every((item) => item.evidence_refs && item.oracle_specification && item.fixture_strategy && item.payload_strategy));
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log(`\nM11 phase 3 Requirement Engine verification: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
