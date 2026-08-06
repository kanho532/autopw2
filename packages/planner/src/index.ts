import crypto from "node:crypto";
type Tier = "smoke" | "fast" | "full";
interface PlannerCase { case_id: string; }

export interface Viewport { width: number; height: number; }
export interface MatrixProfile { browsers?: string[]; viewports?: Viewport[]; locales?: string[]; auth_scope_ids?: string[]; host_max_execution_instances?: number; profile_max_execution_instances?: number; }
export interface ExecutionBatch { batch_id: string; tier: Tier; browser: string; viewport: Viewport; locale: string; auth_scope_id: string; case_ids: string[]; }
export interface ExecutionInstance { execution_id: string; case_id: string; batch_id: string; status: "NOT_RUN"; }
export interface ExecutionProjection { projected_execution_instances: number; dimensions: { browsers: Record<string, number>; viewports: Record<string, number>; locales: Record<string, number>; auth_scopes: Record<string, number> }; batches: ExecutionBatch[]; instances: ExecutionInstance[]; effective_budget: number; narrowing_suggestions: string[]; }

const DEFAULTS: Required<Pick<MatrixProfile, "browsers" | "viewports" | "locales" | "auth_scope_ids">> = { browsers: ["chromium"], viewports: [{ width: 1280, height: 720 }], locales: ["en-US"], auth_scope_ids: ["as_demo"] };

export function planExecutionInstances(cases: PlannerCase[], tier: Tier, profile: MatrixProfile = {}): ExecutionProjection {
  const browsers = tier === "full" ? (profile.browsers || ["chromium", "firefox", "webkit"]) : (profile.browsers || DEFAULTS.browsers);
  const viewports = tier === "full" ? (profile.viewports || [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) : (profile.viewports || DEFAULTS.viewports);
  const locales = profile.locales || DEFAULTS.locales;
  const authScopes = profile.auth_scope_ids || DEFAULTS.auth_scope_ids;
  const batches: ExecutionBatch[] = [];
  const instances: ExecutionInstance[] = [];
  const sortedCases = [...cases].sort((a, b) => a.case_id.localeCompare(b.case_id));
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
  const effective_budget = Math.min(profile.host_max_execution_instances || Number.MAX_SAFE_INTEGER, profile.profile_max_execution_instances || Number.MAX_SAFE_INTEGER);
  const narrowing_suggestions = projected > effective_budget ? ["reduce browser or viewport dimensions", "use fast/smoke explicitly", "increase the approved matrix budget"] : [];
  return { projected_execution_instances: projected, dimensions, batches, instances, effective_budget, narrowing_suggestions };
}

function cartesian(tier: Tier, browsers: string[], viewports: Viewport[], locales: string[], authScopes: string[]): Omit<ExecutionBatch, "batch_id" | "case_ids">[] { return browsers.flatMap((browser) => viewports.flatMap((viewport) => locales.flatMap((locale) => authScopes.map((auth_scope_id) => ({ tier, browser, viewport, locale, auth_scope_id }))))); }
function shortDigest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16); }
function batchOrder(a: ExecutionBatch, b: ExecutionBatch): number { return a.tier.localeCompare(b.tier) || a.browser.localeCompare(b.browser) || a.viewport.width - b.viewport.width || a.viewport.height - b.viewport.height || a.locale.localeCompare(b.locale) || a.auth_scope_id.localeCompare(b.auth_scope_id); }
function countBy(items: ExecutionInstance[], key: (item: ExecutionInstance) => string): Record<string, number> { return items.reduce<Record<string, number>>((counts, item) => { const value = key(item); counts[value] = (counts[value] || 0) + 1; return counts; }, {}); }
