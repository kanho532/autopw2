import { buildApplicationGraph, type ApplicationGraph, type ApplicationGraphNode, type EvidenceCollection, type FieldNode, type OperationNode, type ResourceNode, type WorkflowNode } from "@autopw/application-graph";
import type { DiscoveryResult } from "@autopw/discovery";
import { synthesizeApplicationPayloads, type ResourceFixtureBinding, type SynthesizedPayload } from "@autopw/payload-synthesis";
import type { DiffResult, RequirementFixtureStrategy, RequirementOracleSpecification, RequirementPayloadStrategy, RequirementStatus, TestRequirement, Tier } from "./index.js";

const ALLOWED_SCENARIOS: Record<Tier, Set<string>> = {
  smoke: new Set(["normal", "required_field"]),
  fast: new Set(["normal", "required_field", "invalid_input", "empty_state"]),
  full: new Set(["normal", "required_field", "invalid_input", "empty_state", "boundary", "service_error", "network_failure", "not_found", "persistence", "cors"])
};
const ALLOWED_PRIORITIES: Record<Tier, Set<string>> = { smoke: new Set(["P0"]), fast: new Set(["P0", "P1"]), full: new Set(["P0", "P1", "P2"]) };

interface EngineInput { discovery: DiscoveryResult; tier: Tier; diff: DiffResult; destructive_allowed: boolean; application_graph?: ApplicationGraph; evidence?: EvidenceCollection; }
interface RequirementDraft extends Omit<TestRequirement, "status" | "reason"> { block_reason?: string; }
type BaseDraft = Pick<RequirementDraft, "feature_id" | "source_refs" | "evidence_refs" | "preconditions" | "confidence"> & { resource_id: string; operation_id: string; fields: FieldNode[]; operation: OperationNode; synthesized_payload?: SynthesizedPayload; synthesized_fixture?: ResourceFixtureBinding };

export function deriveGraphRequirements(input: EngineInput): TestRequirement[] {
  const built = input.application_graph && input.evidence ? { graph: input.application_graph, evidence: input.evidence } : buildApplicationGraph(input.discovery);
  const graph = built.graph;
  const evidence = built.evidence;
  const factByEvidence = new Map(evidence.evidence.map((item) => [item.evidence_id, item.source_fact_id]));
  const operationById = new Map(graph.nodes.operations.map((item) => [item.id, item]));
  const synthesized = synthesizeApplicationPayloads(graph);
  const payloadByOperation = new Map(synthesized.payloads.map((item) => [item.operation_id, item]));
  const fixtureByResource = new Map(synthesized.fixtures.map((item) => [item.resource_id, item]));
  const requirements: TestRequirement[] = [];
  const add = (draft: RequirementDraft): void => {
    if (requirements.some((item) => item.requirement_id === draft.requirement_id)) return;
    const { block_reason, ...requirement } = draft;
    let status: RequirementStatus = "REQUIRED";
    let reason = requirement.risk === "destructive" && !input.destructive_allowed ? "DESTRUCTIVE_NOT_ALLOWED" : block_reason;
    if (!reason && requirement.oracle === null) reason = "MISSING_ORACLE";
    if (!reason && !requirement.oracle_specification.proven) reason = requirement.oracle_specification.reason || "MISSING_ORACLE";
    if (!reason && !requirement.payload_strategy.proven) reason = requirement.payload_strategy.reason || "MISSING_PAYLOAD_STRATEGY";
    if (!reason && !requirement.fixture_strategy.proven) reason = requirement.fixture_strategy.reason || "MISSING_FIXTURE_STRATEGY";
    if (reason) status = "BLOCKED";
    const affected = input.diff.status === "NOOP" || input.diff.affected_features.includes(requirement.feature_id) || input.diff.new_features.includes(requirement.feature_id);
    if (!affected && input.diff.status === "CHANGED") { status = "TIER_SKIPPED"; reason = "TIER_SKIPPED_SCOPE"; }
    if (!ALLOWED_PRIORITIES[input.tier].has(requirement.priority)) { status = "TIER_SKIPPED"; reason = "TIER_SKIPPED_PRIORITY"; }
    if (!ALLOWED_SCENARIOS[input.tier].has(requirement.scenario)) { status = "TIER_SKIPPED"; reason = "TIER_SKIPPED_SCENARIO"; }
    requirements.push({ ...requirement, status, ...(reason ? { reason } : {}) });
  };

  for (const resource of graph.nodes.resources) {
    const operations = resource.operation_ids.map((id) => operationById.get(id)).filter((item): item is OperationNode => Boolean(item));
    const fields = graph.nodes.fields.filter((item) => item.resource_id === resource.id);
    for (const operation of operations) deriveOperationRequirements({ resource, operation, operations, fields, factByEvidence, payloadByOperation, fixture: fixtureByResource.get(resource.id), add });
    for (const field of fields) deriveFieldRequirements({ resource, field, operations, factByEvidence, payloadByOperation, add });
  }
  for (const workflow of graph.nodes.workflows) deriveWorkflowRequirement(workflow, operationById, factByEvidence, add);
  return requirements.sort((left, right) => left.requirement_id.localeCompare(right.requirement_id));
}

