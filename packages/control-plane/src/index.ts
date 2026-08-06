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

  authorize(toolName: string, request: JsonObject): { ok: true; hostContext: JsonObject; tool: ToolContract } | { ok: false; error: { code: string; message: string } } {
    const tool = this.tools[toolName];
    if (!tool) return { ok: false, error: mkErr("TOOL_NOT_FOUND", "unknown tool " + toolName) };
    const inputValidator = this.inputValidators[toolName];
    if (!inputValidator(request)) return { ok: false, error: mkErr("INVALID_INPUT", this._errText(inputValidator.errors)) };
    const host = this.hostContexts[String(request.workspace_id)];
    if (!host) return { ok: false, error: mkErr("UNAUTHORIZED_WORKSPACE", "workspace not in host allowlist") };
    const hostContext = host.mcp_host_context;
    const base = String(hostContext.workspace_authorization.workspace_realpath);
    if (!this._isAuthorizedPath(base, String(request.project_subpath || "."))) return { ok: false, error: mkErr("WORKSPACE_ESCAPE", "project_subpath escapes workspace realpath") };
    if (request.auth_scope_id && request.auth_scope_id !== hostContext.auth_scope.auth_scope_id) return { ok: false, error: mkErr("AUTH_SCOPE_NOT_APPROVED", "auth_scope_id not approved by host") };
    return { ok: true, hostContext, tool };
  }

  private _isAuthorizedPath(base: string, projectSubpath: string): boolean {
    const resolved = path.resolve(base, projectSubpath);
    if (!this._isWithin(base, resolved)) return false;
    return this._isWithin(this._realpathIfPossible(base), this._realpathIfPossible(this._existingAncestor(resolved)));
  }

  private _existingAncestor(target: string): string {
    let current = target;
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return current;
  }

  private _realpathIfPossible(target: string): string { try { return fs.realpathSync.native(target); } catch { return path.resolve(target); } }

  private _isWithin(base: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(base), path.resolve(candidate));
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
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

    const targetTools = ["resume_run", "cancel_run", "cleanup_run"];
    if (targetTools.includes(toolName)) {
      const target = this.worker.getRun(String(request.run_id));
      if (!target || target.workspace_id !== String(request.workspace_id)) return err("RUN_FORBIDDEN", "handle not bound to this workspace");
      if (toolName === "resume_run" && target.phase === "GATED") return err("RUN_NOT_RESUMABLE", "run is already terminal");
    }

    let created: { operation_id: string; operation: OperationRecord; created: boolean };
    try {
      created = this.registry.create({ tool: toolName, client_request_id: String(request.client_request_id), workspace_id: String(request.workspace_id), kind: this._opKind(toolName), params: request });
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
    this.worker.enqueue(created.operation_id, created.operation.kind, request, toolName);
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
        return ok({ operation_id: operation.operation_id, result_ref: operation.result_ref || { handle: "art_preview", kind: "cdd.json" }, summary: operation.result_summary || {} });
      }
      if (toolName === "get_run_status") {
        const run = this.worker.getRun(String(request.run_id));
        if (!run || run.workspace_id !== String(request.workspace_id)) return err("RUN_FORBIDDEN", "handle not bound to this workspace");
        const status: JsonObject = { run_id: run.run_id, phase: run.phase, run_status: run.run_status, progress_pct: run.progress_pct, next_action: run.next_action, poll_after_ms: 2000, stale: false, interrupted: run.run_status === "INTERRUPTED" };
        if (run.audit_status) status.audit_status = run.audit_status;
        if (run.gate) status.gate = run.gate;
        return ok(status);
      }
      if (toolName === "get_run_result") {
        const run = this.worker.getRun(String(request.run_id));
        if (!run || run.workspace_id !== String(request.workspace_id)) return err("RUN_FORBIDDEN", "handle not bound to this workspace");
        if (run.phase !== "GATED" && run.run_status !== "FAILED") return notReady({ run_id: run.run_id, poll_after_ms: 2000 });
        if (run.run_status === "FAILED") return failed({ run_id: run.run_id, fatal_class: run.fatal_class || "STATE_CORRUPTED", failure_ref: { handle: "art_failure", kind: "failure.json" } });
        return ok({ run_id: run.run_id, gate: run.gate, audit_status: run.audit_status, results_ref: { handle: "art_results", kind: "results.json" }, report_ref: { handle: "art_report", kind: "report.md" }, gate_summary: {} });
      }
      if (toolName === "explain_run") {
        const run = this.worker.getRun(String(request.run_id));
        if (!run || run.workspace_id !== String(request.workspace_id)) return err("RUN_FORBIDDEN", "handle not bound to this workspace");
        const explanation: JsonObject = { run_id: run.run_id, cases: [], evidence_refs: [] };
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
}

interface ErrorObject { instancePath: string; message?: string; }
function mkErr(code: string, message: string): { code: string; message: string } { return { code, message }; }
function result(kind: string, payload: JsonObject): JsonObject { return { kind, schema_version: "2.1", ...payload }; }
function ok(payload: JsonObject): JsonObject { return result("ok", payload); }
function notReady(payload: JsonObject): JsonObject { return result("not_ready", payload); }
function failed(payload: JsonObject): JsonObject { return result("failed", payload); }
function err(code: string, message: string): JsonObject { return { kind: "error", schema_version: "2.1", error: { code, message }, retryable: false }; }
