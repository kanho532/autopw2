import type { CandidateCatalog, PlannerCandidate, PlannerSkeleton } from "./index.js";

export interface PlannerRequirementLike {
  requirement_id: string;
  feature_id: string;
  intent: string;
  scenario: string;
  priority: "P0" | "P1" | "P2";
  source_refs: string[];
  risk: "read_only" | "mutating" | "destructive";
  confidence: number;
  status: string;
  oracle: { kind: string; assertion: string; details?: Record<string, unknown> } | null;
}
export interface DiscoveryLike { observations: Array<Record<string, unknown>>; candidates?: Array<Record<string, unknown>>; }

export function buildCandidateCatalog({ discovery, requirements, manualOverlay = {} }: { discovery: DiscoveryLike; requirements: PlannerRequirementLike[]; manualOverlay?: Record<string, unknown> }): CandidateCatalog {
  const catalog: CandidateCatalog = { routes: {}, actions: {}, locators: {}, inputs: {}, expectations: {}, endpoints: {}, fixtures: {}, extractors: {}, cleanup_actions: {} };
  const facts = discovery.observations.filter((item) => item.kind === "fact" && item.untrusted === true);
  for (const requirement of [...requirements].sort((a, b) => a.requirement_id.localeCompare(b.requirement_id))) {
    const caseId = requirementCaseId(requirement.requirement_id);
    const related = facts.filter((fact) => typeof fact.fact_id === "string" && requirement.source_refs.includes(String(fact.fact_id)));
    const endpointFact = related.find((fact) => fact.fact_type === "endpoint") || facts.find((fact) => fact.fact_type === "endpoint" && fact.feature_id === requirement.feature_id);
    const controlFact = related.find((fact) => fact.fact_type === "control") || facts.find((fact) => fact.fact_type === "control" && fact.feature_id === requirement.feature_id);
    const route = String(endpointFact?.route || controlFact?.route || "/");
    const routeId = "route_" + safeId(requirement.requirement_id);
    catalog.routes[routeId] = candidate({ id: routeId, kind: "route", requirement, caseId, route_id: routeId, source: endpointFact ? "discovery" : "rule", path: safePath(route) });
    const endpoint = endpointFact ? addEndpoint(catalog, endpointFact, requirement, caseId, routeId) : undefined;
    const locator = controlFact ? addLocator(catalog, controlFact, requirement, caseId, routeId) : undefined;
    const actionId = "act_" + safeId(requirement.requirement_id);
    const actionStep = createActionStep(requirement, endpoint, route);
    const action = candidate({ id: actionId, kind: "action", requirement, caseId, route_id: routeId, locator_id: locator?.id, endpoint_id: endpoint?.id, action: String(actionStep.action), step: actionStep, source: endpoint ? "discovery" : "rule" });
    catalog.actions[actionId] = action;
    const expectationId = "exp_" + safeId(requirement.requirement_id);
    const expectationStep = createExpectationStep(requirement, endpoint, locator);
    catalog.expectations[expectationId] = candidate({ id: expectationId, kind: "expectation", requirement, caseId, route_id: routeId, origin: typeof manualOverlay.allowed_origin === "string" ? manualOverlay.allowed_origin : undefined, strength: "strong", step: expectationStep, source: "rule" });
    if (requirement.intent === "required_field_rejected" || requirement.intent === "enum_validation") {
      const inputId = "input_" + safeId(requirement.requirement_id);
      catalog.inputs[inputId] = candidate({ id: inputId, kind: "input", requirement, caseId, route_id: routeId, source: "rule", body: requirement.intent === "enum_validation" ? { priority: "unsupported" } : {} });
      action.input_id = inputId;
    }
  }
  return catalog;
}

export function buildRequirementPlannerInput(requirements: PlannerRequirementLike[], catalog: CandidateCatalog): PlannerSkeleton[] {
  return [...requirements].sort((a, b) => a.requirement_id.localeCompare(b.requirement_id)).map((requirement) => {
    const caseId = requirementCaseId(requirement.requirement_id);
    return { case_id: caseId, requirement_id: requirement.requirement_id, feature_id: requirement.feature_id, scenario: requirement.scenario, priority: requirement.priority, route_id: "route_" + safeId(requirement.requirement_id), action_ids: Object.values(catalog.actions).filter((item) => item.case_id === caseId).map((item) => item.id).sort(), expectation_ids: Object.values(catalog.expectations).filter((item) => item.case_id === caseId).map((item) => item.id).sort(), status: requirement.status };
  });
}

