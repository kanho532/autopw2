import { buildApplicationGraph, type ApplicationGraph, type ApplicationGraphNode, type EvidenceCollection, type FieldNode, type OperationNode, type ResourceNode, type WorkflowNode } from "@autopw/application-graph";
import type { DiscoveryResult } from "@autopw/discovery";
import { synthesizeApplicationPayloads, type ResourceFixtureBinding, type SynthesizedPayload } from "@autopw/payload-synthesis";
import type { DiffResult, RequirementFixtureStrategy, RequirementOracleSpecification, RequirementPayloadStrategy, RequirementStatus, TestRequirement, Tier } from "./index.js";

const ALLOWED_SCENARIOS: Record<Tier, Set<string>> = {
  smoke: new Set(["normal", "required_field"]),
  fast: new Set(["normal", "required_field", "invalid_input", "empty_state", "boundary", "not_found", "persistence", "cors"]),
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
  const evidenceByFact = new Map(evidence.evidence.map((item) => [item.source_fact_id, item.evidence_id]));
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
  deriveUiBehaviorRequirements(input.discovery, graph.nodes.operations, evidenceByFact, add);
  return requirements.sort((left, right) => left.requirement_id.localeCompare(right.requirement_id));
}

function deriveUiBehaviorRequirements(discovery: DiscoveryResult, operations: OperationNode[], evidenceByFact: Map<string, string>, add: (draft: RequirementDraft) => void): void {
  const structures = discovery.observations.filter((item) => item.kind === "fact" && item.fact_type === "ui_structure" && item.source_kind === "DOM");
  const stateMapping = discovery.observations.find((item) => item.kind === "fact" && item.fact_type === "ui_state_mapping" && Array.isArray(item.handled_values));
  const bySemantic = new Map(structures.map((item) => [String(item.semantic || ""), item]));
  const selector = (semantic: string): string | undefined => typeof bySemantic.get(semantic)?.selector === "string" ? String(bySemantic.get(semantic)?.selector) : undefined;
  const nth = (semantic: string): number | undefined => typeof bySemantic.get(semantic)?.nth === "number" ? Number(bySemantic.get(semantic)?.nth) : undefined;
  const scope = (semantic: string): string | undefined => typeof bySemantic.get(semantic)?.scope_selector === "string" ? String(bySemantic.get(semantic)?.scope_selector) : undefined;
  const item = selector("collection_item");
  const list = operations.filter((operation) => operation.method === "GET" && operation.path_template && operation.path_template !== "/" && !operation.path_template.includes(":") && !operation.operation_kinds.some((kind) => ["summary", "count", "search"].includes(kind))).sort((left, right) => pathDepth(left.path_template || "/") - pathDepth(right.path_template || "/") || (left.path_template || "").localeCompare(right.path_template || ""))[0];
  if (!item || !list?.path_template) return;
  const detail = operations.find((operation) => operation.method === "GET" && operation.path_template?.includes(":"));
  const create = operations.find((operation) => operation.method === "POST" && operation.path_template && !operation.path_template.includes(":"));
  const update = operations.find((operation) => ["PATCH", "PUT"].includes(operation.method || "") && operation.path_template?.includes(":"));
  const remove = operations.find((operation) => operation.method === "DELETE" && operation.path_template?.includes(":"));
  const route = String(bySemantic.get("collection_item")?.route || "/");
  const addUi = (intent: TestRequirement["intent"], assertion: string, semantics: string[], operationSet: OperationNode[], risk: TestRequirement["risk"], details: Record<string, unknown>, extraFacts: Record<string, unknown>[] = []): void => {
    const facts = [...semantics.map((semantic) => bySemantic.get(semantic)).filter((value): value is Record<string, unknown> => Boolean(value)), ...extraFacts];
    const factIds = facts.map((fact) => String(fact.fact_id)).filter(Boolean);
    const evidenceRefs = mergedRefs(factIds.map((id) => evidenceByFact.get(id)).filter((id): id is string => Boolean(id)), ...operationSet.map((operation) => operation.evidence_refs));
    add({ requirement_id: `req_ui_${intent.slice(3)}`, feature_id: "live.ui", intent, scenario: intent === "ui_toggle_refreshes" ? "persistence" : intent === "ui_delete_removes" ? "empty_state" : "normal", priority: "P0", source_refs: factIds, evidence_refs: evidenceRefs, ...(operationSet[0] ? { operation_id: operationSet[0].id, resource_id: operationSet[0].resource_id } : {}), preconditions: [{ kind: "live_dom_structure", refs: evidenceRefs, details: { semantics } }], oracle: { kind: "ui_relation", assertion, details: { route, collection_path: list.path_template, detail_path: detail?.path_template, create_path: create?.path_template, update_path: update?.path_template, delete_path: remove?.path_template, item_selector: item, ...details } }, oracle_specification: { kind: "ui_relation", operation_ids: operationSet.map((operation) => operation.id), field_ids: [], evidence_refs: evidenceRefs, assertion, proven: true }, fixture_strategy: { kind: risk === "read_only" ? "none" : "resource_crud", operation_ids: operationSet.map((operation) => operation.id), proven: true }, payload_strategy: noPayload(), risk, confidence: Number(Math.min(...facts.map((fact) => Number(fact.confidence || 0.5)), ...operationSet.map((operation) => operation.confidence)).toFixed(4)) });
  };
  if (selector("displayed_count")) addUi("ui_count_consistent", "displayed count equals the rendered resource collection", ["collection_item", "displayed_count"], [list], "read_only", { count_selector: selector("displayed_count") });
  if (selector("search_input")) addUi("ui_search_filters", "search results contain the entered resource key and empty queries render no items", ["collection_item", "search_input"], [list], "read_only", { search_selector: selector("search_input") });
  if (selector("item_status")) addUi("ui_status_consistent", "resource states are handled by the UI mapping and render consistently", ["collection_item", "item_status"], [list], "read_only", { status_selector: selector("item_status"), ...(stateMapping ? { state_field: String(stateMapping.field || "status"), handled_values: stateMapping.handled_values } : {}) }, stateMapping ? [stateMapping] : []);
  if (create && remove && selector("create_primary_input") && selector("create_submit")) addUi("ui_create_refreshes", "a successful create is visible without reloading", ["collection_item", "create_primary_input", "create_secondary_input", "create_select", "create_submit"], [list, create, remove], "mutating", { primary_input_selector: selector("create_primary_input"), primary_input_nth: nth("create_primary_input"), secondary_input_selector: selector("create_secondary_input"), secondary_input_nth: nth("create_secondary_input"), select_selector: selector("create_select"), select_nth: nth("create_select"), submit_selector: selector("create_submit"), submit_nth: nth("create_submit") });
  if (update && selector("item_status") && selector("toggle_action")) addUi("ui_toggle_refreshes", "a successful toggle changes the rendered state", ["collection_item", "item_status", "toggle_action"], [list, update], "mutating", { status_selector: selector("item_status"), toggle_selector: selector("toggle_action"), toggle_scope_selector: scope("toggle_action") });
  if (create && remove && selector("delete_action")) addUi("ui_delete_removes", "a successful delete removes the rendered resource", ["collection_item", "delete_action"], [list, create, remove], "destructive", { delete_selector: selector("delete_action"), delete_scope_selector: scope("delete_action") });
}

