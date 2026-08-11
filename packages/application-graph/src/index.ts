import crypto from "node:crypto";

export const EVIDENCE_SCHEMA_VERSION = "autopw.evidence/1.0" as const;
export const APPLICATION_GRAPH_SCHEMA_VERSION = "autopw.application-graph/1.0" as const;
export const GRAPH_DIAGNOSTICS_SCHEMA_VERSION = "autopw.graph-diagnostics/1.0" as const;

export type EvidenceSourceKind = "OPENAPI" | "AST" | "RUNTIME" | "DOM" | "REGEX" | "MANUAL" | "INFERRED";
export type GraphNodeKind = "operation" | "resource" | "field" | "route" | "control" | "workflow";

export interface EvidenceFact {
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  evidence_id: string;
  source_fact_id: string;
  fact_type: string;
  source_kind: EvidenceSourceKind;
  source_ref: Record<string, unknown>;
  confidence: number;
  subject: { kind: string; id: string };
  attributes: Record<string, unknown>;
}

export interface EvidenceCollection {
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  evidence: EvidenceFact[];
}

export interface GraphNodeBase {
  id: string;
  kind: GraphNodeKind;
  evidence_refs: string[];
  confidence: number;
}

export interface OperationNode extends GraphNodeBase {
  kind: "operation";
  protocol: "HTTP" | "GRAPHQL" | "RPC" | "UI";
  method?: string;
  path_template?: string;
  operation_kinds: string[];
  feature_ids: string[];
  request_schema_refs: string[];
  response_statuses: number[];
  identity_candidates: Array<{ kind: "response_body" | "location_header" | "explicit"; path?: string; header?: string }>;
  resource_id?: string;
}

export interface ResourceNode extends GraphNodeBase {
  kind: "resource";
  collection_path: string;
  operation_ids: string[];
  field_ids: string[];
}

export interface FieldNode extends GraphNodeBase {
  kind: "field";
  name: string;
  resource_id?: string;
  constraints: Array<{ rule: string; value?: unknown; values?: unknown[] }>;
  schema_types: string[];
  examples: unknown[];
}

export interface RouteNode extends GraphNodeBase {
  kind: "route";
  path: string;
}

export interface ControlNode extends GraphNodeBase {
  kind: "control";
  route_id: string;
  role?: string;
  accessible_name?: string;
  locator?: string;
}

export interface WorkflowNode extends GraphNodeBase {
  kind: "workflow";
  name: string;
  operation_ids: string[];
}

export type ApplicationGraphNode = OperationNode | ResourceNode | FieldNode | RouteNode | ControlNode | WorkflowNode;

export interface ApplicationGraphEdge {
  id: string;
  relation: "RESOURCE_OPERATION" | "RESOURCE_FIELD" | "ROUTE_CONTROL" | "CONTROL_OPERATION" | "WORKFLOW_OPERATION";
  from: string;
  to: string;
  confidence: number;
  evidence_refs: string[];
}

export interface ApplicationGraph {
  schema_version: typeof APPLICATION_GRAPH_SCHEMA_VERSION;
  graph_id: string;
  evidence_schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  nodes: {
    operations: OperationNode[];
    resources: ResourceNode[];
    fields: FieldNode[];
    routes: RouteNode[];
    controls: ControlNode[];
    workflows: WorkflowNode[];
  };
  edges: ApplicationGraphEdge[];
}

export interface GraphDiagnostic {
  diagnostic_id: string;
  code: "CONFLICTING_OPERATION_EVIDENCE" | "AMBIGUOUS_FIELD_RESOURCE" | "WEAK_ASSOCIATION" | "UNLINKED_CORRELATION" | "UNLINKED_WORKFLOW_OPERATION";
  severity: "warning" | "error";
  message: string;
  subject_refs: string[];
  evidence_refs: string[];
}

export interface GraphDiagnostics {
  schema_version: typeof GRAPH_DIAGNOSTICS_SCHEMA_VERSION;
  graph_id: string;
  diagnostics: GraphDiagnostic[];
}

export interface GraphBuildResult {
  evidence: EvidenceCollection;
  graph: ApplicationGraph;
  diagnostics: GraphDiagnostics;
}

export interface DiscoveryLike {
  observations: Array<Record<string, unknown>>;
}

interface FactRecord extends Record<string, unknown> {
  fact_id: string;
  fact_type: string;
}