function deriveOperationRequirements(context: { resource: ResourceNode; operation: OperationNode; operations: OperationNode[]; fields: FieldNode[]; factByEvidence: Map<string, string>; payloadByOperation: Map<string, SynthesizedPayload>; fixture?: ResourceFixtureBinding; add(draft: RequirementDraft): void }): void {
  const { resource, operation, operations, fields, factByEvidence, payloadByOperation, fixture, add } = context;
  const method = operation.method || "GET";
  const kinds = new Set(operation.operation_kinds);
  const detail = Boolean(operation.path_template?.includes(":"));
  const base = baseDraft(resource, operation, fields, factByEvidence, payloadByOperation.get(operation.id), fixture);
  if (method === "GET" && kinds.has("search")) { add(searchRequirement(base, resource, operation, operations)); return; }
  if (method === "GET" && kinds.has("summary")) { add(readRequirement(base, "summary", "summary_is_consistent", "summary response matches its declared contract")); return; }
  if (method === "GET" && kinds.has("count")) { add(countRequirement(base, resource, operation, operations)); return; }
  if (method === "OPTIONS" || kinds.has("cors")) { add(readRequirement(base, "cors", "cors_allows_operation", "preflight returns its declared success status", "P1")); return; }
  if (method === "GET" && detail) {
    add(detailRequirement(base, resource, operation, operations));
    add(notFoundRequirement(base, operation));
    return;
  }
  if (method === "GET") { add(readRequirement(base, "read", "route_loads", "operation returns its declared success response")); return; }
  if (method === "POST") { add(createRequirement(base, resource, operation, operations, fields)); return; }
  if (method === "PATCH" || method === "PUT") { add(updateRequirement(base, resource, operation, operations, fields)); return; }
  if (method === "DELETE") add(deleteRequirement(base, resource, operation, operations, fields));
}