export function requirementCaseId(requirementId: string): string { return "case_" + safeId(requirementId); }

function addEndpoint(catalog: CandidateCatalog, fact: Record<string, unknown>, requirement: PlannerRequirementLike, caseId: string, routeId: string): PlannerCandidate {
  const id = "endpoint_" + safeId(requirement.requirement_id) + "_" + safeId(String(fact.fact_id || "fact"));
  const endpoint = candidate({ id, kind: "endpoint", requirement, caseId, route_id: routeId, method: String(fact.method || "GET"), path: concretePath(String(fact.path_template || "/"), requirement.intent), source: "discovery" });
  catalog.endpoints[id] = endpoint;
  return endpoint;
}

function addLocator(catalog: CandidateCatalog, fact: Record<string, unknown>, requirement: PlannerRequirementLike, caseId: string, routeId: string): PlannerCandidate | undefined {
  const raw = String(fact.locator || "");
  if (!raw.startsWith("#") || !/^[#][A-Za-z0-9_.:-]+$/.test(raw)) return undefined;
  const id = "locator_" + safeId(requirement.requirement_id) + "_" + safeId(String(fact.fact_id || raw));
  if (!catalog.locators[id]) catalog.locators[id] = candidate({ id, kind: "locator", requirement, caseId, route_id: routeId, locator_ref: { by: "id", value: raw.slice(1) }, source: "discovery" });
  return catalog.locators[id];
}

function createActionStep(requirement: PlannerRequirementLike, endpoint: PlannerCandidate | undefined, route: string): Record<string, unknown> {
  if (!endpoint) return { action: "goto", path: safePath(route) };
  const method = endpoint.method || "GET";
  const step: Record<string, unknown> = { action: "api_request", method, path: endpoint.path || "/", save_as: "response_" + safeId(requirement.requirement_id) };
  if (method === "POST") step.body = requirement.intent === "required_field_rejected" ? { priority: "normal" } : requirement.intent === "enum_validation" ? { title: "AutoPW", priority: "unsupported" } : { title: "AutoPW generated", priority: "normal" };
  if (method === "PATCH") step.body = { title: "AutoPW updated", completed: true, priority: "normal" };
  return step;
}

function createExpectationStep(requirement: PlannerRequirementLike, endpoint: PlannerCandidate | undefined, locator: PlannerCandidate | undefined): Record<string, unknown> {
  if (!endpoint) return { action: "expect_visible", locator: locator?.locator_ref || { by: "role", role: "main" } };
  const details = requirement.oracle?.details || {};
  const expectedStatus = typeof details.status === "number" ? details.status : requirement.intent === "not_found_semantics" ? 404 : requirement.intent === "cors_allows_operation" ? 204 : requirement.intent === "create_succeeds" ? 201 : requirement.intent === "required_field_rejected" || requirement.intent === "enum_validation" ? 400 : requirement.intent === "delete_removes_entity" ? 204 : 200;
  return { action: "expect_status", source: "response_" + safeId(requirement.requirement_id), equals: expectedStatus };
}

function candidate({ id, kind, requirement, caseId, ...fields }: { id: string; kind: PlannerCandidate["kind"]; requirement: PlannerRequirementLike; caseId: string } & Partial<PlannerCandidate>): PlannerCandidate {
  return { id, kind, case_id: caseId, requirement_id: requirement.requirement_id, scenario: requirement.scenario, confidence: requirement.confidence, risk: requirement.risk, ...fields };
}
function concretePath(value: string, intent: string): string { const path = value.replace(/:id/g, intent === "not_found_semantics" ? "missing-task" : "task_generated").replace(/:query/g, "AutoPW"); return safePath(path); }
function safePath(value: string): string { const path = value.startsWith("/") ? value : "/" + value; return path.replace(/[^A-Za-z0-9_./?=&:%{}$-]/g, "_"); }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 90); }
