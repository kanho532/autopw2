import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { chromium, type Page } from "playwright";
import { BrowserNetworkGuard } from "@autopw/security";
import type { DiscoveryCandidate, DiscoveryFact, ScenarioObservation } from "./index.js";

export interface LiveExplorationBudget { max_depth: number; route_timeout_ms: number; max_routes: number; max_controls_per_route: number; max_network_observations: number; max_interactions_per_route: number; }
export interface LiveExplorationPolicy { trusted?: boolean; allow_mutating_interactions?: boolean; isolated_fixture_strategy?: boolean; }
export interface LiveExplorationResult { observations: Record<string, unknown>[]; candidates: DiscoveryCandidate[]; facts: DiscoveryFact[]; scenario_observations: ScenarioObservation[]; contactedOrigins: Set<string>; blockedOrigins: Set<string>; }
interface Closable { close(): Promise<void>; }
interface LiveResources { browser?: Closable; context?: Closable; page?: Closable; }
interface ControlSnapshot { index: number; tag: string; id?: string; role?: string; name?: string; href?: string; type?: string; disabled: boolean; }
interface StructureSnapshot { semantic: string; selector: string; nth?: number; scope_selector?: string; }

export async function exploreLiveTarget({ targetUrl, budget, allowedOrigins, discoveredRoutes, deadline, signal, policy = {}, registerResources }: { targetUrl: string; budget: LiveExplorationBudget; allowedOrigins: string[]; discoveredRoutes: Set<string>; deadline: number; signal: AbortSignal; policy?: LiveExplorationPolicy; registerResources(resources: LiveResources): void }): Promise<LiveExplorationResult> {
  assertBudget(signal, deadline);
  const target = new URL(targetUrl);
  const network = new BrowserNetworkGuard(allowedOrigins.length ? allowedOrigins : [target.origin]);
  await network.assertAllowedAsync(target.toString());
  const browser = await chromium.launch({ headless: true, timeout: remaining(deadline) }); registerResources({ browser });
  const context = await browser.newContext({ serviceWorkers: "block" }); registerResources({ browser, context });
  const page = await context.newPage(); registerResources({ browser, context, page });
  const observations: Record<string, unknown>[] = [];
  const candidates: DiscoveryCandidate[] = [];
  const facts: DiscoveryFact[] = [];
  const contactedOrigins = new Set<string>();
  const blockedOrigins = new Set<string>();
  const stateKeys = new Set<string>();
  const routeKeys = new Set<string>();
  const mutationEnabled = Boolean(policy.trusted && policy.allow_mutating_interactions && policy.isolated_fixture_strategy);
  const queue: Array<{ url: string; depth: number; via?: string }> = [{ url: target.toString(), depth: 0 }];
  let networkCount = 0;
  let activeInteraction = "";
  const endpointsByInteraction = new Map<string, string[]>();

  page.on("request", (request) => {
    if (networkCount >= budget.max_network_observations) return;
    const resourceType = request.resourceType();
    if (!["document", "fetch", "xhr"].includes(resourceType)) return;
    networkCount += 1;
    try {
      const url = new URL(request.url());
      if (!network.check(request.url()).allowed) { blockedOrigins.add(url.origin); return; }
      contactedOrigins.add(url.origin);
      const endpointFact = fact("endpoint", ["runtime", request.method(), url.pathname + url.search, activeInteraction].join("|"), { method: request.method(), path_template: url.pathname + url.search, route: url.pathname, operation: operation(request.method(), url.pathname + url.search), feature_id: feature(null, url.pathname), adapter: "runtime-network", source_kind: "RUNTIME", confidence: 0.96, ...(activeInteraction ? { interaction_fact_id: activeInteraction } : {}), source_ref: { path: "<live-network>" } });
      facts.push(endpointFact);
      if (activeInteraction) endpointsByInteraction.set(activeInteraction, [...(endpointsByInteraction.get(activeInteraction) || []), endpointFact.fact_id]);
    } catch { /* ignore malformed network URL */ }
  });
  page.on("response", (response) => {
    if (networkCount >= budget.max_network_observations || !["document", "fetch", "xhr"].includes(response.request().resourceType())) return;
    try {
      const url = new URL(response.url());
      if (!network.check(response.url()).allowed) return;
      facts.push(fact("runtime_response", [response.request().method(), url.pathname + url.search, response.status(), activeInteraction].join("|"), { method: response.request().method(), path_template: url.pathname + url.search, status: response.status(), feature_id: feature(null, url.pathname), source_kind: "RUNTIME", confidence: 0.98, ...(activeInteraction ? { interaction_fact_id: activeInteraction } : {}), source_ref: { path: "<live-network>" } }));
    } catch { /* ignore malformed response URL */ }
  });
  await context.route("**/*", async (route) => { try { assertBudget(signal, deadline); await network.assertAllowedAsync(route.request().url()); if (["POST", "PUT", "PATCH", "DELETE"].includes(route.request().method()) && !mutationEnabled) { await route.abort("blockedbyclient"); return; } await route.continue(); } catch { try { blockedOrigins.add(new URL(route.request().url()).origin); } catch { /* ignore */ } await route.abort("blockedbyclient").catch(() => undefined); } });

  try {
    while (queue.length && routeKeys.size < budget.max_routes) {
      assertBudget(signal, deadline);
      const current = queue.shift() as { url: string; depth: number; via?: string };
      if (current.depth > budget.max_depth) continue;
      const normalized = routeUrl(current.url);
      if (routeKeys.has(normalized)) continue;
      const pageRouteKey = "PAGE|" + normalized;
      if (!discoveredRoutes.has(pageRouteKey) && discoveredRoutes.size >= budget.max_routes) break;
      routeKeys.add(normalized);
      discoveredRoutes.add(pageRouteKey);
      activeInteraction = current.via || "";
      await page.goto(current.url, { waitUntil: "domcontentloaded", timeout: Math.min(budget.route_timeout_ms, remaining(deadline)) });
      await settle(page, deadline);
      activeInteraction = "";
      const route = routeUrl(page.url());
      const before = await fingerprint(page, route);
      if (stateKeys.has(before.key)) continue;
      stateKeys.add(before.key);
      facts.push(fact("route", [route, before.hash].join("|"), { route, path_template: route, dom_fingerprint: before.hash, source_kind: "DOM", confidence: 0.98, source_ref: { path: "<live>" } }));
      observations.push({ observation_id: "obs_live_" + before.hash.slice(0, 12), kind: "page", route, dom_fingerprint: before.hash, depth: current.depth, untrusted: true, value: before.text.slice(0, 500) });
      const controls = await snapshots(page, budget.max_controls_per_route);
      const controlFacts = new Map<number, DiscoveryFact>();
      for (const control of controls) {
        const mutating = isMutating(control);
        const allowed = !mutating || mutationEnabled;
        const controlFact = fact("control", [route, control.tag, control.id || "", control.role || "", control.name || "", control.index].join("|"), { route, control_id: control.id, role: control.role || control.tag, accessible_name: control.name, locator: control.id ? "#" + control.id : undefined, interaction_kind: interactionKind(control), mutating, exploration_allowed: allowed, feature_id: feature(control.id || null, control.name || null), source_kind: "DOM", confidence: 0.98, source_ref: { path: "<live>", line: 1 } });
        facts.push(controlFact); controlFacts.set(control.index, controlFact);
        candidates.push({ id: "candidate_" + controlFact.fact_id, kind: "control", route, feature_id: String(controlFact.feature_id), locator: typeof controlFact.locator === "string" ? controlFact.locator : undefined, fact_id: controlFact.fact_id, source_untrusted: true });
      }
      for (const structure of await structureSnapshots(page)) facts.push(fact("ui_structure", [route, structure.semantic, structure.selector, structure.nth ?? "", structure.scope_selector || ""].join("|"), { route, feature_id: "live.ui", semantic: structure.semantic, selector: structure.selector, ...(structure.nth !== undefined ? { nth: structure.nth } : {}), ...(structure.scope_selector ? { scope_selector: structure.scope_selector } : {}), source_kind: "DOM", confidence: 0.96, source_ref: { path: "<live>", line: 1 } }));
      let interactions = 0;
      for (const control of controls) {
        if (interactions >= budget.max_interactions_per_route || control.disabled) break;
        const mutating = isMutating(control);
        const allowed = !mutating || mutationEnabled;
        if (!allowed || !isInteractive(control)) continue;
        interactions += 1;
        await page.goto(current.url, { waitUntil: "domcontentloaded", timeout: Math.min(budget.route_timeout_ms, remaining(deadline)) });
        await settle(page, deadline);
        const pre = await fingerprint(page, routeUrl(page.url()));
        const controlFact = controlFacts.get(control.index);
        const interaction = fact("interaction", [route, controlFact?.fact_id || control.index, pre.hash].join("|"), { route, control_fact_id: controlFact?.fact_id, interaction_kind: interactionKind(control), mutating, policy: mutating ? "trusted_isolated" : "read_only", before_state: pre.hash, source_kind: "DOM", confidence: 0.97, source_ref: { path: "<live-interaction>" } });
        facts.push(interaction); activeInteraction = interaction.fact_id;
        try { await page.locator("button,input,select,textarea,a").nth(control.index).click({ timeout: Math.min(500, remaining(deadline)) }); await settle(page, deadline); } catch { activeInteraction = ""; continue; }
        activeInteraction = "";
        const postRoute = routeUrl(page.url());
        const post = await fingerprint(page, postRoute);
        facts.push(fact("ui_mutation", [interaction.fact_id, post.hash].join("|"), { route: postRoute, interaction_fact_id: interaction.fact_id, changed: pre.hash !== post.hash, before_state: pre.hash, after_state: post.hash, source_kind: "DOM", confidence: 0.97, source_ref: { path: "<live-interaction>" } }));
        for (const endpointFactId of endpointsByInteraction.get(interaction.fact_id) || []) facts.push(fact("correlation", [controlFact?.fact_id || "", endpointFactId, interaction.fact_id].join("|"), { relation: "control_api", control_fact_id: controlFact?.fact_id, endpoint_fact_id: endpointFactId, interaction_fact_id: interaction.fact_id, route, source_kind: "INFERRED", confidence: 0.96, source_ref: { path: "<live-correlation>" } }));
        if (postRoute !== route && current.depth < budget.max_depth && !routeKeys.has(postRoute)) queue.push({ url: new URL(page.url()).toString(), depth: current.depth + 1, via: interaction.fact_id });
      }
      for (const control of controls.filter((item) => item.tag === "a" && item.href)) {
        try { const next = new URL(control.href as string, page.url()); if (network.check(next.toString()).allowed && current.depth < budget.max_depth && !routeKeys.has(routeUrl(next.toString()))) queue.push({ url: next.toString(), depth: current.depth + 1 }); } catch { /* ignore */ }
      }
    }
    const liveFeatures = [...new Set(facts.map((item) => String(item.feature_id || "live.ui")))];
    return { observations, candidates, facts, scenario_observations: liveFeatures.map((feature_id) => ({ feature_id, scenario: "normal", observed: true, blocker: false, priority: "P0" })), contactedOrigins, blockedOrigins };
  } finally { await context.close().catch(() => undefined); await browser.close().catch(() => undefined); }
}