function deriveFieldRequirements(context: { resource: ResourceNode; field: FieldNode; operations: OperationNode[]; factByEvidence: Map<string, string>; payloadByOperation: Map<string, SynthesizedPayload>; add(draft: RequirementDraft): void }): void {
  const { resource, field, operations, factByEvidence, payloadByOperation, add } = context;
  const mutation = operations.find((item) => item.method === "POST") || operations.find((item) => item.method === "PATCH" || item.method === "PUT");
  const refs = refsFor([field, ...(mutation ? [mutation] : [])], factByEvidence);
  for (const constraint of field.constraints) {
    const rule = normalizeRule(constraint.rule);
    if (!rule) continue;
    const errorStatus = mutation?.response_statuses.find((status) => status === 400 || status === 422);
    const intent = rule === "required" ? "required_field_rejected" : rule === "enum" ? "enum_validation" : "boundary_rejected";
    const scenario = rule === "required" ? "required_field" : rule === "enum" ? "invalid_input" : "boundary";
    const synthesizedPayload = mutation ? payloadByOperation.get(mutation.id) : undefined;
    const variant = [...(synthesizedPayload?.invalid || []), ...(synthesizedPayload?.boundaries || [])].find((item) => item.field_id === field.id && item.rule === rule);
    const payload: RequirementPayloadStrategy = { kind: "constraint", field_id: field.id, rule, ...(Object.hasOwn(constraint, "value") ? { value: constraint.value } : {}), ...(constraint.values ? { values: constraint.values } : {}), ...(synthesizedPayload ? { valid_payload: synthesizedPayload.valid } : {}), ...(variant ? rule === "min_length" || rule === "max_length" || rule === "minimum" || rule === "maximum" ? { boundary_payloads: [variant.payload] } : { invalid_payload: variant.payload } : {}), proven: Boolean(synthesizedPayload?.proven && variant), ...(!synthesizedPayload?.proven ? { reason: synthesizedPayload?.reason || "MISSING_SYNTHESIZED_PAYLOAD" } : !variant ? { reason: "MISSING_CONSTRAINT_VARIANT" } : {}) };
    const oracleSpec: RequirementOracleSpecification = { kind: "validation", operation_ids: mutation ? [mutation.id] : [], field_ids: [field.id], evidence_refs: refs.evidence, assertion: `${field.name} ${rule} violations are rejected`, proven: Boolean(mutation && errorStatus), ...(!mutation ? { reason: "MISSING_MUTATION_OPERATION" } : !errorStatus ? { reason: "MISSING_ERROR_RESPONSE_CONTRACT" } : {}) };
    add({
      requirement_id: `req_${resourceSlug(resource)}_${safeId(field.name)}_${safeId(rule)}`, feature_id: featureOf(mutation, resource), intent, scenario, priority: "P0",
      source_refs: refs.facts, evidence_refs: refs.evidence, resource_id: resource.id, ...(mutation ? { operation_id: mutation.id } : {}), field_id: field.id,
      preconditions: [{ kind: "field_constraint", refs: refs.evidence, details: { field_id: field.id, rule } }],
      oracle: errorStatus ? { kind: "validation", assertion: oracleSpec.assertion, details: { status: errorStatus, field: field.name, rule } } : null,
      oracle_specification: oracleSpec, fixture_strategy: noFixture(), payload_strategy: payload, risk: "read_only", confidence: confidenceOf([field, ...(mutation ? [mutation] : [])])
    });
  }
}

function deriveWorkflowRequirement(workflow: WorkflowNode, operationById: Map<string, OperationNode>, factByEvidence: Map<string, string>, add: (draft: RequirementDraft) => void): void {
  const operations = workflow.operation_ids.map((id) => operationById.get(id)).filter((item): item is OperationNode => Boolean(item));
  const refs = refsFor([workflow, ...operations], factByEvidence);
  add({ requirement_id: `req_workflow_${safeId(workflow.name)}`, feature_id: operations[0]?.feature_ids[0] || safeId(workflow.name), intent: "route_loads", scenario: "normal", priority: "P1", source_refs: refs.facts, evidence_refs: refs.evidence, workflow_id: workflow.id, preconditions: [{ kind: "workflow", refs: refs.evidence, details: { operation_ids: workflow.operation_ids } }], oracle: null, oracle_specification: { kind: "workflow", operation_ids: workflow.operation_ids, field_ids: [], evidence_refs: refs.evidence, assertion: "workflow reaches its evidenced outcome", proven: false, reason: "MISSING_WORKFLOW_ORACLE" }, fixture_strategy: { kind: "workflow", operation_ids: workflow.operation_ids, proven: operations.length === workflow.operation_ids.length, ...(operations.length !== workflow.operation_ids.length ? { reason: "MISSING_WORKFLOW_OPERATION" } : {}) }, payload_strategy: noPayload(), risk: operations.some((item) => item.method && ["POST", "PUT", "PATCH", "DELETE"].includes(item.method)) ? "mutating" : "read_only", confidence: confidenceOf([workflow, ...operations]), block_reason: "MISSING_WORKFLOW_ORACLE" });
}

