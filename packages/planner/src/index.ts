import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
type Tier = "smoke" | "fast" | "full";
interface PlannerCase { case_id: string; }

export interface Viewport { width: number; height: number; }
export interface MatrixProfile { browsers?: string[]; viewports?: Viewport[]; locales?: string[]; auth_scope_ids?: string[]; host_max_execution_instances?: number; profile_max_execution_instances?: number; }
export interface ExecutionBatch { batch_id: string; tier: Tier; browser: string; viewport: Viewport; locale: string; auth_scope_id: string; case_ids: string[]; }
export interface ExecutionInstance { execution_id: string; case_id: string; batch_id: string; status: "NOT_RUN"; }
export interface ExecutionProjection { projected_execution_instances: number; dimensions: { browsers: Record<string, number>; viewports: Record<string, number>; locales: Record<string, number>; auth_scopes: Record<string, number> }; batches: ExecutionBatch[]; instances: ExecutionInstance[]; effective_budget: number; narrowing_suggestions: string[]; }

export interface PlannerCandidate { id: string; kind: "action" | "route" | "locator" | "input" | "expectation" | "endpoint"; case_id: string; requirement_id?: string; scenario: string; route_id?: string; locator_id?: string; input_id?: string; endpoint_id?: string; action?: string; method?: string; path?: string; body?: unknown; step?: Record<string, unknown>; locator_ref?: Record<string, unknown>; origin?: string; strength?: "weak" | "normal" | "strong"; source?: "fixture" | "discovery" | "rule" | "manual"; confidence?: number; risk?: "read_only" | "mutating" | "destructive"; }
export interface CandidateCatalog { routes: Record<string, PlannerCandidate>; actions: Record<string, PlannerCandidate>; locators: Record<string, PlannerCandidate>; inputs: Record<string, PlannerCandidate>; expectations: Record<string, PlannerCandidate>; endpoints: Record<string, PlannerCandidate>; fixtures?: Record<string, PlannerCandidate>; extractors?: Record<string, PlannerCandidate>; cleanup_actions?: Record<string, PlannerCandidate>; }
export interface PlannerSkeleton { case_id: string; requirement_id?: string; feature_id?: string; scenario: string; priority?: "P0" | "P1" | "P2"; route_id?: string; action_ids?: string[]; expectation_ids?: string[]; status?: string; }
export interface PlannerObservation { observationId: string; untrusted: true; kind: string; value: string; }
export interface PlannerInput { schemaVersion: "2.1"; skeletons: PlannerSkeleton[]; candidates: CandidateCatalog; contractRefs: { contractId: string; version?: string; ref: string }[]; untrustedObservations: PlannerObservation[]; }
export interface ActionSelection { actionTemplateId: string; routeId?: string; locatorId?: string; inputId?: string; endpointId?: string; }
export interface CaseSelection { caseId: string; actionSelections: ActionSelection[]; expectationIds: string[]; description?: string; }
export interface PlannerOutput { caseSelections: CaseSelection[]; }
export interface PlannerProviderOptions { provider_id: string; provider_version: string; model_id: string; timeout_ms: number; token_budget: number; temperature: 0; max_attempts?: number; }
export interface PlannerProvider { readonly provider_id: string; readonly provider_version: string; fill(input: PlannerInput, options: PlannerProviderOptions): Promise<PlannerOutput>; }
export interface PlannerAuditSummary { provider_id: string; provider_version: string; model_id: string; temperature: 0; timeout_ms: number; token_budget: number; attempts: number; cache_hit: boolean; output_digest: string; }
export interface PlanTemplate { cache_key: string; selections_digest: string; planner_provider_id: string; model_id: string; provider_version: string; selections: PlannerOutput; created_at: string; }
export interface ValidationResult { ok: boolean; errors: string[]; }

const FORBIDDEN = /(?:javascript\s*:|<script|\b(?:node|child_process|require|import)\b|(?:^|\s)(?:sh|bash|powershell|cmd)(?:\s|$)|(?:css|xpath)\s*[:=]|https?:\/\/|(?:[A-Za-z]:\\|\/[^/]))/i;