interface OperationAccumulator {
  node: OperationNode;
  operationKinds: Set<string>;
  featureIds: Set<string>;
  requestSchemaRefs: Set<string>;
  responseStatuses: Set<number>;
  identityCandidates: Array<{ kind: "response_body" | "location_header" | "explicit"; path?: string; header?: string }>;
  evidenceRefs: Set<string>;
  factIds: Set<string>;
  confidenceTotal: number;
  confidenceCount: number;
}

export function buildApplicationGraph(discovery: DiscoveryLike): GraphBuildResult {
  const facts = discovery.observations.filter(isFactRecord).sort((left, right) => left.fact_id.localeCompare(right.fact_id));
  const evidence = facts.map(toEvidenceFact).sort(byId("evidence_id"));
  const evidenceByFact = new Map(evidence.map((item) => [item.source_fact_id, item]));
  const diagnostics: GraphDiagnostic[] = [];
  const operationByFact = new Map<string, string>();
  const operationAccumulators = new Map<string, OperationAccumulator>();

  for (const fact of facts.filter((item) => item.fact_type === "endpoint")) {
    const method = upperString(fact.method) || "GET";
    const pathTemplate = normalizePath(stringValue(fact.path_template) || stringValue(fact.route) || "/");
    const key = method + "|" + pathTemplate;
    const evidenceRef = requiredEvidenceRef(evidenceByFact, fact.fact_id);
    let accumulator = operationAccumulators.get(key);
    if (!accumulator) {
      accumulator = {
        node: { id: stableId("operation", key), kind: "operation", protocol: protocolOf(fact), method, path_template: pathTemplate, operation_kinds: [], feature_ids: [], request_schema_refs: [], response_statuses: [], identity_candidates: [], evidence_refs: [], confidence: 0 },
        operationKinds: new Set(), featureIds: new Set(), requestSchemaRefs: new Set(), responseStatuses: new Set(), identityCandidates: [], evidenceRefs: new Set(), factIds: new Set(), confidenceTotal: 0, confidenceCount: 0
      };
      operationAccumulators.set(key, accumulator);
    }
    const operationKind = stringValue(fact.operation);
    if (operationKind) accumulator.operationKinds.add(operationKind);
    const featureId = stringValue(fact.feature_id);
    if (featureId) accumulator.featureIds.add(featureId);
    const requestSchemaRef = stringValue(fact.request_schema_ref);
    if (requestSchemaRef) accumulator.requestSchemaRefs.add(requestSchemaRef);
    for (const status of numberArray(fact.response_statuses)) accumulator.responseStatuses.add(status);
    for (const candidate of identityCandidatesOf(fact.identity_candidates)) accumulator.identityCandidates.push(candidate);
    accumulator.evidenceRefs.add(evidenceRef);
    accumulator.factIds.add(fact.fact_id);
    accumulator.confidenceTotal += confidenceOf(fact);
    accumulator.confidenceCount += 1;
    operationByFact.set(fact.fact_id, accumulator.node.id);
  }

  for (const fact of facts.filter((item) => item.fact_type === "runtime_response")) {
    const method = upperString(fact.method) || "GET";
    const pathTemplate = normalizePath(stringValue(fact.path_template) || "/");
    const accumulator = operationAccumulators.get(method + "|" + pathTemplate);
    if (!accumulator) continue;
    accumulator.evidenceRefs.add(requiredEvidenceRef(evidenceByFact, fact.fact_id));
    if (typeof fact.status === "number" && Number.isInteger(fact.status)) accumulator.responseStatuses.add(fact.status);
    accumulator.confidenceTotal += confidenceOf(fact);
    accumulator.confidenceCount += 1;
  }

  const operations = [...operationAccumulators.values()].map((accumulator) => {
    accumulator.node.operation_kinds = [...accumulator.operationKinds].sort();
    accumulator.node.feature_ids = [...accumulator.featureIds].sort();
    accumulator.node.request_schema_refs = [...accumulator.requestSchemaRefs].sort();
    accumulator.node.response_statuses = [...accumulator.responseStatuses].sort((left, right) => left - right);
    accumulator.node.identity_candidates = uniqueObjects(accumulator.identityCandidates);
    accumulator.node.evidence_refs = [...accumulator.evidenceRefs].sort();
    accumulator.node.confidence = rounded(accumulator.confidenceTotal / accumulator.confidenceCount);
    if (accumulator.operationKinds.size > 1) {
      diagnostics.push(makeDiagnostic("CONFLICTING_OPERATION_EVIDENCE", "warning", `Operation ${accumulator.node.method} ${accumulator.node.path_template} has conflicting semantic claims: ${accumulator.node.operation_kinds.join(", ")}.`, [accumulator.node.id], accumulator.node.evidence_refs));
    }
    return accumulator.node;
  }).sort(byId("id"));

  const resourcePaths = resourceCandidates(operations);
  const resources = new Map<string, ResourceNode>();
  for (const operation of operations) {
    const pathTemplate = pathWithoutQuery(operation.path_template || "/");
    const collectionPath = bestResourcePath(pathTemplate, resourcePaths);
    const resourceId = stableId("resource", collectionPath);
    operation.resource_id = resourceId;
    const current = resources.get(resourceId) || { id: resourceId, kind: "resource" as const, collection_path: collectionPath, operation_ids: [], field_ids: [], evidence_refs: [], confidence: operation.confidence };
    current.operation_ids = sortedUnique([...current.operation_ids, operation.id]);
    current.evidence_refs = sortedUnique([...current.evidence_refs, ...operation.evidence_refs]);
    current.confidence = rounded(Math.min(current.confidence, operation.confidence));
    resources.set(resourceId, current);
  }

  const resourceIdsByFeature = new Map<string, Set<string>>();
  for (const operation of operations) for (const featureId of operation.feature_ids) {
    const ids = resourceIdsByFeature.get(featureId) || new Set<string>();
    if (operation.resource_id) ids.add(operation.resource_id);
    resourceIdsByFeature.set(featureId, ids);
  }

  const fieldAccumulators = new Map<string, FieldNode>();
  for (const fact of facts.filter((item) => item.fact_type === "validation" || item.fact_type === "field")) {
    const name = stringValue(fact.field) || stringValue(fact.name);
    if (!name) continue;
    const evidenceRef = requiredEvidenceRef(evidenceByFact, fact.fact_id);
    const featureId = stringValue(fact.feature_id);
    const explicitResourcePath = stringValue(fact.resource_path);
    const candidates = explicitResourcePath
      ? [stableId("resource", pathWithoutQuery(normalizePath(explicitResourcePath)))]
      : featureId ? [...(resourceIdsByFeature.get(featureId) || [])].sort() : [];
    const existingCandidates = candidates.filter((candidate) => resources.has(candidate));
    const mutationCandidates = existingCandidates.filter((candidate) => {
      const resource = resources.get(candidate);
      return resource?.operation_ids.some((operationId) => ["POST", "PUT", "PATCH", "DELETE"].includes(operations.find((operation) => operation.id === operationId)?.method || ""));
    });
    const resourceId = existingCandidates.length === 1 ? existingCandidates[0] : mutationCandidates.length === 1 ? mutationCandidates[0] : undefined;
    if (existingCandidates.length > 1 && !resourceId) diagnostics.push(makeDiagnostic("AMBIGUOUS_FIELD_RESOURCE", "warning", `Field ${name} matches multiple resources for feature ${featureId}.`, existingCandidates, [evidenceRef]));
    const key = (resourceId || "unbound") + "|" + name;
    const fieldId = stableId("field", key);
    if (resourceId && !explicitResourcePath) diagnostics.push(makeDiagnostic("WEAK_ASSOCIATION", "warning", `Field ${name} is associated to a resource only through feature ${featureId}.`, [fieldId, resourceId], [evidenceRef]));
    const constraint = constraintOf(fact);
    const current = fieldAccumulators.get(key) || { id: fieldId, kind: "field" as const, name, ...(resourceId ? { resource_id: resourceId } : {}), constraints: [], schema_types: [], examples: [], evidence_refs: [], confidence: confidenceOf(fact) };
    if (constraint) current.constraints.push(constraint);
    current.constraints = uniqueObjects(current.constraints);
    const schemaType = stringValue(fact.schema_type);
    if (schemaType) current.schema_types = sortedUnique([...current.schema_types, schemaType]);
    if (Object.hasOwn(fact, "example")) current.examples = uniqueObjects([...current.examples, fact.example]);
    if (Object.hasOwn(fact, "default")) current.examples = uniqueObjects([...current.examples, fact.default]);
    current.evidence_refs = sortedUnique([...current.evidence_refs, evidenceRef]);
    current.confidence = rounded(Math.min(current.confidence, confidenceOf(fact)));
    fieldAccumulators.set(key, current);
  }
  const fields = [...fieldAccumulators.values()].sort(byId("id"));
  for (const field of fields) if (field.resource_id) {
    const resource = resources.get(field.resource_id);
    if (resource) resource.field_ids = sortedUnique([...resource.field_ids, field.id]);
  }

  const routeAccumulators = new Map<string, RouteNode>();
  const routeByPath = new Map<string, string>();
  for (const fact of facts.filter((item) => item.fact_type === "endpoint" || item.fact_type === "control")) {
    const route = normalizePath(stringValue(fact.route) || "/");
    const evidenceRef = requiredEvidenceRef(evidenceByFact, fact.fact_id);
    const routeId = stableId("route", route);
    const current = routeAccumulators.get(route) || { id: routeId, kind: "route" as const, path: route, evidence_refs: [], confidence: confidenceOf(fact) };
    current.evidence_refs = sortedUnique([...current.evidence_refs, evidenceRef]);
    current.confidence = rounded(Math.min(current.confidence, confidenceOf(fact)));
    routeAccumulators.set(route, current);
    routeByPath.set(route, routeId);
  }

  const controlByFact = new Map<string, string>();
  const controls = facts.filter((item) => item.fact_type === "control").map((fact) => {
    const route = normalizePath(stringValue(fact.route) || "/");
    const key = [route, stringValue(fact.control_id), stringValue(fact.role), stringValue(fact.accessible_name), stringValue(fact.locator)].join("|");
    const control: ControlNode = {
      id: stableId("control", key), kind: "control", route_id: routeByPath.get(route) || stableId("route", route),
      ...(stringValue(fact.role) ? { role: stringValue(fact.role) } : {}),
      ...(stringValue(fact.accessible_name) ? { accessible_name: stringValue(fact.accessible_name) } : {}),
      ...(stringValue(fact.locator) ? { locator: stringValue(fact.locator) } : {}),
      evidence_refs: [requiredEvidenceRef(evidenceByFact, fact.fact_id)], confidence: confidenceOf(fact)
    };
    controlByFact.set(fact.fact_id, control.id);
    return control;
  }).sort(byId("id"));

  const workflows = facts.filter((item) => item.fact_type === "workflow").map((fact) => {
    const evidenceRef = requiredEvidenceRef(evidenceByFact, fact.fact_id);
    const factOperationIds = arrayStrings(fact.operation_fact_ids).map((id) => operationByFact.get(id)).filter((id): id is string => Boolean(id));
    const workflow: WorkflowNode = { id: stableId("workflow", fact.fact_id), kind: "workflow", name: stringValue(fact.name) || fact.fact_id, operation_ids: sortedUnique(factOperationIds), evidence_refs: [evidenceRef], confidence: confidenceOf(fact) };
    const missing = arrayStrings(fact.operation_fact_ids).filter((id) => !operationByFact.has(id));
    if (missing.length) diagnostics.push(makeDiagnostic("UNLINKED_WORKFLOW_OPERATION", "warning", `Workflow ${workflow.name} references unknown operation facts.`, [workflow.id, ...missing], [evidenceRef]));
    return workflow;
  }).sort(byId("id"));

  const edges: ApplicationGraphEdge[] = [];
  for (const resource of resources.values()) {
    for (const operationId of resource.operation_ids) {
      const operation = operations.find((item) => item.id === operationId);
      edges.push(makeEdge("RESOURCE_OPERATION", resource.id, operationId, intersectEvidence(resource.evidence_refs, operation?.evidence_refs || resource.evidence_refs), operation?.confidence || resource.confidence));
    }
    for (const fieldId of resource.field_ids) {
      const field = fields.find((item) => item.id === fieldId);
      edges.push(makeEdge("RESOURCE_FIELD", resource.id, fieldId, field?.evidence_refs || resource.evidence_refs, field?.confidence || resource.confidence));
    }
  }
  for (const control of controls) edges.push(makeEdge("ROUTE_CONTROL", control.route_id, control.id, control.evidence_refs, control.confidence));
  for (const workflow of workflows) for (const operationId of workflow.operation_ids) edges.push(makeEdge("WORKFLOW_OPERATION", workflow.id, operationId, workflow.evidence_refs, workflow.confidence));
  for (const fact of facts.filter((item) => item.fact_type === "correlation")) {
    const evidenceRef = requiredEvidenceRef(evidenceByFact, fact.fact_id);
    const controlId = controlByFact.get(stringValue(fact.control_fact_id));
    const operationId = operationByFact.get(stringValue(fact.endpoint_fact_id));
    if (controlId && operationId) edges.push(makeEdge("CONTROL_OPERATION", controlId, operationId, [evidenceRef], confidenceOf(fact)));
    else diagnostics.push(makeDiagnostic("UNLINKED_CORRELATION", "warning", "A correlation fact could not be linked to both graph endpoints.", [fact.fact_id, controlId || stringValue(fact.control_fact_id), operationId || stringValue(fact.endpoint_fact_id)].filter(Boolean), [evidenceRef]));
  }

  const graphId = stableId("graph", stableJson(facts));
  const graph: ApplicationGraph = {
    schema_version: APPLICATION_GRAPH_SCHEMA_VERSION,
    graph_id: graphId,
    evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
    nodes: {
      operations,
      resources: [...resources.values()].sort(byId("id")),
      fields,
      routes: [...routeAccumulators.values()].sort(byId("id")),
      controls,
      workflows
    },
    edges: dedupeById(edges).sort(byId("id"))
  };
  return {
    evidence: { schema_version: EVIDENCE_SCHEMA_VERSION, evidence },
    graph,
    diagnostics: { schema_version: GRAPH_DIAGNOSTICS_SCHEMA_VERSION, graph_id: graphId, diagnostics: dedupeById(diagnostics).sort(byId("diagnostic_id")) }
  };
}