function baseDraft(resource: ResourceNode, operation: OperationNode, fields: FieldNode[], factByEvidence: Map<string, string>, synthesizedPayload?: SynthesizedPayload, synthesizedFixture?: ResourceFixtureBinding): BaseDraft {
  const refs = refsFor([resource, operation], factByEvidence);
  return { feature_id: featureOf(operation, resource), source_refs: refs.facts, evidence_refs: refs.evidence, resource_id: resource.id, operation_id: operation.id, preconditions: [{ kind: "operation", refs: operation.evidence_refs, details: { operation_id: operation.id, resource_id: resource.id } }], confidence: confidenceOf([resource, operation]), fields, operation, ...(synthesizedPayload ? { synthesized_payload: synthesizedPayload } : {}), ...(synthesizedFixture ? { synthesized_fixture: synthesizedFixture } : {}) };
}

function readRequirement(base: BaseDraft, suffix: string, intent: TestRequirement["intent"], assertion: string, priority: "P0" | "P1" = "P0"): RequirementDraft {
  const operation = base.operation;
  const status = successStatus(operation);
  const oracleSpec = statusOracle(operation, assertion, status);
  return { ...withoutFields(base), requirement_id: `req_${resourceIdSlug(base.resource_id)}_${suffix}_${operation.id.slice(-6)}`, intent, scenario: intent === "cors_allows_operation" ? "cors" : "normal", priority, oracle: status ? { kind: "http", assertion, details: { status } } : null, oracle_specification: oracleSpec, fixture_strategy: noFixture(), payload_strategy: noPayload(), risk: "read_only" };
}

function createRequirement(base: BaseDraft, resource: ResourceNode, operation: OperationNode, operations: OperationNode[], fields: FieldNode[]): RequirementDraft {
  const read = collectionRead(operations) || detailRead(operations);
  const cleanup = operations.find((item) => item.method === "DELETE");
  const status = declaredStatus(operation, 201);
  const refs = mergedRefs(base.evidence_refs, read?.evidence_refs, cleanup?.evidence_refs);
  return { ...withoutFields(base), evidence_refs: refs, source_refs: base.source_refs, requirement_id: `req_${resourceSlug(resource)}_create`, intent: "create_succeeds", scenario: "normal", priority: "P0", preconditions: [...base.preconditions, { kind: "resource_fixture", refs, details: { create_operation_id: operation.id, read_operation_id: read?.id, cleanup_operation_id: cleanup?.id } }], oracle: status && read ? { kind: "http", assertion: "created entity is observable through its resource", details: { status } } : null, oracle_specification: { kind: "persistence", operation_ids: [operation.id, ...(read ? [read.id] : [])], field_ids: fields.map((item) => item.id), evidence_refs: refs, assertion: "created entity is observable through its resource", proven: Boolean(status && read), ...(!status ? { reason: "MISSING_SUCCESS_RESPONSE_CONTRACT" } : !read ? { reason: "MISSING_READ_OPERATION" } : {}) }, fixture_strategy: synthesizedFixture(base.synthesized_fixture), payload_strategy: synthesizedPayload(base.synthesized_payload, fields), risk: "mutating", confidence: confidenceOf([resource, operation, ...(read ? [read] : []), ...(cleanup ? [cleanup] : [])]) };
}