export class DeterministicFixturePlanner implements PlannerProvider {
  readonly provider_id: string = "fixture-deterministic";
  readonly provider_version: string = "1";
  async fill(input: PlannerInput, _options: PlannerProviderOptions): Promise<PlannerOutput> {
    const selections: CaseSelection[] = input.skeletons.filter((item) => item.status !== "BLOCKED" && item.status !== "NOT_APPLICABLE" && item.status !== "TIER_SKIPPED").map((item) => {
      const actionIds = item.action_ids || Object.values(input.candidates.actions).filter((candidate) => candidate.case_id === item.case_id).map((candidate) => candidate.id).sort();
      const expectationIds = item.expectation_ids || Object.values(input.candidates.expectations).filter((candidate) => candidate.case_id === item.case_id).map((candidate) => candidate.id).sort();
      return {
        caseId: item.case_id,
        actionSelections: actionIds.map((actionTemplateId) => {
          const action = input.candidates.actions[actionTemplateId];
          return { actionTemplateId, routeId: action?.route_id, locatorId: action?.locator_id, inputId: action?.input_id, endpointId: action?.endpoint_id };
        }),
        expectationIds,
        description: "deterministic fixture selection"
      };
    });
    return { caseSelections: selections };
  }
}

/** Local structured provider used by the real runtime. It has no tools and consumes only typed candidates. */
export class LocalStructuredPlannerProvider extends DeterministicFixturePlanner {
  readonly provider_id = "local-structured";
  readonly provider_version = "1";
}

