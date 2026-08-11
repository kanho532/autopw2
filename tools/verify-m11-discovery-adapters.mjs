import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const load = async (relative) => import(pathToFileURL(path.join(root, relative)).href);
const discoveryModule = await load("packages/discovery/dist/index.js");
const graphModule = await load("packages/application-graph/dist/index.js");
let passed = 0;
let failed = 0;
function check(name, value, detail = "") { if (value) { passed += 1; console.log("PASS", name, detail); } else { failed += 1; console.log("FAIL", name, detail); } }

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m11-discovery-"));
fs.mkdirSync(path.join(fixture, "app", "api", "reports", "[id]"), { recursive: true });
fs.writeFileSync(path.join(fixture, "openapi.yaml"), `openapi: 3.1.0
info:
  title: Multi resource API
  version: 1.0.0
paths:
  /api/users:
    get:
      operationId: listUsers
      tags: [users]
      responses:
        '200': { description: ok }
    post:
      operationId: createUser
      tags: [users]
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/UserInput'
      responses:
        '201': { description: created }
components:
  schemas:
    UserInput:
      type: object
      required: [name]
      properties:
        name: { type: string, minLength: 2, maxLength: 80 }
        role: { type: string, enum: [admin, member] }
        email: { type: string, format: email }
`, "utf8");
fs.writeFileSync(path.join(fixture, "client.ts"), `
  import axios from "axios";
  export const users = () => axios.get("/api/users");
  export const create = (body: unknown) => axios.post("/api/users", body);
  export const update = (id: string) => apiRequest({ method: "PATCH", url: \`/api/users/\${id}\` });
`, "utf8");
fs.writeFileSync(path.join(fixture, "orders.controller.ts"), `
  @Controller("api/orders")
  export class OrdersController {
    @Get(":id") detail() {}
    @Post() create() {}
  }
`, "utf8");
fs.writeFileSync(path.join(fixture, "fastify.ts"), `fastify.get("/api/orders", async () => []);`, "utf8");
fs.writeFileSync(path.join(fixture, "app", "api", "reports", "[id]", "route.ts"), `export async function GET() { return Response.json({}); }`, "utf8");
fs.writeFileSync(path.join(fixture, "fallback.html"), `<script>fetch('/api/fallback')</script>`, "utf8");
fs.writeFileSync(path.join(fixture, "product.schema.json"), JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: "products", type: "object", "x-autopw-resource-path": "/api/products", required: ["sku"], properties: { sku: { type: "string", pattern: "^[A-Z]+$" }, price: { type: "number", minimum: 0 } } }), "utf8");

const server = http.createServer((request, response) => {
  if (request.url === "/api/runtime") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); return; }
  response.writeHead(200, { "content-type": "text/html" }); response.end(`<html><body><button id="load">Load</button><script>fetch('/api/runtime')</script></body></html>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const targetUrl = `http://127.0.0.1:${address.port}`;
try {
  const discovery = await discoveryModule.discover({ root: fixture, target_url: targetUrl, budget: { max_files: 100, static_timeout_ms: 5000, live_timeout_ms: 5000, route_timeout_ms: 3000, allowed_origins: [targetUrl] } });
  const facts = discovery.observations.filter((item) => item.kind === "fact");
  const endpoints = facts.filter((item) => item.fact_type === "endpoint");
  const adapters = new Set(endpoints.map((item) => item.adapter));
  check("m11.2-openapi-and-json-schema-constraints", ["required", "minLength", "maxLength", "enum", "format", "pattern", "minimum"].every((rule) => facts.some((item) => item.fact_type === "validation" && item.rule === rule)));
  check("m11.2-ast-adapters-cover-client-and-server-frameworks", ["axios", "request-wrapper", "nestjs", "fastify", "nextjs-route"].every((adapter) => adapters.has(adapter)), JSON.stringify([...adapters].sort()));
  check("m11.2-regex-is-calibrated-fallback", endpoints.some((item) => item.path_template === "/api/fallback" && item.source_kind === "REGEX" && item.confidence <= 0.5));
  check("m11.2-runtime-request-response-evidence", endpoints.some((item) => item.path_template === "/api/runtime" && item.source_kind === "RUNTIME") && facts.some((item) => item.fact_type === "runtime_response" && item.path_template === "/api/runtime" && item.status === 200));
  check("m11.2-next-route-parameters-are-normalized", endpoints.some((item) => item.adapter === "nextjs-route" && item.path_template === "/api/reports/:id"));
  const built = graphModule.buildApplicationGraph(discovery);
  const userList = built.graph.nodes.operations.find((item) => item.method === "GET" && item.path_template === "/api/users");
  check("m11.2-fusion-preserves-multiple-sources-per-claim", userList?.evidence_refs.length === 2 && userList.evidence_refs.every((ref) => built.evidence.evidence.some((evidence) => evidence.evidence_id === ref)));
  check("m11.2-fused-graph-remains-deterministic", JSON.stringify(built) === JSON.stringify(graphModule.buildApplicationGraph({ ...discovery, observations: [...discovery.observations].reverse() })));
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log(`\nM11 phase 2 discovery verification: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
