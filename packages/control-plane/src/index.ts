// AutoPW MCP Control Plane — runtime contract validation, authorization,
// idempotent Operation creation and bounded MCP responses.
import Ajv from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import type { OperationRegistry, OperationRecord } from "@autopw/operation-registry";
import type { FixtureWorker } from "@autopw/worker";
import { assertNoSecrets, SecureArtifactService, SecurityPolicyEngine, resolveAuthorizedPath, type HostContextLike } from "@autopw/security";

type JsonObject = Record<string, any>;
interface ToolContract { name: string; input_schema: JsonObject; result_union: JsonObject[]; creates_operation: boolean; }
interface Logger { info(message: string): void; warn(message: string): void; error(message: unknown): void; }
interface HostContextEntry { mcp_host_context: JsonObject; }

export class ControlPlane {
  readonly ajv: Ajv;
  readonly tools: Record<string, ToolContract> = Object.create(null) as Record<string, ToolContract>;
  readonly inputValidators: Record<string, ValidateFunction> = Object.create(null) as Record<string, ValidateFunction>;
  readonly resultValidators: Record<string, ValidateFunction[]> = Object.create(null) as Record<string, ValidateFunction[]>;
  readonly hostContexts: Record<string, HostContextEntry>;
  readonly registry: OperationRegistry;
  readonly worker: FixtureWorker;
  readonly log: Logger;
  readonly maxBytes = 524288;
  readonly schemasDir: string;
  readonly security = new SecurityPolicyEngine();
  readonly artifacts = new SecureArtifactService();

  constructor({ schemasDir, toolsDir, hostContexts, operationRegistry, worker, logger }: {
    schemasDir: string; toolsDir: string; hostContexts?: Record<string, HostContextEntry>;
    operationRegistry: OperationRegistry; worker: FixtureWorker; logger?: Logger;
  }) {
    this.ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
    addFormats(this.ajv);
    this.ajv.addSchema(JSON.parse(fs.readFileSync(path.join(schemasDir, "common.schema.json"), "utf8")));
    for (const file of fs.readdirSync(schemasDir)) {
      if (!file.endsWith(".schema.json") || file === "common.schema.json") continue;
      const schema = JSON.parse(fs.readFileSync(path.join(schemasDir, file), "utf8")) as JsonObject;
      if (!this.ajv.getSchema(schema.$id)) this.ajv.addSchema(schema, schema.$id);
    }
    for (const file of fs.readdirSync(toolsDir)) {
      if (!file.endsWith(".tool.json")) continue;
      const tool = JSON.parse(fs.readFileSync(path.join(toolsDir, file), "utf8")) as ToolContract;
      this.tools[tool.name] = tool;
      this.inputValidators[tool.name] = this._compile(tool.input_schema);
      this.resultValidators[tool.name] = tool.result_union.map((schema) => this._compile(schema));
    }
    this.hostContexts = hostContexts || {};
    this.registry = operationRegistry;
    this.worker = worker;
    this.log = logger || { info: () => {}, warn: () => {}, error: () => {} };
    this.schemasDir = schemasDir;
  }

  registerHostContext(workspace_id: string, ctx: HostContextEntry): void { this.hostContexts[workspace_id] = ctx; }

  serverInfo(): JsonObject {
    return { server_info: { name: "autopw-mcp", version: "2.1.0-rc5.mcp-first", tools: Object.keys(this.tools), m0_frozen: true, policy_version: "1.0.0" } };
  }