export function validatePlannerOutput(input: PlannerInput, output: PlannerOutput, { allowedOrigin, production }: { allowedOrigin?: string; production?: boolean } = {}): ValidationResult {
  const errors: string[] = [];
  if (!output || !Array.isArray(output.caseSelections)) return { ok: false, errors: ["output.caseSelections must be an array"] };
  const skeletons = new Map(input.skeletons.map((item) => [item.case_id, item]));
  const seenCases = new Set<string>();
  for (const selection of output.caseSelections) {
    if (!selection || typeof selection.caseId !== "string") { errors.push("caseId is required"); continue; }
    if (Object.keys(selection).some((key) => !["caseId", "actionSelections", "expectationIds", "description"].includes(key))) errors.push(selection.caseId + ": unknown selection field");
    if (selection.description && (selection.description.length > 240 || FORBIDDEN.test(selection.description))) errors.push(selection.caseId + ": unsafe description");
    if (seenCases.has(selection.caseId)) errors.push("duplicate caseId " + selection.caseId);
    seenCases.add(selection.caseId);
    const skeleton = skeletons.get(selection.caseId);
    if (!skeleton) { errors.push("unknown case candidate " + selection.caseId); continue; }
    if (skeleton.status === "BLOCKED" || skeleton.status === "NOT_APPLICABLE") errors.push("blocked case selected " + selection.caseId);
    const seenLocators = new Set<string>();
    for (const action of selection.actionSelections || []) {
      if (!action || typeof action.actionTemplateId !== "string") { errors.push(selection.caseId + ": actionTemplateId is required"); continue; }
      if (Object.keys(action).some((key) => !["actionTemplateId", "routeId", "locatorId", "inputId", "endpointId"].includes(key))) errors.push(selection.caseId + ": action selection contains non-candidate field");
      if (FORBIDDEN.test(JSON.stringify(action))) errors.push(selection.caseId + ": forbidden planner output content");
      const candidate = input.candidates.actions[action.actionTemplateId];
      if (!candidate || candidate.kind !== "action" || candidate.case_id !== selection.caseId) errors.push(selection.caseId + ": unknown or misbound action " + action.actionTemplateId);
      if (candidate && skeleton.route_id && candidate.route_id !== skeleton.route_id) errors.push(selection.caseId + ": route binding mismatch");
      if (action.routeId && (!candidate || action.routeId !== candidate.route_id || !input.candidates.routes[action.routeId] || input.candidates.routes[action.routeId].case_id !== selection.caseId)) errors.push(selection.caseId + ": invalid route selection");
      if (action.locatorId) {
        const locator = input.candidates.locators[action.locatorId];
        if (!locator || locator.case_id !== selection.caseId || locator.kind !== "locator" || (candidate?.locator_id && candidate.locator_id !== action.locatorId)) errors.push(selection.caseId + ": unknown locator " + action.locatorId);
        if (seenLocators.has(action.locatorId)) errors.push(selection.caseId + ": locator reused " + action.locatorId);
        seenLocators.add(action.locatorId);
      }
      if (action.inputId && (!input.candidates.inputs[action.inputId] || input.candidates.inputs[action.inputId].case_id !== selection.caseId || (candidate?.input_id && candidate.input_id !== action.inputId))) errors.push(selection.caseId + ": invalid input source");
      if (action.endpointId && (!input.candidates.endpoints[action.endpointId] || input.candidates.endpoints[action.endpointId].case_id !== selection.caseId || (candidate?.endpoint_id && candidate.endpoint_id !== action.endpointId))) errors.push(selection.caseId + ": invalid endpoint");
      if (production && candidate?.action && /(?:submit|delete|update|create|send|pay)/i.test(candidate.action)) errors.push(selection.caseId + ": mutating action forbidden in production");
    }
    for (const expectationId of selection.expectationIds || []) {
      const expectation = input.candidates.expectations[expectationId];
      if (!expectation || expectation.case_id !== selection.caseId || expectation.kind !== "expectation") errors.push(selection.caseId + ": unknown expectation " + expectationId);
      if (expectation?.strength === "weak") errors.push(selection.caseId + ": weak validation");
      if (expectation?.origin && allowedOrigin && expectation.origin !== allowedOrigin) errors.push(selection.caseId + ": expectation origin not allowed");
    }
    if (skeleton.action_ids) { const selectedActions = selection.actionSelections.map((action) => action.actionTemplateId); if (new Set(selectedActions).size !== new Set(skeleton.action_ids).size || skeleton.action_ids.some((id) => !selectedActions.includes(id))) errors.push(selection.caseId + ": coverage binding does not include all action candidates"); }
    if (skeleton.expectation_ids) { const selectedExpectations = selection.expectationIds || []; if (new Set(selectedExpectations).size !== new Set(skeleton.expectation_ids).size || skeleton.expectation_ids.some((id) => !selectedExpectations.includes(id))) errors.push(selection.caseId + ": coverage binding does not include all expectations"); }
    if (skeleton.scenario === "normal" && !(selection.expectationIds || []).some((id) => input.candidates.expectations[id]?.strength === "strong")) errors.push(selection.caseId + ": normal scenario lacks strong result assertion");
  }
  for (const skeleton of input.skeletons) if (skeleton.priority === "P0" && skeleton.status !== "BLOCKED" && skeleton.status !== "NOT_APPLICABLE" && skeleton.status !== "TIER_SKIPPED" && !seenCases.has(skeleton.case_id)) errors.push(skeleton.case_id + ": required P0 requirement was not planned");
  for (const observation of input.untrustedObservations || []) {
    if (observation.untrusted !== true) errors.push("observations must be marked untrusted");
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function plannerInputDigest(input: PlannerInput): string { return shortDigest(stableJson(input)); }
export function plannerOutputDigest(output: PlannerOutput): string { return shortDigest(stableJson(output)); }

export { buildCandidateCatalog, buildRequirementPlannerInput, requirementCaseId as plannerRequirementCaseId, type PlannerRequirementLike, type DiscoveryLike } from "./catalog-builder.js";

export class PlanTemplateCache {
  readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true }); }
  key(input: Record<string, unknown>): string {
    const forbidden = new Set(["run_id", "seed", "seed_value", "artifact_path"]);
    const filtered = Object.fromEntries(Object.entries(input).filter(([key]) => !forbidden.has(key)));
    return crypto.createHash("sha256").update(stableJson(filtered)).digest("hex");
  }
  get(key: string): PlanTemplate | undefined {
    const file = path.join(this.root, key + ".json");
    if (!fs.existsSync(file)) return undefined;
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as PlanTemplate;
      if (value.cache_key !== key || !value.selections || value.selections_digest !== plannerOutputDigest(value.selections)) return undefined;
      return value;
    } catch { return undefined; }
  }
  put(key: string, selections: PlannerOutput, provider: Pick<PlannerProviderOptions, "provider_id" | "provider_version" | "model_id">): PlanTemplate {
    const template: PlanTemplate = { cache_key: key, selections_digest: plannerOutputDigest(selections), planner_provider_id: provider.provider_id, model_id: provider.model_id, provider_version: provider.provider_version, selections, created_at: new Date().toISOString() };
    const file = path.join(this.root, key + ".json");
    const temporary = file + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(template, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, file);
    return template;
  }
}

