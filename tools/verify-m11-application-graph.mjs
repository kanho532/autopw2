import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";

const root = path.resolve(import.meta.dirname, "..");
const load = async (relative) => import(pathToFileURL(path.join(root, relative)).href);
const graphModule = await load("packages/application-graph/dist/index.js");
const core = await load("packages/core/dist/index.js");
let passed = 0;
let failed = 0;
function check(name, value, detail = "") { if (value) { passed += 1; console.log("PASS", name, detail); } else { failed += 1; console.log("FAIL", name, detail); } }
function fact(fact_id, fact_type, fields) { return { observation_id: fact_id, kind: "fact", untrusted: true, fact_id, fact_type, confidence: 0.9, ...fields }; }

const observations = [
  fact("fact_users_list", "endpoint", { method: "GET", path_template: "/api/users", operation: "read", feature_id: "users", route: "/users", source_ref: { path: "src/users.ts", line: 10 } }),
  fact("fact_users_conflict", "endpoint", { method: "GET", path_template: "/api/users", operation: "summary", feature_id: "users", route: "/users", source_ref: { path: "src/users-client.ts", line: 5 } }),
  fact("fact_users_create", "endpoint", { method: "POST", path_template: "/api/users", operation: "create", feature_id: "users", route: "/users", source_ref: { path: "src/users.ts", line: 20 } }),
  fact("fact_users_item", "endpoint", { method: "GET", path_template: "/api/users/:id", operation: "read", feature_id: "users", route: "/users/:id", source_ref: { path: "src/users.ts", line: 30 } }),
  fact("fact_orders_list", "endpoint", { method: "GET", path_template: "/api/orders", operation: "read", feature_id: "orders", route: "/orders", source_ref: { path: "src/orders.ts", line: 10 } }),
  fact("fact_orders_create", "endpoint", { method: "POST", path_template: "/api/orders", operation: "create", feature_id: "orders", route: "/orders", source_ref: { path: "src/orders.ts", line: 20 } }),
  fact("fact_orders_item", "endpoint", { method: "GET", path_template: "/api/orders/:id", operation: "read", feature_id: "orders", route: "/orders/:id", source_ref: { path: "src/orders.ts", line: 30 } }),
  fact("fact_user_name", "validation", { field: "name", rule: "required", feature_id: "users", route: "/users", source_ref: { path: "src/users-form.tsx", line: 8 } }),
  fact("fact_order_total", "validation", { field: "total", rule: "minimum", value: 0, feature_id: "orders", route: "/orders", source_ref: { path: "src/order-form.tsx", line: 8 } }),
  fact("fact_search_control", "control", { control_id: "search", role: "searchbox", accessible_name: "Search users", locator: "#search", feature_id: "users", route: "/users", source_ref: { path: "<live>", line: 1 } }),
  fact("fact_search_correlation", "correlation", { relation: "control_api", control_fact_id: "fact_search_control", endpoint_fact_id: "fact_users_list", source_ref: { path: "<correlation>" } })
];
const first = graphModule.buildApplicationGraph({ observations });
const second = graphModule.buildApplicationGraph({ observations: [...observations].reverse() });
const serialized = JSON.stringify(first);
const evidenceIds = new Set(first.evidence.evidence.map((item) => item.evidence_id));
const allNodes = Object.values(first.graph.nodes).flat();
const nodeIds = new Set(allNodes.map((item) => item.id));

check("m11-graph-build-is-deterministic", serialized === JSON.stringify(second));
check("m11-multi-resource-grouping-stays-separated", first.graph.nodes.resources.map((item) => item.collection_path).sort().join(",") === "/api/orders,/api/users");
check("m11-same-method-operations-bind-to-correct-resource", first.graph.nodes.operations.filter((item) => item.method === "GET" && !item.path_template.includes(":id")).every((item) => first.graph.nodes.resources.find((resource) => resource.id === item.resource_id)?.collection_path === item.path_template));
check("m11-all-graph-nodes-have-evidence", allNodes.length > 0 && allNodes.every((item) => item.evidence_refs.length > 0 && item.evidence_refs.every((ref) => evidenceIds.has(ref))));
check("m11-all-graph-edges-have-evidence-and-valid-endpoints", first.graph.edges.length > 0 && first.graph.edges.every((item) => item.evidence_refs.length > 0 && item.evidence_refs.every((ref) => evidenceIds.has(ref)) && nodeIds.has(item.from) && nodeIds.has(item.to)));
check("m11-conflicting-operation-evidence-is-diagnostic", first.diagnostics.diagnostics.some((item) => item.code === "CONFLICTING_OPERATION_EVIDENCE" && item.evidence_refs.length === 2));
check("m11-weak-field-associations-remain-diagnostic", first.diagnostics.diagnostics.filter((item) => item.code === "WEAK_ASSOCIATION").length === 2);
check("m11-source-kinds-preserve-provenance", ["REGEX", "DOM", "INFERRED"].every((kind) => first.evidence.evidence.some((item) => item.source_kind === kind)));
check("m11-fields-bind-only-to-their-resource", first.graph.nodes.fields.every((field) => first.graph.nodes.resources.find((resource) => resource.id === field.resource_id)?.collection_path === (field.name === "name" ? "/api/users" : "/api/orders")));

const ajv = new Ajv({ strict: true });
for (const [name, schemaFile, value] of [
  ["evidence", "evidence.schema.json", first.evidence],
  ["application-graph", "application-graph.schema.json", first.graph],
  ["graph-diagnostics", "graph-diagnostics.schema.json", first.diagnostics]
]) {
  const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(root, "packages", "application-graph", "schema", schemaFile), "utf8")));
  check(`m11-${name}-matches-versioned-schema`, validate(value), JSON.stringify(validate.errors || []));
}

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m11-preview-"));
try {
  const runtime = new core.AuditVerticalSlice({ root: path.join(root, "apps", "todo-fixture-target"), dataRoot });
  const preview = await runtime.preview({ operationId: "op_m11_preview", request: { project_subpath: ".", profile_path: "profiles/default/profile.json", base_tier: "fast", tier: "fast", __allowed_origins: ["http://127.0.0.1:*"] } });
  const previewRoot = path.join(dataRoot, "runs", "run_m11_preview");
  const persisted = ["evidence-facts.json", "application-graph.json", "graph-diagnostics.json"].every((name) => fs.existsSync(path.join(previewRoot, name)));
  const graph = persisted ? JSON.parse(fs.readFileSync(path.join(previewRoot, "application-graph.json"), "utf8")) : {};
  check("m11-preview-persists-evidence-graph-and-diagnostics", persisted && preview.application_graph.graph_id === graph.graph_id);
} finally {
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

console.log(`\nM11 ApplicationGraph verification: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