function isFactRecord(value: Record<string, unknown>): value is FactRecord {
  return value.kind === "fact" && typeof value.fact_id === "string" && typeof value.fact_type === "string";
}

function toEvidenceFact(fact: FactRecord): EvidenceFact {
  const sourceRef = isRecord(fact.source_ref) ? fact.source_ref : {};
  const attributes = Object.fromEntries(Object.entries(fact).filter(([key]) => !["kind", "untrusted", "observation_id", "fact_id", "fact_type", "confidence", "source_kind", "source_ref"].includes(key)));
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    evidence_id: stableId("evidence", fact.fact_id + "|" + stableJson(fact)),
    source_fact_id: fact.fact_id,
    fact_type: fact.fact_type,
    source_kind: sourceKindOf(fact, sourceRef),
    source_ref: sourceRef,
    confidence: confidenceOf(fact),
    subject: { kind: fact.fact_type, id: fact.fact_id },
    attributes
  };
}

function sourceKindOf(fact: FactRecord, sourceRef: Record<string, unknown>): EvidenceSourceKind {
  const explicit = upperString(fact.source_kind) as EvidenceSourceKind;
  if (["OPENAPI", "AST", "RUNTIME", "DOM", "REGEX", "MANUAL", "INFERRED"].includes(explicit)) return explicit;
  const sourcePath = stringValue(sourceRef.path);
  if (sourcePath === "<live>") return fact.fact_type === "control" || fact.fact_type === "validation" ? "DOM" : "RUNTIME";
  if (sourcePath === "<correlation>" || fact.fact_type === "correlation" || fact.fact_type === "workflow") return "INFERRED";
  return "REGEX";
}