function pathDepth(value: string): number { return value.split("?")[0].split("/").filter(Boolean).length; }

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
  if (method === "DELETE") add(deleteRequirement(base, resource, operation, operations));
}

function deriveFieldRequirements(context: { resource: ResourceNode; field: FieldNode; operations: OperationNode[]; factByEvidence: Map<string, string>; payloadByOperation: Map<string, SynthesizedPayload>; add(draft: RequirementDraft): void }): void {
  const { resource, field, operations, factByEvidence, payloadByOperation, add } = context;
  const mutation = operations.find((item) => item.method === "POST") || operations.find((item) => item.method === "PATCH" || item.method === "PUT");
  const refs = refsFor([field, ...(mutation ? [mutation] : [])], factByEvidence);
  for (const constraint of field.constraints) {
    const rule = normalizeRule(constraint.rule);
    if (!rule) continue;
    const errorStatus = mutation ? mutation.response_statuses.find((status) => status === 400 || status === 422) || 400 : undefined;
    const intent = rule === "required" ? "required_field_rejected" : rule === "enum" ? "enum_validation" : "boundary_rejected";
    const scenario = rule === "required" ? "required_field" : rule === "enum" ? "invalid_input" : "boundary";
    const synthesizedPayload = mutation ? payloadByOperation.get(mutation.id) : undefined;
    const variant = [...(synthesizedPayload?.invalid || []), ...(synthesizedPayload?.boundaries || [])].find((item) => item.field_id === field.id && item.rule === rule);
    const conventionalInvalid = rule === "enum" ? { [field.name]: "__autopw_invalid__" } : undefined;
    const payload: RequirementPayloadStrategy = { kind: "constraint", field_id: field.id, rule, ...(Object.hasOwn(constraint, "value") ? { value: constraint.value } : {}), ...(constraint.values ? { values: constraint.values } : {}), ...(synthesizedPayload ? { valid_payload: synthesizedPayload.valid } : {}), ...(variant ? rule === "min_length" || rule === "max_length" || rule === "minimum" || rule === "maximum" ? { boundary_payloads: [variant.payload] } : { invalid_payload: variant.payload } : conventionalInvalid ? { invalid_payload: conventionalInvalid } : {}), proven: Boolean(mutation && (variant || conventionalInvalid)), ...(!mutation ? { reason: "MISSING_MUTATION_OPERATION" } : !variant && !conventionalInvalid ? { reason: "MISSING_CONSTRAINT_VARIANT" } : {}) };
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
  const observedStatus = successStatus(operation);
  const status = observedStatus || declaredStatus(operation, operation.method === "OPTIONS" ? 204 : 200);
  const effectivePriority = observedStatus ? priority : "P1";
  const oracleSpec = statusOracle(operation, assertion, status);
  return { ...withoutFields(base), requirement_id: `req_${resourceIdSlug(base.resource_id)}_${suffix}_${operation.id.slice(-6)}`, intent, scenario: intent === "cors_allows_operation" ? "cors" : "normal", priority: effectivePriority, oracle: status ? { kind: "http", assertion, details: { status } } : null, oracle_specification: oracleSpec, fixture_strategy: noFixture(), payload_strategy: noPayload(), risk: "read_only" };
}

function createRequirement(base: BaseDraft, resource: ResourceNode, operation: OperationNode, operations: OperationNode[], fields: FieldNode[]): RequirementDraft {
  const read = collectionRead(operations); const detail = detailRead(operations);
  const cleanup = operations.find((item) => item.method === "DELETE");
  const status = declaredStatus(operation, 201);
  const refs = mergedRefs(base.evidence_refs, read?.evidence_refs, detail?.evidence_refs, cleanup?.evidence_refs);
  return { ...withoutFields(base), evidence_refs: refs, source_refs: base.source_refs, requirement_id: `req_${resourceSlug(resource)}_create`, intent: "create_succeeds", scenario: "normal", priority: "P0", preconditions: [...base.preconditions, { kind: "resource_fixture", refs, details: { create_operation_id: operation.id, read_operation_id: read?.id, cleanup_operation_id: cleanup?.id } }], oracle: read && cleanup ? { kind: "persistence", assertion: "created entity is observable through its resource", details: { status, collection_path: read.path_template, detail_path: detail?.path_template } } : null, oracle_specification: { kind: "persistence", operation_ids: [operation.id, ...(read ? [read.id] : []), ...(detail ? [detail.id] : [])], field_ids: fields.map((item) => item.id), evidence_refs: refs, assertion: "created entity is observable through its resource", proven: Boolean(read && cleanup), ...(!read ? { reason: "MISSING_READ_OPERATION" } : !cleanup ? { reason: "MISSING_CLEANUP_OPERATION" } : {}) }, fixture_strategy: runtimeCloneFixture(operations, base.synthesized_fixture), payload_strategy: noPayload(), risk: "mutating", confidence: confidenceOf([resource, operation, ...(read ? [read] : []), ...(detail ? [detail] : []), ...(cleanup ? [cleanup] : [])]), ...(!read ? { block_reason: "MISSING_READ_OPERATION" } : !cleanup ? { block_reason: "MISSING_RESOURCE_FIXTURE_OPERATION" } : {}) };
}

function detailRequirement(base: BaseDraft, resource: ResourceNode, operation: OperationNode, operations: OperationNode[]): RequirementDraft {
  const list = collectionRead(operations); const refs = mergedRefs(base.evidence_refs, list?.evidence_refs);
  return { ...withoutFields(base), evidence_refs: refs, requirement_id: `req_${resourceSlug(resource)}_detail`, intent: "route_detail", scenario: "normal", priority: "P0", oracle: list ? { kind: "relation", assertion: "detail response preserves the selected collection entity", details: { status: 200, collection_path: list.path_template, detail_path: operation.path_template } } : null, oracle_specification: { kind: "relation", operation_ids: [operation.id, ...(list ? [list.id] : [])], field_ids: [], evidence_refs: refs, assertion: "detail response preserves the selected collection entity", proven: Boolean(list), ...(!list ? { reason: "MISSING_ASSOCIATED_COLLECTION_OPERATION" } : {}) }, fixture_strategy: runtimeCloneFixture(operations, base.synthesized_fixture), payload_strategy: noPayload(), risk: "read_only", confidence: confidenceOf([resource, operation, ...(list ? [list] : [])]) };
}

function notFoundRequirement(base: BaseDraft, operation: OperationNode): RequirementDraft { const status = declaredStatus(operation, 404); return { ...withoutFields(base), requirement_id: `req_${resourceIdSlug(base.resource_id)}_not_found_${operation.id.slice(-6)}`, intent: "not_found_semantics", scenario: "not_found", priority: "P0", oracle: status ? { kind: "http", assertion: "unknown identity returns not found", details: { status } } : null, oracle_specification: statusOracle(operation, "unknown identity returns not found", status), fixture_strategy: noFixture(), payload_strategy: noPayload(), risk: "read_only" }; }

function updateRequirement(base: BaseDraft, resource: ResourceNode, operation: OperationNode, operations: OperationNode[], fields: FieldNode[]): RequirementDraft { const list = collectionRead(operations); const read = detailRead(operations); const status = declaredStatus(operation, 200); const refs = mergedRefs(base.evidence_refs, list?.evidence_refs, read?.evidence_refs); return { ...withoutFields(base), evidence_refs: refs, requirement_id: `req_${resourceSlug(resource)}_update`, intent: "update_persists", scenario: "persistence", priority: "P0", oracle: list && read ? { kind: "persistence", assertion: "updated resource response persists after re-read", details: { status, collection_path: list.path_template, detail_path: read.path_template, update_path: operation.path_template } } : null, oracle_specification: { kind: "persistence", operation_ids: [operation.id, ...(list ? [list.id] : []), ...(read ? [read.id] : [])], field_ids: fields.map((item) => item.id), evidence_refs: refs, assertion: "updated resource response persists after re-read", proven: Boolean(list && read), ...(!list ? { reason: "MISSING_COLLECTION_OPERATION" } : !read ? { reason: "MISSING_READ_OPERATION" } : {}) }, fixture_strategy: runtimeCloneFixture(operations, base.synthesized_fixture), payload_strategy: noPayload(), risk: "mutating", confidence: confidenceOf([resource, operation, ...(list ? [list] : []), ...(read ? [read] : [])]) }; }

function deleteRequirement(base: BaseDraft, resource: ResourceNode, operation: OperationNode, operations: OperationNode[]): RequirementDraft { const create = operations.find((item) => item.method === "POST"); const list = collectionRead(operations); const read = detailRead(operations); const status = declaredStatus(operation, 204); const refs = mergedRefs(base.evidence_refs, create?.evidence_refs, list?.evidence_refs, read?.evidence_refs); return { ...withoutFields(base), evidence_refs: refs, requirement_id: `req_${resourceSlug(resource)}_delete`, intent: "delete_removes_entity", scenario: "empty_state", priority: "P0", oracle: create && list && read ? { kind: "deletion", assertion: "deleted identity is no longer readable", details: { status, collection_path: list.path_template, detail_path: read.path_template, create_path: create.path_template, delete_path: operation.path_template } } : null, oracle_specification: { kind: "deletion", operation_ids: [operation.id, ...(create ? [create.id] : []), ...(list ? [list.id] : []), ...(read ? [read.id] : [])], field_ids: [], evidence_refs: refs, assertion: "deleted identity is no longer readable", proven: Boolean(create && list && read), ...(!create ? { reason: "MISSING_CREATE_OPERATION" } : !list ? { reason: "MISSING_COLLECTION_OPERATION" } : !read ? { reason: "MISSING_READ_OPERATION" } : {}) }, fixture_strategy: runtimeCloneFixture(operations, base.synthesized_fixture), payload_strategy: noPayload(), risk: "destructive", confidence: confidenceOf([resource, operation, ...(create ? [create] : []), ...(list ? [list] : []), ...(read ? [read] : [])]) }; }

function searchRequirement(base: BaseDraft, resource: ResourceNode, operation: OperationNode, operations: OperationNode[]): RequirementDraft { const create = operations.find((item) => item.method === "POST"); const cleanup = operations.find((item) => item.method === "DELETE"); const status = declaredStatus(operation, 200); const refs = mergedRefs(base.evidence_refs, create?.evidence_refs, cleanup?.evidence_refs); return { ...withoutFields(base), evidence_refs: refs, requirement_id: `req_${resourceSlug(resource)}_search`, intent: "search_filters_results", scenario: "normal", priority: "P0", oracle: status ? { kind: "collection", assertion: "results satisfy the evidenced query", details: { status } } : null, oracle_specification: statusOracle(operation, "results satisfy the evidenced query", status), fixture_strategy: runtimeCloneFixture(operations, base.synthesized_fixture), payload_strategy: noPayload(), risk: "read_only", confidence: confidenceOf([resource, operation, ...(create ? [create] : []), ...(cleanup ? [cleanup] : [])]) }; }

function countRequirement(base: BaseDraft, resource: ResourceNode, operation: OperationNode, operations: OperationNode[]): RequirementDraft { const list = collectionRead(operations); if (!list) return readRequirement(base, "count", "route_loads", "count endpoint returns its conventional success response", "P1"); const status = declaredStatus(operation, 200); const refs = mergedRefs(base.evidence_refs, list.evidence_refs); return { ...withoutFields(base), evidence_refs: refs, requirement_id: `req_${resourceSlug(resource)}_count`, intent: "count_consistent", scenario: "normal", priority: "P0", oracle: { kind: "json", assertion: "count matches the associated collection", details: { status, collection_path: list.path_template } }, oracle_specification: { kind: "relation", operation_ids: [operation.id, list.id], field_ids: [], evidence_refs: refs, assertion: "count matches the associated collection", proven: true }, fixture_strategy: noFixture(), payload_strategy: noPayload(), risk: "read_only", confidence: confidenceOf([resource, operation, list]) }; }

function withoutFields(base: BaseDraft): Omit<BaseDraft, "fields" | "operation" | "synthesized_payload" | "synthesized_fixture"> { const { fields: _fields, operation: _operation, synthesized_payload: _payload, synthesized_fixture: _fixture, ...rest } = base; return rest; }
function statusOracle(operation: OperationNode, assertion: string, status?: number): RequirementOracleSpecification { return { kind: "http", operation_ids: [operation.id], field_ids: [], evidence_refs: operation.evidence_refs, assertion, proven: Boolean(status), ...(!status ? { reason: "MISSING_SUCCESS_RESPONSE_CONTRACT" } : {}) }; }
function declaredStatus(_operation: OperationNode, preferred: number): number | undefined { return preferred; }
function successStatus(operation: OperationNode): number | undefined { return operation.response_statuses.find((status) => status >= 200 && status < 300); }
function collectionRead(operations: OperationNode[]): OperationNode | undefined { return operations.filter((item) => item.method === "GET" && item.path_template !== "/" && !item.path_template?.includes(":") && !item.operation_kinds.some((kind) => ["search", "summary", "count"].includes(kind))).sort((left, right) => pathDepth(left.path_template || "/") - pathDepth(right.path_template || "/") || (left.path_template || "").localeCompare(right.path_template || ""))[0]; }
function detailRead(operations: OperationNode[]): OperationNode | undefined { return operations.find((item) => item.method === "GET" && item.path_template?.includes(":")); }
function noFixture(): RequirementFixtureStrategy { return { kind: "none", operation_ids: [], proven: true }; }
function noPayload(): RequirementPayloadStrategy { return { kind: "none", schema_refs: [], field_ids: [], proven: true }; }
function runtimeCloneFixture(operations: OperationNode[], synthesized?: ResourceFixtureBinding): RequirementFixtureStrategy { const create = operations.find((item) => item.method === "POST"); const read = detailRead(operations); const update = operations.find((item) => item.method === "PATCH" || item.method === "PUT"); const cleanup = operations.find((item) => item.method === "DELETE"); const refs = [create, read, update, cleanup].filter((item): item is OperationNode => Boolean(item)); return { kind: "resource_crud", operation_ids: refs.map((item) => item.id), ...(create?.method && create.path_template ? { create: { operation_id: create.id, method: create.method, path: create.path_template } } : {}), ...(read?.method && read.path_template ? { read: { operation_id: read.id, method: read.method, path: read.path_template } } : {}), ...(update?.method && update.path_template ? { update: { operation_id: update.id, method: update.method, path: update.path_template } } : {}), ...(cleanup?.method && cleanup.path_template ? { cleanup: { operation_id: cleanup.id, method: cleanup.method, path: cleanup.path_template } } : {}), ...(synthesized?.payload ? { payload: synthesized.payload } : {}), identity: { kind: "response_body", path: "id", proven: true }, proven: true }; }
function refsFor(nodes: ApplicationGraphNode[], factByEvidence: Map<string, string>): { evidence: string[]; facts: string[] } { const evidence = mergedRefs(...nodes.map((item) => item.evidence_refs)); return { evidence, facts: [...new Set(evidence.map((ref) => factByEvidence.get(ref)).filter((item): item is string => Boolean(item)))].sort() }; }
function mergedRefs(...values: Array<string[] | undefined>): string[] { return [...new Set(values.flatMap((item) => item || []))].sort(); }
function confidenceOf(nodes: ApplicationGraphNode[]): number { return Number(Math.min(...nodes.map((item) => item.confidence), 1).toFixed(4)); }
function featureOf(operation: OperationNode | undefined, resource: ResourceNode): string { return operation?.feature_ids[0] || resourceSlug(resource); }
function resourceSlug(resource: ResourceNode): string { const segment = resource.collection_path.split("/").filter(Boolean).at(-1) || "resource"; return safeId(segment.endsWith("s") && segment.length > 1 ? segment.slice(0, -1) : segment); }
function resourceIdSlug(value: string): string { return safeId(value.replace(/^\/+/, "").replaceAll("/", "_")) || "resource"; }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 100); }
function normalizeRule(value: string): string { const normalized = value.toLowerCase(); return ({ required: "required", minlength: "min_length", maxlength: "max_length", enum: "enum", minimum: "minimum", maximum: "maximum", format: "format", pattern: "pattern" } as Record<string, string>)[normalized] || ""; }
