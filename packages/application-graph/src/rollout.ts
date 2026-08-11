import type { ApplicationGraph } from "./index.js";

export const APPLICATION_GRAPH_ROLLOUT_SCHEMA_VERSION = "autopw.application-graph-rollout/1.0" as const;

export const GENERALIZATION_TARGETS = [
  "rest_multi_resource", "axios", "nested_router", "nextjs", "openapi_only", "rbac",
  "pagination", "seeded_data", "read_only", "graphql", "rpc", "url_only"
] as const;

export type GeneralizationTarget = typeof GENERALIZATION_TARGETS[number];

export interface ApplicationGraphRolloutSnapshot {
  schema_version: typeof APPLICATION_GRAPH_ROLLOUT_SCHEMA_VERSION;
  mode: "dual";
  authoritative_lane: "application_graph";
  shadow_lane: "legacy_observations";
  application_graph: { graph_id: string; operation_count: number; resource_count: number; requirement_count: number; feature_ids: string[] };
  legacy_observations: { endpoint_fact_count: number; scenario_count: number; feature_ids: string[] };
  comparison: { shared_feature_ids: string[]; graph_only_feature_ids: string[]; legacy_only_feature_ids: string[] };
}

export interface GeneralizationAcceptanceInput {
  capabilities: Partial<Record<GeneralizationTarget, boolean>>;
  graph: ApplicationGraph;
  fixtures: Array<{ resource_id: string; operation_ids: string[] }>;
  controlled_generator_classifications: string[];
  dual_mode_snapshot?: ApplicationGraphRolloutSnapshot;
}

export interface GeneralizationAcceptanceResult {
  schema_version: "autopw.generalization-acceptance/1.0";
  status: "READY" | "BLOCKED";
  capabilities: Record<GeneralizationTarget, boolean>;
  missing_capabilities: GeneralizationTarget[];
  cross_resource_fixture_bindings: Array<{ resource_id: string; operation_id: string; actual_resource_id?: string }>;
  false_product_defects: number;
  dual_mode_recorded: boolean;
  blockers: string[];
}

/**
 * Records the retired heuristic inputs as a non-authoritative shadow lane. This
 * provides rollout evidence without allowing the old lane to change a plan.
 */
export function buildApplicationGraphRolloutSnapshot(input: {
  discovery: { observations: Array<Record<string, unknown>>; scenario_observations?: Array<{ feature_id?: string }> };
  graph: ApplicationGraph;
  requirement_ids?: string[];
}): ApplicationGraphRolloutSnapshot {
  const graphFeatures = sortedUnique(input.graph.nodes.operations.flatMap((item) => item.feature_ids));
  const scenarioFeatures = sortedUnique((input.discovery.scenario_observations || []).map((item) => stringValue(item.feature_id)).filter(Boolean));
  const endpointFacts = input.discovery.observations.filter((item) => item.fact_type === "endpoint");
  const endpointFeatures = endpointFacts.map((item) => stringValue(item.feature_id)).filter(Boolean);
  const legacyFeatures = sortedUnique([...scenarioFeatures, ...endpointFeatures]);
  const legacySet = new Set(legacyFeatures);
  const graphSet = new Set(graphFeatures);
  return {
    schema_version: APPLICATION_GRAPH_ROLLOUT_SCHEMA_VERSION,
    mode: "dual",
    authoritative_lane: "application_graph",
    shadow_lane: "legacy_observations",
    application_graph: {
      graph_id: input.graph.graph_id,
      operation_count: input.graph.nodes.operations.length,
      resource_count: input.graph.nodes.resources.length,
      requirement_count: sortedUnique(input.requirement_ids || []).length,
      feature_ids: graphFeatures
    },
    legacy_observations: {
      endpoint_fact_count: endpointFacts.length,
      scenario_count: input.discovery.scenario_observations?.length || 0,
      feature_ids: legacyFeatures
    },
    comparison: {
      shared_feature_ids: graphFeatures.filter((item) => legacySet.has(item)),
      graph_only_feature_ids: graphFeatures.filter((item) => !legacySet.has(item)),
      legacy_only_feature_ids: legacyFeatures.filter((item) => !graphSet.has(item))
    }
  };
}

export function evaluateGeneralizationAcceptance(input: GeneralizationAcceptanceInput): GeneralizationAcceptanceResult {
  const capabilities = Object.fromEntries(GENERALIZATION_TARGETS.map((target) => [target, input.capabilities[target] === true])) as Record<GeneralizationTarget, boolean>;
  const missingCapabilities = GENERALIZATION_TARGETS.filter((target) => !capabilities[target]);
  const operationResource = new Map(input.graph.nodes.operations.map((operation) => [operation.id, operation.resource_id]));
  const crossResource = input.fixtures.flatMap((fixture) => fixture.operation_ids.flatMap((operationId) => {
    const actual = operationResource.get(operationId);
    return actual && actual !== fixture.resource_id ? [{ resource_id: fixture.resource_id, operation_id: operationId, actual_resource_id: actual }] : [];
  }));
  const falseProductDefects = input.controlled_generator_classifications.filter((classification) => classification === "PRODUCT_DEFECT").length;
  const dualModeRecorded = input.dual_mode_snapshot?.mode === "dual" && input.dual_mode_snapshot.authoritative_lane === "application_graph" && input.dual_mode_snapshot.shadow_lane === "legacy_observations";
  const blockers = [
    ...missingCapabilities.map((target) => `MISSING_GENERALIZATION_TARGET:${target}`),
    ...(crossResource.length ? ["CROSS_RESOURCE_FIXTURE_BINDING"] : []),
    ...(falseProductDefects ? ["FALSE_PRODUCT_DEFECT"] : []),
    ...(!dualModeRecorded ? ["DUAL_MODE_EVIDENCE_MISSING"] : [])
  ];
  return {
    schema_version: "autopw.generalization-acceptance/1.0",
    status: blockers.length ? "BLOCKED" : "READY",
    capabilities,
    missing_capabilities: missingCapabilities,
    cross_resource_fixture_bindings: crossResource,
    false_product_defects: falseProductDefects,
    dual_mode_recorded: dualModeRecorded,
    blockers
  };
}

function sortedUnique(values: string[]): string[] { return [...new Set(values)].sort(); }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
