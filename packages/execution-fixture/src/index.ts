import http from "node:http";

export type FixtureVariant = "pass" | "fail" | "incomplete";
export interface FixtureCase { case_id: string; feature_id: string; scenario: "normal" | "required_field"; effective_tier: "fast"; steps: FixtureStep[]; }
export type FixtureStep = { action: "goto"; path: string } | { action: "fill"; selector: string; value: string } | { action: "click"; selector: string } | { action: "expect_visible"; selector: string } | { action: "expect_no_console_errors" };
export interface FixturePlan { schema_version: "2.1"; cases: FixtureCase[]; frozen_at: string; }
export interface DemoTarget { baseUrl: string; close(): Promise<void>; }

export const FIXTURE_PLAN: FixturePlan = Object.freeze({
  schema_version: "2.1", frozen_at: "2026-08-06T00:00:00.000Z", cases: [
    { case_id: "case_form_normal", feature_id: "demo_form", scenario: "normal", effective_tier: "fast", steps: [
      { action: "goto", path: "/?variant={variant}" }, { action: "fill", selector: "#name", value: "AutoPW" }, { action: "click", selector: "#submit" }, { action: "expect_visible", selector: "#success" }
    ] },
    { case_id: "case_required_field", feature_id: "demo_form", scenario: "required_field", effective_tier: "fast", steps: [
      { action: "goto", path: "/?variant={variant}" }, { action: "click", selector: "#submit" }, { action: "expect_visible", selector: "#required-error" }
    ] },
    { case_id: "case_console_health", feature_id: "demo_health", scenario: "normal", effective_tier: "fast", steps: [
      { action: "goto", path: "/?variant={variant}" }, { action: "expect_no_console_errors" }
    ] }
  ]
}) as FixturePlan;

function html(variant: FixtureVariant): string {
  const fail = variant === "fail";
  return `<!doctype html><html><head><meta charset="utf-8"><title>AutoPW Demo</title></head><body>
  <main><h1>AutoPW Demo Target</h1><form id="demo-form"><label>Name <input id="name" name="name"></label><button id="submit" type="submit">Submit</button></form>
  <p id="required-error" role="alert" hidden>Name is required</p><p id="success" role="status" hidden>Saved</p><p id="product-defect" hidden>Product defect fixture</p><ul id="items" aria-label="Items"></ul></main>
  <script>const form=document.querySelector('#demo-form');const name=document.querySelector('#name');async function loadItems(){const response=await fetch('/api/items');const items=await response.json();document.querySelector('#items').innerHTML=items.map((item)=>'<li>'+String(item.name)+'</li>').join('');}loadItems();form.addEventListener('submit',(event)=>{event.preventDefault();document.querySelector('#required-error').hidden=Boolean(name.value);if(!name.value)return;${fail ? "console.error('fixture product defect');document.querySelector('#product-defect').hidden=false;" : "document.querySelector('#success').hidden=false;"}});${fail ? "console.error('fixture console error');" : ""}</script>
  </body></html>`;
}

export async function startDemoTarget(variant: FixtureVariant = "pass"): Promise<DemoTarget> {
  const items: Array<{ id: string; name: string; completed?: boolean }> = [{ id: "item_1", name: "fixture item", completed: false }];
  let nextId = 2;
  let flakyCalls = 0;
  const sendJson = (response: http.ServerResponse, status: number, value: unknown): void => { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" }); response.end(JSON.stringify(value)); };
  const bodyJson = async (request: http.IncomingMessage): Promise<Record<string, unknown>> => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); if (!Buffer.concat(chunks).length) return {}; try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { return {}; } };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true })); return; }
    if (url.pathname === "/api/redirect") { response.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }); response.end(); return; }
    if (url.pathname === "/api/slow") { await new Promise((resolve) => setTimeout(resolve, 100)); sendJson(response, 200, { ok: true }); return; }
    if (url.pathname === "/api/slow-long") { await new Promise((resolve) => setTimeout(resolve, 1_000)); sendJson(response, 200, { ok: true }); return; }
    if (url.pathname === "/api/flaky") { flakyCalls += 1; sendJson(response, flakyCalls === 1 ? 500 : 200, { attempt: flakyCalls }); return; }
    if (url.pathname === "/api/auth-check") { sendJson(response, request.headers.authorization === "Bearer abcdef" ? 200 : 401, { authorized: request.headers.authorization === "Bearer abcdef" }); return; }
    if (url.pathname === "/api/items") {
      if (request.method === "GET") { sendJson(response, 200, items); return; }
      if (request.method === "POST") { const body = await bodyJson(request); const item = { id: "item_" + nextId++, name: String(body.name || "new item"), completed: Boolean(body.completed) }; items.push(item); sendJson(response, 201, item); return; }
    }
    const itemMatch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (itemMatch) {
      const item = items.find((candidate) => candidate.id === itemMatch[1]);
      if (!item) { sendJson(response, 404, { error: "not found" }); return; }
      if (request.method === "PATCH") { const body = await bodyJson(request); if (body.name !== undefined) item.name = String(body.name); if (body.completed !== undefined) item.completed = Boolean(body.completed); sendJson(response, 200, item); return; }
      if (request.method === "DELETE") { items.splice(items.indexOf(item), 1); sendJson(response, 204, undefined); return; }
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(html(variant));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("demo target did not expose a TCP port");
  return { baseUrl: "http://127.0.0.1:" + address.port, close: async () => { if (!server.listening) return; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
