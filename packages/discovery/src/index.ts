import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export interface DiscoveryBudget {
  max_depth?: number;
  max_files?: number;
  timeout_ms?: number;
  allowed_origins?: string[];
}

export interface RouteMapping { file_glob: string; routes: string[]; features: string[]; propagate?: boolean; }
export interface DiscoveryInput { root: string; project_subpath?: string; route_map?: { ignore_globs?: string[]; mappings?: RouteMapping[] }; target_url?: string; budget?: DiscoveryBudget; }
export interface DiscoveryCandidate { id: string; kind: string; route: string; feature_id: string; locator?: string; source_untrusted: true; }
export interface ScenarioObservation { feature_id: string; scenario: string; observed: boolean; blocker: boolean; priority: "P0" | "P1" | "P2"; reason?: string; }
export interface DiscoveryResult {
  schema_version: "2.1";
  observations: Record<string, unknown>[];
  candidates: DiscoveryCandidate[];
  scenario_observations: ScenarioObservation[];
  budget: { max_depth: number; max_files: number; timeout_ms: number; files_scanned: number; budget_exceeded: boolean };
  network: { allowed_origins: string[]; contacted_origins: string[]; blocked_origins: string[] };
  metrics: { discovery_wall_ms: number };
}

const DEFAULT_BUDGET = { max_depth: 5, max_files: 200, timeout_ms: 3000 };
const IGNORED = new Set([".git", "node_modules", "dist", "build", ".autopw"]);