function protocolOf(fact: FactRecord): OperationNode["protocol"] {
  const protocol = upperString(fact.protocol);
  return protocol === "GRAPHQL" || protocol === "RPC" || protocol === "UI" ? protocol : "HTTP";
}

function resourceCandidates(operations: OperationNode[]): string[] {
  const candidates = new Set<string>();
  for (const operation of operations) {
    const operationPath = pathWithoutQuery(operation.path_template || "/");
    const segments = operationPath.split("/").filter(Boolean);
    const parameterIndex = segments.findIndex((segment) => segment.startsWith(":"));
    if (parameterIndex >= 0) candidates.add("/" + segments.slice(0, parameterIndex).join("/"));
    if (operation.method === "POST") candidates.add(operationPath);
  }
  for (const operation of operations) {
    const operationPath = pathWithoutQuery(operation.path_template || "/");
    if (![...candidates].some((candidate) => belongsToResource(operationPath, candidate))) candidates.add(operationPath);
  }
  return [...candidates].filter(Boolean).sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function bestResourcePath(operationPath: string, candidates: string[]): string {
  return candidates.find((candidate) => belongsToResource(operationPath, candidate)) || operationPath;
}

function belongsToResource(operationPath: string, candidate: string): boolean {
  return operationPath === candidate || operationPath.startsWith(candidate.endsWith("/") ? candidate : candidate + "/");
}

function constraintOf(fact: FactRecord): FieldNode["constraints"][number] | undefined {
  const rule = stringValue(fact.rule);
  if (!rule) return undefined;
  return { rule, ...(Object.hasOwn(fact, "value") ? { value: fact.value } : {}), ...(Array.isArray(fact.values) ? { values: fact.values } : {}) };
}

function identityCandidatesOf(value: unknown): OperationNode["identity_candidates"] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((item) => {
    const kind = stringValue(item.kind);
    if (kind !== "response_body" && kind !== "location_header" && kind !== "explicit") return [];
    const path = stringValue(item.path);
    const header = stringValue(item.header);
    return [{ kind, ...(path ? { path } : {}), ...(header ? { header: header.toLowerCase() } : {}) }];
  });
}