  authorize(toolName: string, request: JsonObject): { ok: true; hostContext: JsonObject; tool: ToolContract; securitySnapshot: Record<string, unknown> } | { ok: false; error: { code: string; message: string } } {
    const tool = this.tools[toolName];
    if (!tool) return { ok: false, error: mkErr("TOOL_NOT_FOUND", "unknown tool " + toolName) };
    const inputValidator = this.inputValidators[toolName];
    if (!inputValidator(request)) return { ok: false, error: mkErr("INVALID_INPUT", this._errText(inputValidator.errors)) };
    try { assertNoSecrets(request); }
    catch (error) { const value = error as Error & { code?: string }; return { ok: false, error: mkErr(value.code || "SECRET_IN_INPUT", "tool input contains secret-like data") }; }
    const host = this.hostContexts[String(request.workspace_id)];
    if (!host) return { ok: false, error: mkErr("UNAUTHORIZED_WORKSPACE", "workspace not in host allowlist") };
    const hostContext = host.mcp_host_context;
    let securitySnapshot: Record<string, unknown>;
    try { securitySnapshot = this.security.authorizeRequest(hostContext as HostContextLike, request).snapshot; }
    catch (error) { const value = error as Error & { code?: string }; return { ok: false, error: mkErr(value.code || "SECURITY_POLICY_VIOLATION", value.message || "security policy rejected request") }; }
    const base = String(hostContext.workspace_authorization.workspace_realpath);
    try { resolveAuthorizedPath(base, String(request.project_subpath || ".")); }
    catch (error) { const value = error as Error & { code?: string }; return { ok: false, error: mkErr(value.code || "WORKSPACE_ESCAPE", value.message || "project path is outside workspace") }; }
    const projectPath = path.resolve(base, String(request.project_subpath || "."));
    if (!fs.existsSync(projectPath)) return { ok: false, error: mkErr("PROJECT_SUBPATH_NOT_FOUND", "project_subpath does not exist") };
    if (!fs.statSync(projectPath).isDirectory()) return { ok: false, error: mkErr("PROJECT_SUBPATH_NOT_DIRECTORY", "project_subpath is not a directory") };
    if (request.auth_scope_id && request.auth_scope_id !== hostContext.auth_scope.auth_scope_id) return { ok: false, error: mkErr("AUTH_SCOPE_NOT_APPROVED", "auth_scope_id not approved by host") };
    const matrix = isRecord(request.matrix) ? request.matrix : undefined;
    const matrixScopes = matrix && Array.isArray(matrix.auth_scope_ids) ? matrix.auth_scope_ids : [];
    if (matrixScopes.some((scope) => scope !== hostContext.auth_scope.auth_scope_id)) return { ok: false, error: mkErr("AUTH_SCOPE_NOT_APPROVED", "matrix auth scope is not approved by host") };
    return { ok: true, hostContext, tool, securitySnapshot };
  }

  private _compile(schema: JsonObject): ValidateFunction {
    if (schema.$ref) return this.ajv.getSchema(schema.$ref) || this.ajv.compile(schema);
    const copy = JSON.parse(JSON.stringify(schema)) as JsonObject;
    delete copy.$id;
    return this.ajv.compile(copy);
  }

  private _errText(errors: ErrorObject[] | null | undefined): string { return (errors || []).map((error) => error.instancePath + " " + error.message).join("; "); }

  async handle(toolName: string, request: JsonObject): Promise<JsonObject> {
    let output: JsonObject;
    try { output = await this._handle(toolName, request); }
    catch (error) { this.log.error(error); output = err("INTERNAL_ERROR", error instanceof Error ? error.message : String(error)); }
    const bounded = this._truncate(output);
    if (!this.tools[toolName]) return bounded;
    const validator = this.resultValidators[toolName].find((candidate) => candidate(bounded));
    return validator ? bounded : err("INTERNAL_CONTRACT_VIOLATION", "handler returned a result outside the tool contract");
  }

  private async _handle(toolName: string, request: JsonObject): Promise<JsonObject> {
    const auth = this.authorize(toolName, request);
    if (!auth.ok) return err(auth.error.code, auth.error.message);
    const tool = auth.tool;
    if (!tool.creates_operation) return this._handleQuery(toolName, request);

    const persistedRequest = { ...request, __trust_snapshot: auth.securitySnapshot };
    const existing = this.registry.findByIdempotency({ workspace_id: String(request.workspace_id), tool: toolName, client_request_id: String(request.client_request_id) });
    if (existing) {
      if (!this.registry.sameParams(existing, persistedRequest)) return err("IDEMPOTENCY_CONFLICT", "same client_request_id with different params");
      return this._acceptedFor(toolName, existing);
    }

    if (toolName === "derive_coverage" || toolName === "run_audit") {
      try {
        const hostMax = Number(auth.hostContext.max_execution_instances_per_run || 100);
        const preview = await this.worker.preflight({ ...persistedRequest, __host_max_execution_instances: hostMax });
        if (preview.derivation.projection.projected_execution_instances > preview.derivation.projection.effective_budget) {
          return err("MATRIX_BUDGET_EXCEEDED", "projected execution instances exceed effective matrix budget", {
            projected_execution_instances: preview.derivation.projection.projected_execution_instances,
            effective_budget: preview.derivation.projection.effective_budget,
            projection: preview.derivation.projection.dimensions,
            narrowing_suggestions: preview.derivation.projection.narrowing_suggestions
          });
        }
      } catch (error) {
        const value = error as Error & { code?: string };
        return err(value.code || "PREFLIGHT_FAILED", value.message || String(error));
      }
    }

    const targetTools = ["resume_run", "cancel_run", "cleanup_run"];
    if (targetTools.includes(toolName)) {
      const target = this.worker.getRun(String(request.run_id));
      if (!target || target.workspace_id !== String(request.workspace_id)) return err("RUN_FORBIDDEN", "handle not bound to this workspace");
      if (toolName === "resume_run" && target.phase === "GATED") return err("RUN_NOT_RESUMABLE", "run is already terminal");
    }

    let created: { operation_id: string; operation: OperationRecord; created: boolean };
    try {
      created = this.registry.create({ tool: toolName, client_request_id: String(request.client_request_id), workspace_id: String(request.workspace_id), kind: this._opKind(toolName), params: persistedRequest });
    } catch (error) {
      const value = error as Error & { code?: string };
      return err(value.code || "OPERATION_CREATE_FAILED", value.message);
    }
    if (!created.created) return this._acceptedFor(toolName, created.operation);
    if (toolName === "run_audit") {
      const run = this.worker.createFixtureRun({ workspace_id: String(request.workspace_id), operation_id: created.operation_id });
      this.registry.updateRun(run, { operationStatus: "RUNNING" });
    } else if (targetTools.includes(toolName)) {
      this.registry.update(created.operation_id, (record) => { record.run_id = String(request.run_id); return record; });
    }
    this.worker.enqueue(created.operation_id, created.operation.kind, persistedRequest, toolName);
    return this._acceptedFor(toolName, this.registry.get(created.operation_id) as OperationRecord);
  }

