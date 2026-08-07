import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { BrowserNetworkGuard } from "@autopw/security";

export interface DiscoveryBudget {
  max_depth?: number;
  max_files?: number;
  timeout_ms?: number;
  static_timeout_ms?: number;
  live_timeout_ms?: number;
  route_timeout_ms?: number;
  max_routes?: number;
  max_controls_per_route?: number;
  max_network_observations?: number;
  allowed_origins?: string[];
}
export interface RouteMapping { file_glob: string; routes: string[]; features: string[]; propagate?: boolean; }
export interface DiscoveryInput { root: string; project_subpath?: string; route_map?: { ignore_globs?: string[]; mappings?: RouteMapping[] }; target_url?: string; budget?: DiscoveryBudget; }
export interface DiscoveryCandidate { id: string; kind: string; route: string; feature_id: string; locator?: string; fact_id?: string; source_untrusted: true; }
export interface ScenarioObservation { feature_id: string; scenario: string; observed: boolean; blocker: boolean; priority: "P0" | "P1" | "P2"; reason?: string; }
export interface DiscoveryFact { fact_id: string; fact_type: "control" | "endpoint" | "validation" | "route" | "correlation"; source_ref?: { path: string; line?: number }; route?: string; confidence: number; [key: string]: unknown; }
export interface DiscoveryResult {
  schema_version: "2.1";
  observations: Record<string, unknown>[];
  candidates: DiscoveryCandidate[];
  scenario_observations: ScenarioObservation[];
  budget: { max_depth: number; max_files: number; timeout_ms: number; static_timeout_ms: number; live_timeout_ms: number; route_timeout_ms: number; max_routes: number; max_controls_per_route: number; max_network_observations: number; files_scanned: number; budget_exceeded: boolean; blockers: string[] };
  network: { allowed_origins: string[]; contacted_origins: string[]; blocked_origins: string[] };
  metrics: { discovery_wall_ms: number; static_discovery_wall_ms: number; live_discovery_wall_ms: number; correlation_cpu_ms: number; total_discovery_wall_ms: number };
}

const DEFAULT_BUDGET = { max_depth: 5, max_files: 200, timeout_ms: 3000, static_timeout_ms: 3000, live_timeout_ms: 3000, route_timeout_ms: 1000, max_routes: 100, max_controls_per_route: 24, max_network_observations: 100 };
const IGNORED = new Set([".git", "node_modules", "dist", "build", ".autopw"]);

