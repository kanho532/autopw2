// M0 generator: serializes the single-source definitions to concrete JSON files
// (schemas bundle, tool contracts, host-context contract, fixtures, manifests).
import fs from "node:fs";
import path from "node:path";
import { buildCommonSchema, ref } from "../packages/schemas/src/common.mjs";
import { buildSchemas } from "../packages/schemas/src/schemas.mjs";
import { buildToolContracts, TOOL_NAMES } from "../packages/mcp-contracts/src/tools.mjs";
import { HOST_CONTEXT_CONTRACT } from "../packages/mcp-contracts/src/host-context.mjs";
import { PERSISTENT_FIXTURES, HOST_CONTEXT_FIXTURES, TRANSITION_FIXTURES } from "../packages/mcp-contracts/src/fixtures.mjs";
import { ENUMS, ENUM_KEYS } from "../packages/schemas/src/enums.mjs";
import { TRANSITIONS } from "../packages/schemas/src/state-machine.mjs";

const root = path.resolve(import.meta.dirname, "..");
const schemasDir = path.join(root, "packages", "schemas", "schemas");
const toolsDir = path.join(root, "packages", "mcp-contracts", "contracts", "tools");
const contractsDir = path.join(root, "packages", "mcp-contracts", "contracts");
const persistFixDir = path.join(root, "fixtures", "persistents");
const hostCtxDir = path.join(root, "fixtures", "host-contexts");
const runStatesDir = path.join(root, "fixtures", "run-states");

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

mkdir(schemasDir); mkdir(toolsDir); mkdir(contractsDir); mkdir(persistFixDir); mkdir(hostCtxDir); mkdir(runStatesDir);

const stats = { schemas: 0, tools: 0, fixtures: 0, manifests: 0 };

// 1. common schema bundle
writeJson(path.join(schemasDir, "common.schema.json"), buildCommonSchema());
stats.schemas++;
// 2. all persistent schemas
const S = buildSchemas();
for (const [name, schema] of Object.entries(S)) {
  writeJson(path.join(schemasDir, name + ".schema.json"), schema);
  stats.schemas++;
}
// schema manifest (canonical $ids)
writeJson(path.join(schemasDir, "manifest.json"), {
  schema_version: "2.1",
  count: Object.keys(S).length + 1,
  schemas: ["common", ...Object.keys(S)].map((n) => ref.schema(n))
});
stats.manifests++;

// 3. tool contracts
const T = buildToolContracts();
for (const name of TOOL_NAMES) {
  const c = T[name];
  writeJson(path.join(toolsDir, name + ".tool.json"), {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: ref.tool(name),
    name: c.name,
    description: c.description,
    input_schema: c.input_schema,
    result_union: c.result_union,
    creates_operation: c.creates_operation,
    requires_client_request_id: c.requires_client_request_id,
    async_default: c.async_default,
    retryable: c.retryable,
    authorization_scope: c.authorization_scope,
    returns_max_bytes: c.returns_max_bytes,
    examples: c.examples
  });
  stats.tools++;
}
writeJson(path.join(contractsDir, "host-context.contract.json"), HOST_CONTEXT_CONTRACT);
writeJson(path.join(contractsDir, "manifest.json"), {
  schema_version: "2.1",
  tools: TOOL_NAMES.map(ref.tool),
  host_context: HOST_CONTEXT_CONTRACT.$id
});
stats.manifests += 2;

// 4. persistent fixtures (positive + negative)
for (const [name, f] of Object.entries(PERSISTENT_FIXTURES)) {
  writeJson(path.join(persistFixDir, name + ".positives.json"), { schema: ref.schema(name), positive: f.positive });
  writeJson(path.join(persistFixDir, name + ".negatives.json"), { schema: ref.schema(name), negative: f.negative });
  stats.fixtures += 2;
}

// 5. host-context fixtures
writeJson(path.join(hostCtxDir, "trusted.json"), HOST_CONTEXT_FIXTURES.positive_trusted);
writeJson(path.join(hostCtxDir, "untrusted_pr.json"), HOST_CONTEXT_FIXTURES.positive_untrusted_pr);
writeJson(path.join(hostCtxDir, "agent-elevate-negatives.json"), HOST_CONTEXT_FIXTURES.negative_agent_elevate);
stats.fixtures += 3;

// 6. transition fixtures
writeJson(path.join(runStatesDir, "transitions.json"), TRANSITION_FIXTURES);
stats.fixtures++;

// 7. enum table used by docs consistency check
writeJson(path.join(root, "packages", "schemas", "enums-table.json"), {
  schema_version: "2.1",
  enums: Object.fromEntries(ENUM_KEYS.map((k) => [k, ENUMS[k]])),
  enum_keys: ENUM_KEYS
});
stats.manifests++;

// 8. transition table snapshot for docs check
writeJson(path.join(root, "packages", "schemas", "transitions.json"), {
  schema_version: "2.1",
  transitions: TRANSITIONS.map((t) => ({ ...t }))
});
stats.manifests++;

console.log("gen-m0 done:", stats);