  private _acceptedFor(toolName: string, operation: OperationRecord): JsonObject {
    const accepted: JsonObject = { kind: "accepted", schema_version: "2.1", operation_id: operation.operation_id, poll_after_ms: 2000 };
    if (toolName === "run_audit") accepted.run_handle = operation.run_id;
    else if (operation.run_id) accepted.run_id = operation.run_id;
    return accepted;
  }

  private _opKind(toolName: string): OperationRecord["kind"] {
    if (toolName === "run_audit" || toolName === "resume_run") return "run";
    if (toolName === "derive_coverage") return "preview";
    return "maintenance";
  }

  private _handleQuery(toolName: string, request: JsonObject): JsonObject {
    try {
      if (toolName === "get_operation_status" || toolName === "get_operation_result") {
        const operation = this.registry.get(String(request.operation_id));
        if (!operation) return err("OPERATION_NOT_FOUND", "operation id unknown or expired");
        if (operation.workspace_id !== String(request.workspace_id)) return err("OPERATION_FORBIDDEN", "operation not bound to this workspace");
        if (toolName === "get_operation_status") return ok({ operation_id: operation.operation_id, status: operation.status, label: operation.status.toLowerCase(), poll_after_ms: 2000 });
        if (operation.status !== "COMPLETED") return notReady({ operation_id: operation.operation_id, poll_after_ms: 2000 });
        const summary = operation.result_summary || {};
        return ok({ operation_id: operation.operation_id, result_ref: operation.result_ref || { handle: "art_preview", kind: "cdd.json" }, summary, pagination: pageMeta(Number(request.page || 1), Number(request.page_size || 20), Number(summary.skeleton_count || 0)) });
      }
      if (toolName === "get_run_status") {
        const run = this.worker.getRun(String(request.run_id));
        if (!run || run.workspace_id !== String(request.workspace_id)) return err("RUN_FORBIDDEN", "handle not bound to this workspace");
        const cases = run.cases || [];
        const status: JsonObject = { run_id: run.run_id, phase: run.phase, run_status: run.run_status, progress_pct: run.progress_pct, counts: progressCounts(cases), by_tier: groupedCounts(cases, ["effective_tier", "tier"]), by_batch: groupedCounts(cases, ["batch_id"]), next_action: run.next_action, poll_after_ms: isTerminalRun(run) ? 0 : 2000, stale: run.run_status === "INTERRUPTED", interrupted: run.run_status === "INTERRUPTED", recent_events: this.worker.readEvents(run.run_id, 5) };
        if (run.audit_status) status.audit_status = run.audit_status;
        if (run.gate) status.gate = run.gate;
        return ok(status);
      }
      if (toolName === "get_run_result") {
        const run = this.worker.getRun(String(request.run_id));
        if (!run || run.workspace_id !== String(request.workspace_id)) return err("RUN_FORBIDDEN", "handle not bound to this workspace");
        if (run.phase !== "GATED" && run.run_status !== "FAILED") return notReady({ run_id: run.run_id, poll_after_ms: 2000 });
        if (run.run_status === "FAILED") return failed({ run_id: run.run_id, fatal_class: run.fatal_class || "STATE_CORRUPTED", failure_ref: { handle: "art_failure", kind: "failure.json" } });
        const allIssues = run.results_ref ? this.readArtifactIssues(run) : [];
        const pageResult = pageItems(allIssues, request.page, request.page_size);
        return ok({ run_id: run.run_id, gate: run.gate, audit_status: run.audit_status, results_ref: run.results_ref || { handle: "art_results", kind: "results.json" }, report_ref: run.report_ref || { handle: "art_report", kind: "report.md" }, gate_summary: run.gate_summary || {}, issues: pageResult.items, pagination: pageResult.pagination });
      }
      if (toolName === "explain_run") {
        const run = this.worker.getRun(String(request.run_id));
        if (!run || run.workspace_id !== String(request.workspace_id)) return err("RUN_FORBIDDEN", "handle not bound to this workspace");
        const allCases = (run.cases || []).filter((item) => !request.focus_case_id || item.case_id === request.focus_case_id);
        if (request.focus_case_id && allCases.length === 0) return err("CASE_NOT_FOUND", "focus_case_id is not present in this run");
        const pageResult = pageItems(allCases, request.page, request.page_size);
        const evidenceRefs = run.evidence_refs || [];
        const explanation: JsonObject = { run_id: run.run_id, cases: pageResult.items, evidence_refs: evidenceRefs, pagination: pageResult.pagination, gate_summary: run.gate_summary || {} };
        if (run.gate) explanation.gate = run.gate;
        if (run.audit_status) explanation.audit_status = run.audit_status;
        return ok(explanation);
      }
      return err("TOOL_NOT_HANDLED", "query tool " + toolName + " not handled");
    } catch (error) {
      const value = error as Error & { code?: string };
      return err(value.code === "RESULT_EXPIRED" ? "RESULT_EXPIRED" : "QUERY_FAILED", value.message);
    }
  }