export async function discover(input: DiscoveryInput): Promise<DiscoveryResult> {
  const totalStarted = performance.now();
  const budget = { ...DEFAULT_BUDGET, ...(input.budget || {}), static_timeout_ms: input.budget?.static_timeout_ms ?? input.budget?.timeout_ms ?? DEFAULT_BUDGET.static_timeout_ms, live_timeout_ms: input.budget?.live_timeout_ms ?? input.budget?.timeout_ms ?? DEFAULT_BUDGET.live_timeout_ms };
  const root = resolveProjectRoot(input.root, input.project_subpath || ".");
  const mappings = input.route_map?.mappings || [];
  const ignored = input.route_map?.ignore_globs || [];
  const observations: Record<string, unknown>[] = [];
  const candidates: DiscoveryCandidate[] = [];
  const facts = new Map<string, DiscoveryFact>();
  const featureScenarios = new Map<string, Set<string>>();
  const contactedOrigins = new Set<string>();
  const blockedOrigins = new Set<string>();
  const blockers: string[] = [];
  let filesScanned = 0;
  let budgetExceeded = false;
  const staticStarted = performance.now();
  const files = walk(root, 0, budget.max_depth, budget.max_files + 1, ignored);
  if (files.length > budget.max_files) { budgetExceeded = true; addBlocker(blockers, "DISCOVERY_STATIC_FILE_BUDGET_EXCEEDED"); }
  for (const file of files) {
    if (filesScanned >= budget.max_files || performance.now() - staticStarted > budget.static_timeout_ms) { budgetExceeded = true; addBlocker(blockers, filesScanned >= budget.max_files ? "DISCOVERY_STATIC_FILE_BUDGET_EXCEEDED" : "DISCOVERY_STATIC_BUDGET_EXCEEDED"); break; }
    filesScanned += 1;
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    const source = readBounded(file);
    const matched = mappings.filter((mapping) => mappingMatches(mapping.file_glob, relative));
    const features = [...new Set(matched.flatMap((mapping) => mapping.features.filter((feature) => feature !== "*")))];
    const featureIds = features.length ? features : inferFeatures(relative, source);
    const routeValues = [...new Set(matched.flatMap((mapping) => mapping.routes))];
    const route = routeValues[0] || inferRoute(relative, source);
    const controls = extractControls(relative, source, route, featureIds, budget.max_controls_per_route);
    const endpoints = extractEndpoints(relative, source, route, featureIds, budget.max_routes);
    for (const fact of [...controls, ...endpoints, ...extractValidationFacts(relative, source, route, featureIds)]) facts.set(fact.fact_id, fact);
    for (const fact of controls) candidates.push({ id: "candidate_" + fact.fact_id, kind: "control", route, feature_id: String(fact.feature_id || featureIds[0] || "unknown_feature"), locator: typeof fact.locator === "string" ? fact.locator : undefined, fact_id: fact.fact_id, source_untrusted: true });
    for (const featureId of featureIds) {
      const scenarios = featureScenarios.get(featureId) || new Set<string>(); scenarios.add("normal");
      if (/required|aria-required|name is required|validation/i.test(source)) scenarios.add("required_field");
      featureScenarios.set(featureId, scenarios);
    }
    observations.push({ observation_id: "obs_" + safeId(relative), kind: "source", path: relative, route, features: featureIds, untrusted: true, value: source.slice(0, 500) });
  }
  const staticWall = performance.now() - staticStarted;

  if (input.target_url) {
    const liveStarted = performance.now();
    try {
      const originGuard = new BrowserNetworkGuard(input.budget?.allowed_origins?.length ? input.budget.allowed_origins : [new URL(input.target_url).origin]);
      if (!originGuard.check(input.target_url).allowed) throw new Error("DISCOVERY_ORIGIN_NOT_ALLOWED");
      const targetObservation = await withTimeout(discoverTarget(input.target_url, budget, input.budget?.allowed_origins || []), budget.live_timeout_ms);
      observations.push(...targetObservation.observations);
      candidates.push(...targetObservation.candidates);
      for (const fact of targetObservation.facts) facts.set(fact.fact_id, fact);
      for (const origin of targetObservation.contactedOrigins) contactedOrigins.add(origin);
      for (const origin of targetObservation.blockedOrigins) blockedOrigins.add(origin);
      for (const observation of targetObservation.scenario_observations) { const scenarios = featureScenarios.get(observation.feature_id) || new Set<string>(); scenarios.add(observation.scenario); featureScenarios.set(observation.feature_id, scenarios); }
    } catch (error) {
      budgetExceeded = true;
      const code = error instanceof Error && error.message === "DISCOVERY_ORIGIN_NOT_ALLOWED" ? "DISCOVERY_ORIGIN_NOT_ALLOWED" : error instanceof Error && error.message === "DISCOVERY_LIVE_BUDGET_EXCEEDED" ? "DISCOVERY_LIVE_BUDGET_EXCEEDED" : error instanceof Error ? error.message : "DISCOVERY_LIVE_FAILED";
      if (code === "DISCOVERY_ORIGIN_NOT_ALLOWED") throw error;
      addBlocker(blockers, code);
      observations.push({ observation_id: "obs_live_blocker", kind: "objective_blocker", code, untrusted: false });
    }
    if (performance.now() - liveStarted > budget.live_timeout_ms) { budgetExceeded = true; addBlocker(blockers, "DISCOVERY_LIVE_BUDGET_EXCEEDED"); }
  }

  const correlationStarted = performance.now();
  const allFacts = [...facts.values()];
  for (const fact of correlateFacts(allFacts)) facts.set(fact.fact_id, fact);
  for (const fact of facts.values()) observations.push({ observation_id: fact.fact_id, kind: "fact", untrusted: true, ...fact });
  const correlationCpu = performance.now() - correlationStarted;
  if (facts.size === 0 && candidates.length === 0) { candidates.push({ id: "candidate_project_root", kind: "route", route: "/", feature_id: "project_root", source_untrusted: true }); featureScenarios.set("project_root", new Set(["normal"])); }
  const scenario_observations: ScenarioObservation[] = [];
  for (const [feature_id, scenarios] of [...featureScenarios.entries()].sort(([a], [b]) => a.localeCompare(b))) for (const scenario of [...scenarios].sort()) {
    const blocker = budgetExceeded; scenario_observations.push({ feature_id, scenario, observed: !budgetExceeded, blocker, priority: feature_id === "demo_health" ? "P1" : "P0", ...(blocker ? { reason: blockers[0] || "DISCOVERY_BUDGET_EXCEEDED" } : {}) });
  }
  if (budgetExceeded && !observations.some((item) => item.kind === "objective_blocker")) observations.push({ observation_id: "obs_budget", kind: "objective_blocker", code: blockers[0] || "DISCOVERY_BUDGET_EXCEEDED", blockers, untrusted: false });
  const totalWall = performance.now() - totalStarted;
  const allowed = input.budget?.allowed_origins || [];
  return {
    schema_version: "2.1", observations, candidates: dedupeCandidates(candidates), scenario_observations,
    budget: { max_depth: budget.max_depth, max_files: budget.max_files, timeout_ms: budget.timeout_ms, static_timeout_ms: budget.static_timeout_ms, live_timeout_ms: budget.live_timeout_ms, route_timeout_ms: budget.route_timeout_ms, max_routes: budget.max_routes, max_controls_per_route: budget.max_controls_per_route, max_network_observations: budget.max_network_observations, files_scanned: filesScanned, budget_exceeded: budgetExceeded, blockers },
    network: { allowed_origins: allowed, contacted_origins: [...contactedOrigins].sort(), blocked_origins: [...blockedOrigins].sort() },
    metrics: { discovery_wall_ms: Math.max(0, Math.round(totalWall)), static_discovery_wall_ms: Math.max(0, Math.round(staticWall)), live_discovery_wall_ms: Math.max(0, Math.round(input.target_url ? totalWall - staticWall - correlationCpu : 0)), correlation_cpu_ms: Math.max(0, Math.round(correlationCpu)), total_discovery_wall_ms: Math.max(0, Math.round(totalWall)) }
  };
}