function detailRequirement(base: BaseDraft, resource: ResourceNode, operation: OperationNode, operations: OperationNode[]): RequirementDraft {
  const create = operations.find((item) => item.method === "POST"); const cleanup = operations.find((item) => item.method === "DELETE"); const status = declaredStatus(operation, 200); const fixture = synthesizedFixture(base.synthesized_fixture); const refs = mergedRefs(base.evidence_refs, create?.evidence_refs, cleanup?.evidence_refs);
  return { ...withoutFields(base), evidence_refs: refs, requirement_id: `req_${resourceSlug(resource)}_detail`, intent: "route_detail", scenario: "normal", priority: "P0", oracle: status ? { kind: "http", assertion: "created entity can be read by identity", details: { status } } : null, oracle_specification: statusOracle(operation, "created entity can be read by identity", status), fixture_strategy: fixture, payload_strategy: fixturePayload(create, base.fields, base.synthesized_fixture), risk: "read_only", confidence: confidenceOf([resource, operation, ...(create ? [create] : []), ...(cleanup ? [cleanup] : [])]) };
}

function notFoundRequirement(base: BaseDraft, operation: OperationNode): RequirementDraft { const status = declaredStatus(operation, 404); return { ...withoutFields(base), requirement_id: `req_${resourceIdSlug(base.resource_id)}_not_found_${operation.id.slice(-6)}`, intent: "not_found_semantics", scenario: "not_found", priority: "P0", oracle: status ? { kind: "http", assertion: "unknown identity returns not found", details: { status } } : null, oracle_specification: statusOracle(operation, "unknown identity returns not found", status), fixture_strategy: noFixture(), payload_strategy: noPayload(), risk: "read_only" }; }

function updateRequirement(base: BaseDraft, resource: ResourceNode, operation: OperationNode, operations: OperationNode[], fields: FieldNode[]): RequirementDraft { const create = operations.find((item) => item.method === "POST"); const read = detailRead(operations); const cleanup = operations.find((item) => item.method === "DELETE"); const status = declaredStatus(operation, 200); const refs = mergedRefs(base.evidence_refs, create?.evidence_refs, read?.evidence_refs, cleanup?.evidence_refs); return { ...withoutFields(base), evidence_refs: refs, requirement_id: `req_${resourceSlug(resource)}_update`, intent: "update_persists", scenario: "persistence", priority: "P0", oracle: status && read ? { kind: "persistence", assertion: "updated fields persist after re-read", details: { status } } : null, oracle_specification: { kind: "persistence", operation_ids: [operation.id, ...(read ? [read.id] : [])], field_ids: fields.map((item) => item.id), evidence_refs: refs, assertion: "updated fields persist after re-read", proven: Boolean(status && read), ...(!status ? { reason: "MISSING_SUCCESS_RESPONSE_CONTRACT" } : !read ? { reason: "MISSING_READ_OPERATION" } : {}) }, fixture_strategy: synthesizedFixture(base.synthesized_fixture), payload_strategy: synthesizedPayload(base.synthesized_payload, fields), risk: "mutating", confidence: confidenceOf([resource, operation, ...(create ? [create] : []), ...(read ? [read] : []), ...(cleanup ? [cleanup] : [])]) }; }

function deleteRequirement(base: BaseDraft, resource: ResourceNode, operation: OperationNode, operations: OperationNode[], fields: FieldNode[]): RequirementDraft { const create = operations.find((item) => item.method === "POST"); const read = detailRead(operations); const status = declaredStatus(operation, 204); const refs = mergedRefs(base.evidence_refs, create?.evidence_refs, read?.evidence_refs); return { ...withoutFields(base), evidence_refs: refs, requirement_id: `req_${resourceSlug(resource)}_delete`, intent: "delete_removes_entity", scenario: "empty_state", priority: "P0", oracle: status && read ? { kind: "http", assertion: "deleted identity is no longer readable", details: { status } } : null, oracle_specification: { kind: "deletion", operation_ids: [operation.id, ...(read ? [read.id] : [])], field_ids: [], evidence_refs: refs, assertion: "deleted identity is no longer readable", proven: Boolean(status && read), ...(!status ? { reason: "MISSING_SUCCESS_RESPONSE_CONTRACT" } : !read ? { reason: "MISSING_READ_OPERATION" } : {}) }, fixture_strategy: synthesizedFixture(base.synthesized_fixture), payload_strategy: fixturePayload(create, fields, base.synthesized_fixture), risk: "destructive", confidence: confidenceOf([resource, operation, ...(create ? [create] : []), ...(read ? [read] : [])]) }; }

