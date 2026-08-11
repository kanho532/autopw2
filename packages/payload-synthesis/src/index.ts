import type { ApplicationGraph, FieldNode, OperationNode, ResourceNode } from "@autopw/application-graph";

export const PAYLOAD_SYNTHESIS_SCHEMA_VERSION = "autopw.payload-synthesis/1.0" as const;

export interface OperationRef { operation_id: string; method: string; path: string; }
export interface IdentityStrategy { kind: "response_body" | "location_header" | "explicit" | "none"; path?: string; header?: string; proven: boolean; reason?: string; }
export interface PayloadVariant { field_id: string; field: string; rule: string; payload: Record<string, unknown>; }
export interface SynthesizedPayload {
  operation_id: string;
  resource_id: string;
  schema_refs: string[];
  valid: Record<string, unknown>;
  invalid: PayloadVariant[];
  boundaries: PayloadVariant[];
  proven: boolean;
  reason?: string;
}
export interface ResourceFixtureBinding {
  resource_id: string;
  kind: "resource_crud" | "seed" | "manual" | "blocked";
  create?: OperationRef;
  read?: OperationRef;
  update?: OperationRef;
  cleanup?: OperationRef;
  payload?: Record<string, unknown>;
  identity: IdentityStrategy;
  operation_ids: string[];
  proven: boolean;
  reason?: string;
}
export interface FixtureOverride { kind: "seed" | "manual"; identity: string | number; read_path?: string; cleanup_path?: string; }
export interface PayloadSynthesisResult {
  schema_version: typeof PAYLOAD_SYNTHESIS_SCHEMA_VERSION;
  payloads: SynthesizedPayload[];
  fixtures: ResourceFixtureBinding[];
}

export function synthesizeApplicationPayloads(graph: ApplicationGraph, fixtureOverrides: Record<string, FixtureOverride> = {}): PayloadSynthesisResult {
  const operationById = new Map(graph.nodes.operations.map((item) => [item.id, item]));
  const payloads: SynthesizedPayload[] = [];
  const fixtures: ResourceFixtureBinding[] = [];
  for (const resource of graph.nodes.resources) {
    const operations = resource.operation_ids.map((id) => operationById.get(id)).filter((item): item is OperationNode => Boolean(item));
    const fields = graph.nodes.fields.filter((item) => item.resource_id === resource.id);
    for (const operation of operations.filter((item) => item.protocol === "HTTP" && ["POST", "PUT", "PATCH"].includes(item.method || ""))) payloads.push(synthesizePayload(operation, resource, fields));
    fixtures.push(synthesizeFixture(resource, operations, payloads, fixtureOverrides[resource.id]));
  }
  return { schema_version: PAYLOAD_SYNTHESIS_SCHEMA_VERSION, payloads: payloads.sort((a, b) => a.operation_id.localeCompare(b.operation_id)), fixtures: fixtures.sort((a, b) => a.resource_id.localeCompare(b.resource_id)) };
}

function synthesizePayload(operation: OperationNode, resource: ResourceNode, fields: FieldNode[]): SynthesizedPayload {
  const valid: Record<string, unknown> = {};
  for (const field of fields) valid[field.name] = validValue(field);
  const invalid: PayloadVariant[] = [];
  const boundaries: PayloadVariant[] = [];
  for (const field of fields) for (const constraint of field.constraints) {
    const rule = normalizeRule(constraint.rule);
    if (rule === "required") { const payload = { ...valid }; delete payload[field.name]; invalid.push(variant(field, rule, payload)); }
    else if (rule === "enum") invalid.push(variant(field, rule, { ...valid, [field.name]: invalidEnum(constraint.values || []) }));
    else if (rule === "min_length" && typeof constraint.value === "number") boundaries.push(variant(field, rule, { ...valid, [field.name]: "x".repeat(Math.max(0, constraint.value - 1)) }));
    else if (rule === "max_length" && typeof constraint.value === "number") boundaries.push(variant(field, rule, { ...valid, [field.name]: "x".repeat(constraint.value + 1) }));
    else if (rule === "minimum" && typeof constraint.value === "number") boundaries.push(variant(field, rule, { ...valid, [field.name]: constraint.value - 1 }));
    else if (rule === "maximum" && typeof constraint.value === "number") boundaries.push(variant(field, rule, { ...valid, [field.name]: constraint.value + 1 }));
    else if (rule === "format" || rule === "pattern") invalid.push(variant(field, rule, { ...valid, [field.name]: "__autopw_invalid__" }));
  }
  const proven = operation.request_schema_refs.length > 0 && fields.length > 0;
  return { operation_id: operation.id, resource_id: resource.id, schema_refs: operation.request_schema_refs, valid, invalid, boundaries, proven, ...(!proven ? { reason: operation.request_schema_refs.length ? "MISSING_SCHEMA_FIELDS" : "MISSING_REQUEST_SCHEMA" } : {}) };
}