async function snapshots(page: Page, limit: number): Promise<ControlSnapshot[]> { return page.locator("button,input,select,textarea,a").evaluateAll((nodes, max) => nodes.slice(0, Number(max)).map((node, index) => ({ index, tag: node.nodeName.toLowerCase(), id: node.getAttribute("id") || undefined, role: node.getAttribute("role") || undefined, name: node.getAttribute("aria-label") || (node.textContent || "").trim().slice(0, 100) || node.getAttribute("name") || undefined, href: node.getAttribute("href") || undefined, type: node.getAttribute("type") || undefined, disabled: Boolean((node as unknown as { disabled?: boolean }).disabled) || node.hasAttribute("disabled") })), limit); }
async function structureSnapshots(page: Page): Promise<StructureSnapshot[]> {
  return page.locator("body").evaluate((body) => {
    const document = body.ownerDocument;
    const output: StructureSnapshot[] = [];
    const safeClass = (element: any, pattern?: RegExp): string | undefined => {
      if (!element) return undefined;
      const tokens = [...element.classList].filter((token) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(token));
      const token = pattern ? tokens.find((item) => pattern.test(item)) : tokens[0];
      return token ? "." + token : undefined;
    };
    const add = (semantic: string, selector: string | undefined, nth?: number, scopeSelector?: string): void => {
      if (!selector || output.some((item) => item.semantic === semantic)) return;
      output.push({ semantic, selector, ...(nth !== undefined ? { nth } : {}), ...(scopeSelector ? { scope_selector: scopeSelector } : {}) });
    };
    const repeated = [...document.querySelectorAll("li,[role=listitem],tbody>tr")].find((element) => {
      const selector = safeClass(element);
      return selector ? document.querySelectorAll(selector).length >= 2 : false;
    });
    const itemSelector = safeClass(repeated, /item|row|card|entry|record/i) || safeClass(repeated);
    add("collection_item", itemSelector);
    const all = [...document.querySelectorAll("*")];
    add("displayed_count", safeClass(all.find((element) => /count|total/i.test(element.className || "")), /count|total/i));
    add("item_status", itemSelector && safeClass(repeated?.querySelector("[class*=status],[class*=state]"), /status|state/i) ? itemSelector + " " + safeClass(repeated?.querySelector("[class*=status],[class*=state]"), /status|state/i) : undefined);
    add("search_input", safeClass(document.querySelector("input[type=search],input[class*=search]"), /search/i));
    const formRoot = all.find((element) => element.querySelectorAll("input,textarea").length >= 1 && element.querySelector("button") && /form|create|new|add/i.test(element.className || ""));
    const formSelector = safeClass(formRoot, /form|create|new|add/i);
    if (formSelector) {
      const textInputs = [...formRoot!.querySelectorAll("input,textarea")];
      textInputs.forEach((_element, index) => add(index === 0 ? "create_primary_input" : index === 1 ? "create_secondary_input" : `create_input_${index}`, formSelector + " input," + formSelector + " textarea", index));
      if (formRoot!.querySelector("select")) add("create_select", formSelector + " select", 0);
      const submit = formRoot!.querySelector("button");
      add("create_submit", safeClass(submit, /primary|submit|create|add/i) ? formSelector + " " + safeClass(submit, /primary|submit|create|add/i) : formSelector + " button", 0);
    }
    if (itemSelector) {
      const firstItem = document.querySelector(itemSelector);
      const buttons = [...(firstItem?.querySelectorAll("button") || [])];
      for (const button of buttons) {
        const text = `${button.className || ""} ${button.textContent || ""}`;
        const selector = safeClass(button);
        if (/delete|remove|danger/i.test(text)) add("delete_action", selector, undefined, itemSelector);
        else if (/toggle|complete|status|done/i.test(text)) add("toggle_action", selector, undefined, itemSelector);
        else if (/detail|title|open|view/i.test(text)) add("detail_action", selector, undefined, itemSelector);
      }
    }
    return output;
  });
}
async function fingerprint(page: Page, route: string): Promise<{ key: string; hash: string; text: string }> { const state = await page.locator("body").evaluate((body) => ({ text: (body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000), structure: [...body.querySelectorAll("a,button,input,select,textarea,[role]")].map((node) => [node.nodeName, node.getAttribute("id"), node.getAttribute("role"), node.getAttribute("aria-expanded"), node.getAttribute("aria-selected")]) })); const hash = crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex"); return { key: route + "|" + hash, hash, text: state.text }; }
async function settle(page: Page, deadline: number): Promise<void> { await page.waitForTimeout(Math.min(75, Math.max(1, remaining(deadline) - 1))); }
function isInteractive(control: ControlSnapshot): boolean { return control.tag === "a" || control.tag === "button" || control.type === "button" || control.type === "checkbox" || control.type === "radio"; }
function isMutating(control: ControlSnapshot): boolean { const text = `${control.name || ""} ${control.id || ""}`.toLowerCase(); return control.type === "submit" || /submit|save|delete|remove|create|update|send|pay|checkout|confirm|add|upload|login|sign/.test(text); }
function interactionKind(control: ControlSnapshot): string { return control.tag === "a" ? "navigate" : control.type === "checkbox" || control.type === "radio" ? "toggle" : control.type === "submit" ? "submit" : "activate"; }
function routeUrl(value: string): string { const url = new URL(value); return url.pathname + url.search; }
function operation(method: string, endpoint: string): string { if (/summary/i.test(endpoint)) return "summary"; if (/count/i.test(endpoint)) return "count"; if (/[?&](?:q|query|search)=/i.test(endpoint)) return "search"; return ({ GET: "read", POST: "create", PUT: "update", PATCH: "update", DELETE: "delete", OPTIONS: "cors" } as Record<string, string>)[method] || method.toLowerCase(); }
function feature(id: string | null, name: string | null): string { const value = `${id || ""} ${name || ""}`.toLowerCase(); if (/search/.test(value)) return "live.search"; if (/nav|next|back|details|about/.test(value)) return "live.navigation"; return "live.ui"; }
function fact(factType: DiscoveryFact["fact_type"], key: string, fields: Record<string, unknown>): DiscoveryFact { return { fact_id: "fact_" + crypto.createHash("sha256").update(factType + "|" + key).digest("hex").slice(0, 16), fact_type: factType, confidence: typeof fields.confidence === "number" ? fields.confidence : 0.9, ...fields }; }
function assertBudget(signal: AbortSignal, deadline: number): void { if (signal.aborted || performance.now() >= deadline) throw new Error("DISCOVERY_LIVE_BUDGET_EXCEEDED"); }
function remaining(deadline: number): number { const value = Math.ceil(deadline - performance.now()); if (value <= 0) throw new Error("DISCOVERY_LIVE_BUDGET_EXCEEDED"); return value; }