function searchRequirement(base: BaseDraft, resource: ResourceNode, operation: OperationNode, operations: OperationNode[]): RequirementDraft { const create = operations.find((item) => item.method === "POST"); const cleanup = operations.find((item) => item.method === "DELETE"); const status = declaredStatus(operation, 200); const refs = mergedRefs(base.evidence_refs, create?.evidence_refs, cleanup?.evidence_refs); return { ...withoutFields(base), evidence_refs: refs, requirement_id: `req_${resourceSlug(resource)}_search`, intent: "search_filters_results", scenario: "normal", priority: "P0", oracle: status ? { kind: "collection", assertion: "results satisfy the evidenced query", details: { status } } : null, oracle_specification: statusOracle(operation, "results satisfy the evidenced query", status), fixture_strategy: synthesizedFixture(base.synthesized_fixture), payload_strategy: fixturePayload(create, base.fields, base.synthesized_fixture), risk: "read_only", confidence: confidenceOf([resource, operation, ...(create ? [create] : []), ...(cleanup ? [cleanup] : [])]) }; }

function countRequirement(base: BaseDraft, resource: ResourceNode, operation: OperationNode, operations: OperationNode[]): RequirementDraft { const list = collectionRead(operations); const status = declaredStatus(operation, 200); const refs = mergedRefs(base.evidence_refs, list?.evidence_refs); return { ...withoutFields(base), evidence_refs: refs, requirement_id: `req_${resourceSlug(resource)}_count`, intent: "count_consistent", scenario: "normal", priority: "P0", oracle: status && list ? { kind: "json", assertion: "count matches the associated collection", details: { status, collection_path: list.path_template } } : null, oracle_specification: { kind: "relation", operation_ids: [operation.id, ...(list ? [list.id] : [])], field_ids: [], evidence_refs: refs, assertion: "count matches the associated collection", proven: Boolean(status && list), ...(!list ? { reason: "MISSING_ASSOCIATED_COLLECTION_OPERATION" } : !status ? { reason: "MISSING_SUCCESS_RESPONSE_CONTRACT" } : {}) }, fixture_strategy: noFixture(), payload_strategy: noPayload(), risk: "read_only", confidence: confidenceOf([resource, operation, ...(list ? [list] : [])]) }; }