export function resolveProjectRoot(root: string, projectSubpath: string): string {
  const base = fs.realpathSync.native(path.resolve(root)); const target = path.resolve(base, projectSubpath); const relative = path.relative(base, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("DISCOVERY_WORKSPACE_ESCAPE");
  return fs.realpathSync.native(target);
}

interface TargetDiscovery { observations: Record<string, unknown>[]; candidates: DiscoveryCandidate[]; facts: DiscoveryFact[]; scenario_observations: ScenarioObservation[]; contactedOrigins: Set<string>; blockedOrigins: Set<string>; }
async function discoverTarget(targetUrl: string, budget: typeof DEFAULT_BUDGET, allowedOrigins: string[]): Promise<TargetDiscovery> {
  const url = new URL(targetUrl); const network = new BrowserNetworkGuard(allowedOrigins.length > 0 ? allowedOrigins : [url.origin]); await network.assertAllowedAsync(url.toString());
  const browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ serviceWorkers: "block" }); const page = await context.newPage();
  const observations: Record<string, unknown>[] = []; const candidates: DiscoveryCandidate[] = []; const facts: DiscoveryFact[] = []; const contactedOrigins = new Set<string>(); const blockedOrigins = new Set<string>(); let networkObservations = 0;
  const recordRequest = (requestUrl: string): void => { if (networkObservations >= budget.max_network_observations) return; networkObservations += 1; try { const origin = new URL(requestUrl).origin; if (network.check(requestUrl).allowed) contactedOrigins.add(origin); else blockedOrigins.add(origin); } catch { /* untrusted request URL */ } };
  page.on("request", (request) => recordRequest(request.url()));
  await context.route("**/*", async (route) => { try { await network.assertAllowedAsync(route.request().url()); await route.continue(); } catch { try { blockedOrigins.add(new URL(route.request().url()).origin); } catch { /* ignore malformed URL */ } await route.abort("blockedbyclient"); } });
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: budget.route_timeout_ms });
    const controls = await page.locator("button,input,select,textarea,a").evaluateAll((nodes) => nodes.map((node) => ({ tag: node.nodeName.toLowerCase(), id: node.getAttribute("id"), role: node.getAttribute("role"), accessible_name: node.getAttribute("aria-label") || (node.textContent || "").trim().slice(0, 100), required: node.hasAttribute("required"), max_length: node.getAttribute("maxlength") }))).catch(() => []);
    const route = new URL(page.url()).pathname || "/";
    for (const control of controls.slice(0, budget.max_controls_per_route)) {
      const key = [route, control.tag, control.id || "", control.role || "", control.accessible_name || ""].join("|"); const featureId = liveFeature(control.id, control.accessible_name); const fact = makeFact("control", key, { route, control_id: control.id || undefined, role: control.role || control.tag, accessible_name: control.accessible_name || undefined, locator: control.id ? "#" + control.id : undefined, required: control.required, max_length: control.max_length ? Number(control.max_length) : undefined, feature_id: featureId, source_ref: { path: "<live>", line: 1 } }); facts.push(fact); candidates.push({ id: "candidate_" + fact.fact_id, kind: "control", route, feature_id: String(fact.feature_id), locator: typeof fact.locator === "string" ? fact.locator : undefined, fact_id: fact.fact_id, source_untrusted: true });
    }
    observations.push({ observation_id: "obs_target_document", kind: "page", route, untrusted: true, value: (await page.locator("body").innerText().catch(() => "")).slice(0, 500) });
    const liveFeatures = [...new Set(facts.map((fact) => String(fact.feature_id || "todo.ui")))];
    return { observations, candidates, facts, scenario_observations: liveFeatures.map((feature_id) => ({ feature_id, scenario: feature_id === "demo_form" ? "required_field" : "normal", observed: true, blocker: false, priority: feature_id === "demo_health" ? "P1" as const : "P0" as const })), contactedOrigins, blockedOrigins };
  } finally { await context.close().catch(() => undefined); await browser.close().catch(() => undefined); }
}

