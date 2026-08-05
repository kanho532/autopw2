// Shared JSON Schema building blocks (defs) referenced from every persistent
// schema and tool contract. Build common.schema.json from ENUMS + LIMITS so
// enum literals live in exactly one place and resolve through one defs registry.
import { ENUMS } from "./enums.mjs";
import { LIMITS } from "./limits.mjs";

export const SCHEMA_BASE = "https://autopw.dev/schemas/2.1";
export const CONTRACT_BASE = "https://autopw.dev/contracts/2.1";

// Absolute ref helpers - always resolve against a registered id.
export const ref = {
  def: (n) => SCHEMA_BASE + "/common.schema.json#/$defs/" + n,
  enum: (n) => SCHEMA_BASE + "/common.schema.json#/$defs/enum/" + n,
  schema: (n) => SCHEMA_BASE + "/" + n + ".schema.json",
  tool: (n) => CONTRACT_BASE + "/tools/" + n + ".tool.json"
};

function idField(key, desc) {
  const l = LIMITS[key];
  return { type: "string", description: desc, maxLength: l.max, pattern: l.pattern };
}

export function buildCommonDefs() {
  const defs = {};
  defs["enum"] = {};
  for (const [key, vals] of Object.entries(ENUMS)) {
    defs["enum"][key] = { type: "string", enum: [...vals] };
  }
  defs.schemaVersion = { type: "string", pattern: LIMITS.schemaVersionPattern, description: "AutoPW protocol version" };
  defs.workspaceId = idField("workspaceId", "Host-issued workspace identifier");
  defs.projectSubpath = idField("projectSubpath", "Project subpath inside authorized workspace realpath");
  defs.clientRequestId = idField("clientRequestId", "Idempotency key for create-type MCP calls");
  defs.operationId = idField("operationId", "Stable Operation identifier");
  defs.runId = idField("runId", "Stable Run identifier");
  defs.handleToken = idField("handleToken", "Unguessable run handle token");
  defs.caseId = idField("caseId", "Stable logical case identifier");
  defs.executionId = idField("executionId", "Compute execution instance identifier");
  defs.batchId = idField("batchId", "Execution batch identifier");
  defs.featureId = idField("featureId", "Feature identifier");
  defs.isoTimestamp = { type: "string", format: "date-time" };
  defs.untrustedData = {
    oneOf: [
      { type: "string", maxLength: LIMITS.untrustedText.max },
      { type: "object", properties: { kind: { type: "string" }, value: { type: "string", maxLength: LIMITS.untrustedText.max } }, required: ["kind", "value"], additionalProperties: false }
    ],
    description: "Page content marked untrusted; never interpreted as control"
  };
  defs.descriptionText = { type: "string", maxLength: LIMITS.descriptionText.max, description: "Render-only text escaped before display" };
  defs.artifactRef = { type: "object", properties: { handle: { type: "string" }, kind: { type: "string" }, size_bytes: { type: "integer", minimum: 0 } }, required: ["handle", "kind"], additionalProperties: false, description: "Opaque artifact reference; no host absolute path returned" };
  defs.errorEnvelope = { $ref: ref.schema("mcp-error-envelope") };
  return defs;
}

export function buildCommonSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: ref.schema("common"),
    title: "AutoPW common definitions",
    description: "Shared enums identifiers and envelope defs referenced by all AutoPW schemas and tool contracts.",
    type: "object",
    $defs: buildCommonDefs()
  };
}
