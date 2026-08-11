import http from "node:http";

export interface TodoItem { id: string; title: string; completed: boolean; priority: "low" | "normal" | "high"; }
export interface TodoStats { creates: number; updates: number; deletes: number; requests: number; }
export interface TodoTarget { baseUrl: string; getItems(): TodoItem[]; getStats(): TodoStats; reset(): void; close(): Promise<void>; }

const MAX_TITLE_LENGTH = 80;
const PRIORITIES = new Set(["low", "normal", "high"]);

function page(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Todo Fixture</title></head><body>
  <main><h1>Todo Fixture</h1><form id="task-form"><label>Title <input id="title" name="title" required maxlength="80"></label>
  <label>Priority <select id="priority"><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option></select></label>
  <button id="create-task" type="submit">Create task</button></form>
  <label>Search <input id="search" aria-label="Search"></label><p>Summary: <span id="summary-total">0</span> total</p><p>Count: <span id="summary-count">0</span></p><ul id="task-list" aria-label="Tasks"></ul></main>
  <script>
  const form=document.querySelector('#task-form');const title=document.querySelector('#title');const priority=document.querySelector('#priority');const search=document.querySelector('#search');
  async function load(){const q=encodeURIComponent(search.value);const response=await fetch('/api/tasks'+(q?'?q='+q:''));const tasks=await response.json();document.querySelector('#task-list').innerHTML=tasks.map((task)=>'<li data-task-id="'+task.id+'">'+task.title+' ('+task.priority+')</li>').join('');const summary=await (await fetch('/api/summary')).json();document.querySelector('#summary-total').textContent=String(summary.total);document.querySelector('#summary-count').textContent=String(tasks.length);}
  form.addEventListener('submit',async(event)=>{event.preventDefault();if(!title.value)return;await fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:title.value,priority:priority.value})});title.value='';await load();});search.addEventListener('input',load);load();
  fetch('https://disallowed.example.invalid/telemetry').catch(()=>{});
  </script></body></html>`;
}

export async function startTodoTarget(): Promise<TodoTarget> {
  const items: TodoItem[] = [];
  let nextId = 1;
  const stats: TodoStats = { creates: 0, updates: 0, deletes: 0, requests: 0 };
  const sendJson = (response: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...extra });
    response.end(value === undefined ? "" : JSON.stringify(value));
  };
  const readJson = async (request: http.IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>; } catch { return {}; }
  };
  const server = http.createServer(async (request, response) => {
    stats.requests += 1;
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) { sendJson(response, 204, undefined, cors); return; }
    if (url.pathname === "/health") { sendJson(response, 200, { ok: true }); return; }
    if (url.pathname === "/api/tasks" && request.method === "GET") {
      const query = url.searchParams.get("q")?.toLowerCase() || "";
      sendJson(response, 200, items.filter((item) => !query || item.title.toLowerCase().includes(query)), cors); return;
    }
    if (url.pathname === "/api/tasks" && request.method === "POST") {
      const body = await readJson(request); const title = typeof body.title === "string" ? body.title.trim() : ""; const priority = String(body.priority || "normal");
      if (!title || title.length > MAX_TITLE_LENGTH || !PRIORITIES.has(priority)) { sendJson(response, 400, { error: "invalid task" }, cors); return; }
      const item: TodoItem = { id: "task_" + nextId++, title, completed: false, priority: priority as TodoItem["priority"] }; items.push(item); stats.creates += 1; sendJson(response, 201, item, cors); return;
    }
    if (url.pathname === "/api/summary" && request.method === "GET") { sendJson(response, 200, { total: items.length, completed: items.filter((item) => item.completed).length, open: items.filter((item) => !item.completed).length }, cors); return; }
    if (url.pathname === "/api/count" && request.method === "GET") { sendJson(response, 200, { count: items.length }, cors); return; }
    const match = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (match) {
      const item = items.find((candidate) => candidate.id === match[1]);
      if (!item) { sendJson(response, 404, { error: "not found" }, cors); return; }
      if (request.method === "GET") { sendJson(response, 200, item, cors); return; }
      if (request.method === "PATCH") {
        const body = await readJson(request); const nextTitle = body.title === undefined ? item.title : String(body.title).trim(); const nextPriority = body.priority === undefined ? item.priority : String(body.priority);
        if (!nextTitle || nextTitle.length > MAX_TITLE_LENGTH || !PRIORITIES.has(nextPriority)) { sendJson(response, 400, { error: "invalid task" }, cors); return; }
        item.title = nextTitle; item.priority = nextPriority as TodoItem["priority"]; if (body.completed !== undefined) item.completed = Boolean(body.completed); stats.updates += 1; sendJson(response, 200, item, cors); return;
      }
      if (request.method === "DELETE") { items.splice(items.indexOf(item), 1); stats.deletes += 1; sendJson(response, 204, undefined, cors); return; }
    }
    if (url.pathname === "/" || url.pathname === "/index.html") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page()); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("todo target did not expose a TCP port");
  return { baseUrl: "http://127.0.0.1:" + address.port, getItems: () => items.map((item) => ({ ...item })), getStats: () => ({ ...stats }), reset: () => { items.splice(0, items.length); nextId = 1; }, close: async () => { if (!server.listening) return; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) startTodoTarget().then((target) => { console.log(target.baseUrl); }).catch((error) => { console.error(error); process.exitCode = 1; });