function withoutFields(base: BaseDraft): Omit<BaseDraft, "fields" | "operation" | "synthesized_payload" | "synthesized_fixture"> { const { fields: _fields, operation: _operation, synthesized_payload: _payload, synthesized_fixture: _fixture, ...rest } = base; return rest; }
function statusOracle(operation: OperationNode, assertion: string, status?: number): RequirementOracleSpecification { return { kind: "http", operation_ids: [operation.id], field_ids: [], evidence_refs: operation.evidence_refs, assertion, proven: Boolean(status), ...(!status ? { reason: "MISSING_SUCCESS_RESPONSE_CONTRACT" } : {}) }; }
function declaredStatus(operation: OperationNode, preferred: number): number | undefined { return operation.response_statuses.includes(preferred) ? preferred : undefined; }
function successStatus(operation: OperationNode): number | undefined { return operation.response_statuses.find((status) => status >= 200 && status < 300); }
function collectionRead(operations: OperationNode[]): OperationNode | undefined { return operations.find((item) => item.method === "GET" && !item.path_template?.includes(":") && !item.operation_kinds.some((kind) => ["search", "summary", "count"].includes(kind))); }
function detailRead(operations: OperationNode[]): OperationNode | undefined { return operations.find((item) => item.method === "GET" && item.path_template?.includes(":")); }
function noFixture(): RequirementFixtureStrategy { return { kind: "none", operation_ids: [], proven: true }; }
function noPayload(): RequirementPayloadStrategy { return { kind: "none", schema_refs: [], field_ids: [], proven: true }; }
function synthesizedPayload(payload: SynthesizedPayload | undefined, fields: FieldNode[]): RequirementPayloadStrategy { return { kind: "schema", schema_refs: payload?.schema_refs || [], field_ids: fields.map((item) => item.id), ...(payload ? { valid_payload: payload.valid, invalid_payload: payload.invalid[0]?.payload, boundary_payloads: payload.boundaries.map((item) => item.payload) } : {}), proven: Boolean(payload?.proven), ...(!payload?.proven ? { reason: payload?.reason || "MISSING_SYNTHESIZED_PAYLOAD" } : {}) }; }
function fixturePayload(create: OperationNode | undefined, fields: FieldNode[], fixture?: ResourceFixtureBinding): RequirementPayloadStrategy { return { kind: "schema", schema_refs: create?.request_schema_refs || [], field_ids: fields.map((item) => item.id), ...(fixture?.payload ? { valid_payload: fixture.payload } : {}), proven: Boolean(fixture?.payload), ...(!fixture?.payload ? { reason: fixture?.reason || "FIXTURE_PAYLOAD_UNPROVEN" } : {}) }; }
function synthesizedFixture(fixture: ResourceFixtureBinding | undefined): RequirementFixtureStrategy { if (!fixture) return { kind: "resource_crud", operation_ids: [], proven: false, reason: "MISSING_SYNTHESIZED_FIXTURE" }; return { kind: fixture.kind === "blocked" ? "resource_crud" : fixture.kind, operation_ids: fixture.operation_ids, create_operation_id: fixture.create?.operation_id, read_operation_id: fixture.read?.operation_id, cleanup_operation_id: fixture.cleanup?.operation_id, create: fixture.create, read: fixture.read, update: fixture.update, cleanup: fixture.cleanup, payload: fixture.payload, identity: fixture.identity, proven: fixture.proven, reason: fixture.reason }; }
function refsFor(nodes: ApplicationGraphNode[], factByEvidence: Map<string, string>): { evidence: string[]; facts: string[] } { const evidence = mergedRefs(...nodes.map((item) => item.evidence_refs)); return { evidence, facts: [...new Set(evidence.map((ref) => factByEvidence.get(ref)).filter((item): item is string => Boolean(item)))].sort() }; }
function mergedRefs(...values: Array<string[] | undefined>): string[] { return [...new Set(values.flatMap((item) => item || []))].sort(); }
function confidenceOf(nodes: ApplicationGraphNode[]): number { return Number(Math.min(...nodes.map((item) => item.confidence), 1).toFixed(4)); }
function featureOf(operation: OperationNode | undefined, resource: ResourceNode): string { return operation?.feature_ids[0] || resourceSlug(resource); }
function resourceSlug(resource: ResourceNode): string { const segment = resource.collection_path.split("/").filter(Boolean).at(-1) || "resource"; return safeId(segment.endsWith("s") && segment.length > 1 ? segment.slice(0, -1) : segment); }
function resourceIdSlug(value: string): string { return safeId(value.replace(/^\/+/, "").replaceAll("/", "_")) || "resource"; }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 100); }
function normalizeRule(value: string): string { const normalized = value.toLowerCase(); return ({ required: "required", minlength: "min_length", maxlength: "max_length", enum: "enum", minimum: "minimum", maximum: "maximum", format: "format", pattern: "pattern" } as Record<string, string>)[normalized] || ""; }