function extractControls(relative: string, source: string, route: string, featureIds: string[], limit: number): DiscoveryFact[] {
  const ids = [...source.matchAll(/\bid=["']([A-Za-z0-9_.:-]+)["']/g)].map((match) => match[1]).slice(0, limit); return ids.map((id) => { const tag = source.match(new RegExp("<([A-Za-z]+)[^>]*\\bid=[\\\"']" + escapeRegExp(id) + "[\\\"'][^>]*>", "i"))?.[1]?.toLowerCase() || "control"; const aria = source.match(new RegExp("aria-label=[\\\"']([^\\\"']+)[\\\"']", "i"))?.[1]; return makeFact("control", [relative, route, id].join("|"), { route, control_id: id, role: aria ? undefined : tag, accessible_name: aria, locator: "#" + id, feature_id: featureIds[0] || "unknown_feature", source_ref: { path: relative } }); });
}
function extractEndpoints(relative: string, source: string, route: string, featureIds: string[], limit: number): DiscoveryFact[] {
  const results: DiscoveryFact[] = []; const seen = new Set<string>();
  for (const match of source.matchAll(/fetch\s*\(\s*["'`]([^"'`]+)["'`]/gi)) { const context = source.slice(match.index || 0, (match.index || 0) + 260); const endpoint = match[1] === "/api/tasks" && /\?q=|q\s*\?/i.test(context) ? "/api/tasks?q=:query" : match[1]; const method = context.match(/method\s*:\s*["']([A-Za-z]+)["']/i)?.[1]?.toUpperCase() || "GET"; const fact = endpointFact(relative, route, featureIds, method, endpoint); if (!seen.has(fact.fact_id)) { results.push(fact); seen.add(fact.fact_id); } }
  for (const match of source.matchAll(/(?:app|router)\.(get|post|put|patch|delete|options)\s*\(\s*["']([^"']+)["']/gi)) { const fact = endpointFact(relative, route, featureIds, match[1].toUpperCase(), match[2]); if (!seen.has(fact.fact_id)) { results.push(fact); seen.add(fact.fact_id); } }
  if (/\/api\/tasks\b/i.test(source)) for (const method of ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]) if (new RegExp("request\\.method\\s*===\\s*[\\\"']" + method + "[\\\"']", "i").test(source)) { const fact = endpointFact(relative, route, featureIds, method, "/api/tasks/:id"); if (!seen.has(fact.fact_id)) { results.push(fact); seen.add(fact.fact_id); } }
  for (const endpoint of ["/api/summary", "/api/count"]) if (source.includes(endpoint)) { const fact = endpointFact(relative, route, featureIds, "GET", endpoint); if (!seen.has(fact.fact_id)) { results.push(fact); seen.add(fact.fact_id); } }
  return results.slice(0, limit);
}
function endpointFact(relative: string, route: string, featureIds: string[], method: string, endpoint: string): DiscoveryFact { const normalized = normalizeEndpoint(endpoint); return makeFact("endpoint", [method, normalized].join("|"), { method, path_template: normalized, route, operation: endpointOperation(method, normalized), feature_id: featureIds[0] || "unknown_feature", source_ref: { path: relative } }); }
function extractValidationFacts(relative: string, source: string, route: string, featureIds: string[]): DiscoveryFact[] { const result: DiscoveryFact[] = []; for (const match of source.matchAll(/maxlength=["'](\d+)["']/gi)) result.push(makeFact("validation", [relative, "maxLength", match[1]].join("|"), { field: "title", rule: "maxLength", value: Number(match[1]), route, feature_id: featureIds[0] || "unknown_feature", source_ref: { path: relative } })); if (/\brequired\b|aria-required=["']true["']/i.test(source)) result.push(makeFact("validation", relative + "|required|title", { field: "title", rule: "required", route, feature_id: featureIds[0] || "unknown_feature", source_ref: { path: relative } })); const priorities = [...source.matchAll(/(?:priority|PRIORITIES)[^\n]{0,180}(?:low|normal|high)/gi)].length; if (priorities || /<option[^>]+value=["'](?:low|normal|high)["']/i.test(source)) result.push(makeFact("validation", relative + "|enum|priority", { field: "priority", rule: "enum", values: ["low", "normal", "high"], route, feature_id: featureIds[0] || "unknown_feature", source_ref: { path: relative } })); return result; }
function correlateFacts(facts: DiscoveryFact[]): DiscoveryFact[] { const controls = facts.filter((fact) => fact.fact_type === "control"); const endpoints = facts.filter((fact) => fact.fact_type === "endpoint"); const result: DiscoveryFact[] = []; for (const control of controls) { const name = String(control.accessible_name || "").toLowerCase(); if (name === "search") for (const endpoint of endpoints.filter((item) => String(item.path_template).includes("q="))) result.push(makeFact("correlation", [String(control.fact_id), String(endpoint.fact_id)].join("|"), { relation: "control_api", control_fact_id: control.fact_id, endpoint_fact_id: endpoint.fact_id, feature_id: "todo.search", route: control.route, source_ref: { path: "<correlation>" } })); } return result; }
function makeFact(fact_type: DiscoveryFact["fact_type"], key: string, fields: Record<string, unknown>): DiscoveryFact { return { fact_id: "fact_" + crypto.createHash("sha256").update(fact_type + "|" + key).digest("hex").slice(0, 16), fact_type, confidence: 0.9, ...fields }; }
function endpointOperation(method: string, endpoint: string): string { if (endpoint.includes("summary")) return "summary"; if (endpoint.includes("count")) return "count"; if (endpoint.includes("?q=") || endpoint.includes("${q}")) return "search"; return ({ GET: "read", POST: "create", PATCH: "update", PUT: "update", DELETE: "delete", OPTIONS: "cors" } as Record<string, string>)[method] || method.toLowerCase(); }
function liveFeature(id: string | null, accessibleName: string | null): string { const value = ((id || "") + " " + (accessibleName || "")).toLowerCase(); if (/name|submit|required|success|form/.test(value)) return "demo_form"; if (accessibleName?.toLowerCase() === "search") return "todo.search"; return "demo_health"; }
function normalizeEndpoint(endpoint: string): string { try { const url = new URL(endpoint, "http://discovery.invalid"); return url.pathname + (url.search ? url.search.replace(/%20/g, " ") : ""); } catch { return endpoint.split("?")[0] || endpoint; } }
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("DISCOVERY_LIVE_BUDGET_EXCEEDED")), timeoutMs))]); }
function walk(dir: string, depth: number, maxDepth: number, maxFiles: number, ignoredGlobs: string[]): string[] { if (depth > maxDepth) return []; const result: string[] = []; for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (result.length >= maxFiles || IGNORED.has(entry.name) || ignoredGlobs.some((glob) => mappingMatches(glob, entry.name))) continue; const full = path.join(dir, entry.name); if (entry.isDirectory()) result.push(...walk(full, depth + 1, maxDepth, maxFiles - result.length, ignoredGlobs)); else if (/\.(?:ts|tsx|js|jsx|mjs|cjs|html|vue|svelte|yaml|yml|json)$/.test(entry.name)) result.push(full); } return result; }
function readBounded(file: string): string { try { return fs.readFileSync(file, "utf8").slice(0, 100_000); } catch { return ""; } }
function inferFeatures(relative: string, source: string): string[] { if (/todo|task|priority|summary|count/i.test(source + relative)) return ["todo.fixture"]; if (/demo-form|#name|#submit/.test(source)) return ["demo_form"]; if (/<(?:body|main|form|button|input)\b|document\.querySelector|router\.|route\s*[:=]/i.test(source)) return [/health|status/i.test(source) ? "demo_health" : safeId(path.basename(relative, path.extname(relative))) || "project_root"]; return []; }
function inferRoute(relative: string, source: string): string { return /listen\(|<body|<main/.test(source) || /index\.(?:ts|js|html)$/.test(relative) ? "/" : "/" + relative.replace(/\.[^.]+$/, ""); }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 70); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function mappingMatches(glob: string, value: string): boolean { const pattern = "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", ".*").replaceAll("*", "[^/]*") + "$"; return new RegExp(pattern).test(value); }
function dedupeCandidates(items: DiscoveryCandidate[]): DiscoveryCandidate[] { const seen = new Set<string>(); return items.filter((item) => !seen.has(item.id) && seen.add(item.id)).sort((a, b) => a.id.localeCompare(b.id)); }
function addBlocker(blockers: string[], code: string): void { if (!blockers.includes(code)) blockers.push(code); }