  private _truncate(value: JsonObject): JsonObject { return Buffer.byteLength(JSON.stringify(value), "utf8") <= this.maxBytes ? value : err("RESPONSE_TOO_LARGE", "response exceeds max bytes; use pagination"); }

  private readArtifactIssues(run: { run_id: string; workspace_id: string; results_ref?: { handle: string; kind: string } }): JsonObject[] {
    if (!run.results_ref) return [];
    this.artifacts.authorizeRead({ requestedWorkspaceId: run.workspace_id, runWorkspaceId: run.workspace_id, handle: run.results_ref.handle, kind: run.results_ref.kind });
    try {
      const parsed = JSON.parse(this.worker.readArtifact(run.run_id, run.results_ref).toString("utf8")) as JsonObject;
      return Array.isArray(parsed.issues) ? parsed.issues.filter(isRecord) : [];
    } catch (error) {
      const value = error as Error & { code?: string };
      if (value.code === "RESULT_EXPIRED") throw error;
      return [];
    }
  }
}

interface ErrorObject { instancePath: string; message?: string; }
function mkErr(code: string, message: string): { code: string; message: string } { return { code, message }; }
function result(kind: string, payload: JsonObject): JsonObject { return { kind, schema_version: "2.1", ...payload }; }
function ok(payload: JsonObject): JsonObject { return result("ok", payload); }
function notReady(payload: JsonObject): JsonObject { return result("not_ready", payload); }
function failed(payload: JsonObject): JsonObject { return result("failed", payload); }
function err(code: string, message: string, details?: JsonObject): JsonObject { return { kind: "error", schema_version: "2.1", error: { code, message, ...(details ? { details } : {}) }, retryable: false }; }
function isTerminalRun(run: { phase: string; run_status: string }): boolean { return run.phase === "GATED" || run.run_status === "FAILED" || run.run_status === "COMPLETED"; }
function progressCounts(items: JsonObject[]): JsonObject {
  const terminal = new Set(["PASSED", "FAILED", "FLAKY", "BLOCKED", "INFRA_BLOCKED"]);
  return { planned: items.length, started: items.filter((item) => item.status && item.status !== "NOT_RUN").length, terminal: items.filter((item) => terminal.has(String(item.status))).length };
}
function groupedCounts(items: JsonObject[], keys: string[]): JsonObject {
  const result: JsonObject = {};
  for (const item of items) { const key = keys.map((name) => item[name]).find((value) => value !== undefined && value !== null) || "unknown"; const bucket = result[String(key)] || { planned: 0, started: 0, terminal: 0 }; const counts = progressCounts([item]); bucket.planned += counts.planned; bucket.started += counts.started; bucket.terminal += counts.terminal; result[String(key)] = bucket; }
  return result;
}
function pageItems(items: JsonObject[], requestedPage: unknown, requestedSize: unknown): { items: JsonObject[]; pagination: JsonObject } {
  const page = Math.max(1, Number(requestedPage || 1)); const pageSize = Math.min(100, Math.max(1, Number(requestedSize || 20))); const totalItems = items.length; const offset = (page - 1) * pageSize;
  return { items: items.slice(offset, offset + pageSize), pagination: pageMeta(page, pageSize, totalItems) };
}
function pageMeta(page: number, pageSize: number, totalItems: number): JsonObject { const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize); return { page, page_size: pageSize, total_items: totalItems, total_pages: totalPages, has_more: totalPages > page, next_page: totalPages > page ? page + 1 : null }; }
function isRecord(value: unknown): value is JsonObject { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