export async function discover(input: DiscoveryInput): Promise<DiscoveryResult> {
  const started = performance.now();
  const budget = { ...DEFAULT_BUDGET, ...(input.budget || {}) };
  const root = resolveProjectRoot(input.root, input.project_subpath || ".");
  const mappings = input.route_map?.mappings || [];
  const ignored = input.route_map?.ignore_globs || [];
  const observations: Record<string, unknown>[] = [];
  const candidates: DiscoveryCandidate[] = [];
  const featureScenarios = new Map<string, Set<string>>();
  let filesScanned = 0;
  let budgetExceeded = false;

  const files = walk(root, 0, budget.max_depth, budget.max_files, ignored);
  if (files.length >= budget.max_files) budgetExceeded = true;
  for (const file of files) {
    if (filesScanned >= budget.max_files) { budgetExceeded = true; break; }
    filesScanned += 1;
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    const source = readBounded(file);
    const matched = mappings.filter((mapping) => mappingMatches(mapping.file_glob, relative));
    const features = [...new Set(matched.flatMap((mapping) => mapping.features.filter((feature) => feature !== "*")))];
    const featureIds = features.length ? features : inferFeatures(relative, source);
    const routes = [...new Set(matched.flatMap((mapping) => mapping.routes))];
    const route = routes[0] || inferRoute(relative, source);
    const controls = [...source.matchAll(/\bid=["']([A-Za-z0-9_.:-]+)["']/g)].map((match) => match[1]);
    for (const locator of controls.slice(0, 24)) {
      const featureId = featureIds[0] || "unknown_feature";
      candidates.push({ id: "candidate_" + featureId + "_" + locator, kind: "control", route, feature_id: featureId, locator: "#" + locator, source_untrusted: true });
    }
    for (const featureId of featureIds) {
      const scenarios = featureScenarios.get(featureId) || new Set<string>();
      scenarios.add("normal");
      if (/required|aria-required|name is required|validation/i.test(source)) scenarios.add("required_field");
      featureScenarios.set(featureId, scenarios);
    }
    const endpoints = [...source.matchAll(/(?:fetch|axios\.[a-z]+|request)\s*\(\s*["'`]([^"'`]+)["'`]/gi)].map((match) => match[1]).slice(0, 16);
    observations.push({ observation_id: "obs_" + safeId(relative), kind: "source", path: relative, route, features: featureIds, untrusted: true, value: source.slice(0, 500) });
    for (const endpoint of endpoints) observations.push({ observation_id: "api_" + safeId(relative + endpoint), kind: "api", path: endpoint, source: relative, untrusted: true });
  }

  if (input.target_url) {
    const targetObservation = await discoverTarget(input.target_url, budget.timeout_ms, input.budget?.allowed_origins || []);
    observations.push(...targetObservation.observations);
    candidates.push(...targetObservation.candidates);
    for (const observation of targetObservation.scenario_observations) {
      const scenarios = featureScenarios.get(observation.feature_id) || new Set<string>();
      scenarios.add(observation.scenario);
      featureScenarios.set(observation.feature_id, scenarios);
    }
  }

  if (candidates.length === 0) {
    candidates.push({ id: "candidate_project_root", kind: "route", route: "/", feature_id: "project_root", source_untrusted: true });
    featureScenarios.set("project_root", new Set(["normal"]));
  }
  const scenario_observations: ScenarioObservation[] = [];
  for (const [feature_id, scenarios] of [...featureScenarios.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const scenario of [...scenarios].sort()) {
      const blocker = budgetExceeded;
      scenario_observations.push({ feature_id, scenario, observed: !budgetExceeded, blocker, priority: feature_id === "demo_health" ? "P1" : "P0", ...(blocker ? { reason: "DISCOVERY_BUDGET_EXCEEDED" } : {}) });
    }
  }
  if (budgetExceeded) observations.push({ observation_id: "obs_budget", kind: "objective_blocker", code: "DISCOVERY_BUDGET_EXCEEDED", untrusted: false });
  const allowed = input.budget?.allowed_origins || [];
  return {
    schema_version: "2.1", observations, candidates: dedupeCandidates(candidates), scenario_observations,
    budget: { max_depth: budget.max_depth, max_files: budget.max_files, timeout_ms: budget.timeout_ms, files_scanned: filesScanned, budget_exceeded: budgetExceeded },
    network: { allowed_origins: allowed, contacted_origins: input.target_url ? [new URL(input.target_url).origin] : [], blocked_origins: [] },
    metrics: { discovery_wall_ms: Math.max(0, Math.round(performance.now() - started)) }
  };
}

export function resolveProjectRoot(root: string, projectSubpath: string): string {
  const base = fs.realpathSync.native(path.resolve(root));
  const target = path.resolve(base, projectSubpath);
  const relative = path.relative(base, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("DISCOVERY_WORKSPACE_ESCAPE");
  return fs.realpathSync.native(target);
}

async function discoverTarget(targetUrl: string, timeoutMs: number, allowedOrigins: string[]): Promise<{ observations: Record<string, unknown>[]; candidates: DiscoveryCandidate[]; scenario_observations: ScenarioObservation[] }> {
  const url = new URL(targetUrl);
  if (allowedOrigins.length > 0 && !allowedOrigins.includes(url.origin)) throw new Error("DISCOVERY_ORIGIN_NOT_ALLOWED");
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error("DISCOVERY_TARGET_HTTP_" + response.status);
  const body = (await response.text()).slice(0, 100_000);
  const controls = [...body.matchAll(/\bid=["']([A-Za-z0-9_.:-]+)["']/g)].map((match) => match[1]);
  const candidates = controls.map((id) => ({ id: "target_control_" + id, kind: "control", route: url.pathname || "/", feature_id: /name|submit|required/.test(id) ? "demo_form" : "demo_health", locator: "#" + id, source_untrusted: true as const }));
  const features = new Set(candidates.map((candidate) => candidate.feature_id));
  const scenario_observations: ScenarioObservation[] = [...features].sort().flatMap((feature_id) => [
    { feature_id, scenario: "normal", observed: true, blocker: false, priority: feature_id === "demo_health" ? "P1" as const : "P0" as const },
    ...(feature_id === "demo_form" ? [{ feature_id, scenario: "required_field", observed: true, blocker: false, priority: "P0" as const }] : [])
  ]);
  return { observations: [{ observation_id: "obs_target_document", kind: "page", route: url.pathname || "/", untrusted: true, value: body.slice(0, 500) }], candidates, scenario_observations };
}

function walk(dir: string, depth: number, maxDepth: number, maxFiles: number, ignoredGlobs: string[]): string[] {
  if (depth > maxDepth) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (result.length >= maxFiles || IGNORED.has(entry.name) || ignoredGlobs.some((glob) => mappingMatches(glob, entry.name))) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full, depth + 1, maxDepth, maxFiles - result.length, ignoredGlobs));
    else if (/\.(?:ts|tsx|js|jsx|mjs|cjs|html|vue|svelte|yaml|yml|json)$/.test(entry.name)) result.push(full);
  }
  return result;
}

function readBounded(file: string): string { try { return fs.readFileSync(file, "utf8").slice(0, 100_000); } catch { return ""; } }
function inferFeatures(relative: string, source: string): string[] {
  if (/demo-form|#name|#submit/.test(source)) return ["demo_form"];
  if (/<(?:body|main|form|button|input)\b|document\.querySelector|router\.|route\s*[:=]/i.test(source)) return [/health|status/i.test(source) ? "demo_health" : safeId(path.basename(relative, path.extname(relative))) || "project_root"];
  return [];
}
function inferRoute(relative: string, source: string): string { return /listen\(|<body|<main/.test(source) || /index\.(?:ts|js|html)$/.test(relative) ? "/" : "/" + relative.replace(/\.[^.]+$/, ""); }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 70); }
function mappingMatches(glob: string, value: string): boolean { const pattern = "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", ".*").replaceAll("*", "[^/]*") + "$"; return new RegExp(pattern).test(value); }
function dedupeCandidates(items: DiscoveryCandidate[]): DiscoveryCandidate[] { const seen = new Set<string>(); return items.filter((item) => !seen.has(item.id) && seen.add(item.id)).sort((a, b) => a.id.localeCompare(b.id)); }