const DEFAULTS: Required<Pick<MatrixProfile, "browsers" | "viewports" | "locales" | "auth_scope_ids">> = { browsers: ["chromium"], viewports: [{ width: 1280, height: 720 }], locales: ["en-US"], auth_scope_ids: ["as_demo"] };

export function planExecutionInstances(cases: PlannerCase[], tier: Tier, profile: MatrixProfile = {}): ExecutionProjection {
  const browsers = tier === "full" ? (profile.browsers || ["chromium", "firefox", "webkit"]) : (profile.browsers || DEFAULTS.browsers);
  const viewports = tier === "full" ? (profile.viewports || [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) : (profile.viewports || DEFAULTS.viewports);
  const locales = profile.locales || DEFAULTS.locales;
  const authScopes = profile.auth_scope_ids || DEFAULTS.auth_scope_ids;
  const effective_budget = Math.min(profile.host_max_execution_instances || Number.MAX_SAFE_INTEGER, profile.profile_max_execution_instances || Number.MAX_SAFE_INTEGER);
  const batches: ExecutionBatch[] = [];
  const instances: ExecutionInstance[] = [];
  const sortedCases = [...cases].sort((a, b) => a.case_id.localeCompare(b.case_id));
  if (sortedCases.length === 0) return { projected_execution_instances: 0, dimensions: { browsers: {}, viewports: {}, locales: {}, auth_scopes: {} }, batches: [], instances: [], effective_budget, narrowing_suggestions: [] };
  for (const batchKey of cartesian(tier, browsers, viewports, locales, authScopes)) {
    const batch_id = "BAT-" + shortDigest(JSON.stringify(batchKey));
    const batch: ExecutionBatch = { ...batchKey, batch_id, case_ids: sortedCases.map((item) => item.case_id) };
    batches.push(batch);
    for (const item of sortedCases) instances.push({ execution_id: "EXE-" + shortDigest(item.case_id + "|" + batch_id), case_id: item.case_id, batch_id, status: "NOT_RUN" });
  }
  batches.sort((a, b) => batchOrder(a, b));
  instances.sort((a, b) => a.case_id.localeCompare(b.case_id) || a.execution_id.localeCompare(b.execution_id));
  const dimensions = { browsers: countBy(instances, (instance) => batches.find((batch) => batch.batch_id === instance.batch_id)?.browser || ""), viewports: countBy(instances, (instance) => { const viewport = batches.find((batch) => batch.batch_id === instance.batch_id)?.viewport; return viewport ? viewport.width + "x" + viewport.height : ""; }), locales: countBy(instances, (instance) => batches.find((batch) => batch.batch_id === instance.batch_id)?.locale || ""), auth_scopes: countBy(instances, (instance) => batches.find((batch) => batch.batch_id === instance.batch_id)?.auth_scope_id || "") };
  const projected = instances.length;
  const narrowing_suggestions = projected > effective_budget ? ["reduce browser or viewport dimensions", "use fast/smoke explicitly", "increase the approved matrix budget"] : [];
  return { projected_execution_instances: projected, dimensions, batches, instances, effective_budget, narrowing_suggestions };
}

function cartesian(tier: Tier, browsers: string[], viewports: Viewport[], locales: string[], authScopes: string[]): Omit<ExecutionBatch, "batch_id" | "case_ids">[] { return browsers.flatMap((browser) => viewports.flatMap((viewport) => locales.flatMap((locale) => authScopes.map((auth_scope_id) => ({ tier, browser, viewport, locale, auth_scope_id }))))); }
function shortDigest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16); }
function stableJson(value: unknown): string {
  // Match JSON persistence semantics so a cached template validates after reload.
  if (value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map((item) => item === undefined ? "null" : stableJson(item)).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item)).join(",") + "}";
  return JSON.stringify(value);
}
function batchOrder(a: ExecutionBatch, b: ExecutionBatch): number { return a.tier.localeCompare(b.tier) || a.browser.localeCompare(b.browser) || a.viewport.width - b.viewport.width || a.viewport.height - b.viewport.height || a.locale.localeCompare(b.locale) || a.auth_scope_id.localeCompare(b.auth_scope_id); }
function countBy(items: ExecutionInstance[], key: (item: ExecutionInstance) => string): Record<string, number> { return items.reduce<Record<string, number>>((counts, item) => { const value = key(item); counts[value] = (counts[value] || 0) + 1; return counts; }, {}); }