function synthesizeFixture(resource: ResourceNode, operations: OperationNode[], payloads: SynthesizedPayload[], override?: FixtureOverride): ResourceFixtureBinding {
  const httpOperations = operations.filter((item) => item.protocol === "HTTP");
  const create = httpOperations.find((item) => item.method === "POST");
  const read = httpOperations.find((item) => item.method === "GET" && item.path_template?.includes(":")) || httpOperations.find((item) => item.method === "GET");
  const update = httpOperations.find((item) => item.method === "PATCH" || item.method === "PUT");
  const cleanup = httpOperations.find((item) => item.method === "DELETE");
  const payload = create ? payloads.find((item) => item.operation_id === create.id) : undefined;
  if (!create) {
    if (!override) return { resource_id: resource.id, kind: "blocked", identity: { kind: "none", proven: false, reason: "RESOURCE_HAS_NO_CREATE_OPERATION" }, operation_ids: operations.map((item) => item.id).sort(), proven: false, reason: "EXPLICIT_SEED_OR_MANUAL_FIXTURE_REQUIRED" };
    const readRef = override.read_path ? { operation_id: `override:${resource.id}:read`, method: "GET", path: override.read_path } : ref(read);
    return { resource_id: resource.id, kind: override.kind, ...(readRef ? { read: readRef } : {}), ...(override.cleanup_path ? { cleanup: { operation_id: `override:${resource.id}:cleanup`, method: "DELETE", path: override.cleanup_path } } : {}), identity: { kind: "explicit", path: String(override.identity), proven: true }, operation_ids: operations.map((item) => item.id).sort(), proven: Boolean(readRef), ...(!readRef ? { reason: "MISSING_FIXTURE_READ_OPERATION" } : {}) };
  }
  const identity = identityFor(create);
  const proven = Boolean(payload?.proven && identity.proven && read && cleanup);
  return {
    resource_id: resource.id, kind: "resource_crud", create: ref(create), ...(read ? { read: ref(read) } : {}), ...(update ? { update: ref(update) } : {}), ...(cleanup ? { cleanup: ref(cleanup) } : {}),
    ...(payload ? { payload: payload.valid } : {}), identity, operation_ids: [create, read, update, cleanup].filter((item): item is OperationNode => Boolean(item)).map((item) => item.id).sort(), proven,
    ...(!payload?.proven ? { reason: payload?.reason || "FIXTURE_PAYLOAD_UNPROVEN" } : !identity.proven ? { reason: identity.reason } : !read || !cleanup ? { reason: "MISSING_RESOURCE_FIXTURE_OPERATION" } : {})
  };
}

function identityFor(create: OperationNode): IdentityStrategy {
  const candidate = [...create.identity_candidates].sort((a, b) => identityRank(a.kind) - identityRank(b.kind))[0];
  if (!candidate) return { kind: "none", proven: false, reason: "MISSING_IDENTITY_EVIDENCE" };
  return { ...candidate, proven: Boolean(candidate.path || candidate.header), ...(!candidate.path && !candidate.header ? { reason: "MALFORMED_IDENTITY_EVIDENCE" } : {}) };
}
function identityRank(kind: string): number { return kind === "explicit" ? 0 : kind === "response_body" ? 1 : 2; }
function ref(operation: OperationNode | undefined): OperationRef | undefined { return operation?.method && operation.path_template ? { operation_id: operation.id, method: operation.method, path: operation.path_template } : undefined; }
function variant(field: FieldNode, rule: string, payload: Record<string, unknown>): PayloadVariant { return { field_id: field.id, field: field.name, rule, payload }; }
function validValue(field: FieldNode): unknown {
  if (field.examples.length) return field.examples[0];
  const enumConstraint = field.constraints.find((item) => normalizeRule(item.rule) === "enum");
  if (enumConstraint?.values?.length) return enumConstraint.values[0];
  const type = field.schema_types[0] || "string";
  if (type === "boolean") return true;
  if (type === "integer" || type === "number") return numericValue(field);
  const format = field.constraints.find((item) => normalizeRule(item.rule) === "format")?.value;
  if (format === "email") return "autopw@example.test";
  if (format === "uuid") return "00000000-0000-4000-8000-000000000001";
  if (format === "date") return "2026-01-02";
  if (format === "date-time") return "2026-01-02T03:04:05.000Z";
  const min = field.constraints.find((item) => normalizeRule(item.rule) === "min_length")?.value;
  return "x".repeat(typeof min === "number" ? Math.max(1, min) : 8);
}
function numericValue(field: FieldNode): number { const min = field.constraints.find((item) => normalizeRule(item.rule) === "minimum")?.value; const max = field.constraints.find((item) => normalizeRule(item.rule) === "maximum")?.value; if (typeof min === "number") return min; if (typeof max === "number" && max < 1) return max; return 1; }
function invalidEnum(values: unknown[]): unknown { return values.every((item) => typeof item === "number") ? Number.MAX_SAFE_INTEGER : "__autopw_invalid__"; }
function normalizeRule(value: string): string { return ({ required: "required", minlength: "min_length", min_length: "min_length", maxlength: "max_length", max_length: "max_length", enum: "enum", minimum: "minimum", maximum: "maximum", format: "format", pattern: "pattern" } as Record<string, string>)[value.toLowerCase()] || value.toLowerCase(); }