function makeEdge(relation: ApplicationGraphEdge["relation"], from: string, to: string, evidenceRefs: string[], confidence: number): ApplicationGraphEdge {
  const refs = sortedUnique(evidenceRefs);
  return { id: stableId("edge", [relation, from, to, ...refs].join("|")), relation, from, to, confidence: rounded(confidence), evidence_refs: refs };
}

function makeDiagnostic(code: GraphDiagnostic["code"], severity: GraphDiagnostic["severity"], message: string, subjectRefs: string[], evidenceRefs: string[]): GraphDiagnostic {
  const refs = sortedUnique(evidenceRefs);
  const subjects = sortedUnique(subjectRefs);
  return { diagnostic_id: stableId("diagnostic", [code, ...subjects, ...refs].join("|")), code, severity, message, subject_refs: subjects, evidence_refs: refs };
}

function requiredEvidenceRef(evidenceByFact: Map<string, EvidenceFact>, factId: string): string {
  const evidence = evidenceByFact.get(factId);
  if (!evidence) throw new Error(`EVIDENCE_NOT_FOUND: ${factId}`);
  return evidence.evidence_id;
}

function intersectEvidence(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  const intersection = left.filter((item) => rightSet.has(item));
  return intersection.length ? sortedUnique(intersection) : sortedUnique([...left, ...right]);
}

function confidenceOf(value: Record<string, unknown>): number {
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence) ? value.confidence : 0.5;
  return rounded(Math.max(0, Math.min(1, confidence)));
}

function normalizePath(value: string): string {
  try {
    const parsed = new URL(value, "http://application-graph.invalid");
    const pathname = decodeURIComponent(parsed.pathname).replace(/\{([^}]+)\}/g, ":$1").replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    return pathname + parsed.search.replace(/%20/g, " ");
  } catch {
    return (value.split("#")[0] || "/").replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  }
}

function pathWithoutQuery(value: string): string { return value.split("?")[0] || "/"; }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function upperString(value: unknown): string { return stringValue(value).toUpperCase(); }
function arrayStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function numberArray(value: unknown): number[] { return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isInteger(item)) : []; }
function rounded(value: number): number { return Number(value.toFixed(4)); }
function sortedUnique(values: string[]): string[] { return [...new Set(values)].sort(); }
function uniqueObjects<T>(values: T[]): T[] { return [...new Map(values.map((value) => [stableJson(value), value])).values()].sort((left, right) => stableJson(left).localeCompare(stableJson(right))); }
function dedupeById<T extends { id?: string; diagnostic_id?: string }>(values: T[]): T[] { return [...new Map(values.map((value) => [value.id || value.diagnostic_id || stableJson(value), value])).values()]; }
function byId<Key extends string>(key: Key): (left: Record<Key, string>, right: Record<Key, string>) => number { return (left, right) => left[key].localeCompare(right[key]); }
function stableId(kind: string, input: string): string { return kind + "_" + crypto.createHash("sha256").update(input).digest("hex").slice(0, 16); }
function stableJson(value: unknown): string { return JSON.stringify(sortValue(value)); }
function sortValue(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortValue); if (!isRecord(value)) return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])])); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
