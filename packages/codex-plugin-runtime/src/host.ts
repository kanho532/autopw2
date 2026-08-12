import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExternalTargetProvider, type TargetProvider } from "@autopw/core";
import { McpServer } from "@autopw/mcp-server";
import { prepareCrEvidence, type ReviewTier } from "./cr-evidence.js";
import { WorkspaceTrustRegistry, type TrustedWorkspace } from "./workspace-registry.js";

export type JsonObject = Record<string, unknown>;

export class AutoPwPluginHost {
  readonly registry: WorkspaceTrustRegistry;
  readonly servers = new Map<string, McpServer>();
  readonly resourceRoot: string;

  constructor({ registry = new WorkspaceTrustRegistry(), resourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources") }: { registry?: WorkspaceTrustRegistry; resourceRoot?: string } = {}) {
    this.registry = registry;
    this.resourceRoot = resourceRoot;
  }

  status(workspacePath: string): JsonObject {
    const workspace = this.registry.resolve(workspacePath);
    return { trusted: Boolean(workspace), ...(workspace ? { workspace_id: workspace.workspace_id, target_configured: true, target_origin: workspace.target.base_url, profile: workspace.profile_path, runtime_version: "2.2.0", browser_ready: true } : { target_configured: false, runtime_version: "2.2.0", browser_ready: true }) };
  }

  async call(toolName: string, input: JsonObject): Promise<JsonObject> {
    const workspacePath = stringValue(input.workspace_path, "workspace_path");
    const workspace = this.registry.resolve(workspacePath);
    if (!workspace) throw Object.assign(new Error("workspace is not trusted; run `autopw trust <absolute-path> --target <origin>` first"), { code: "WORKSPACE_NOT_TRUSTED" });
    const server = this.serverFor(workspace);
    const request = this.internalRequest(toolName, workspace, input);
    return server.callTool(toolName, request as Record<string, any>);
  }

  exportRunReport(input: JsonObject): JsonObject {
    const workspacePath = stringValue(input.workspace_path, "workspace_path");
    const workspace = this.registry.resolve(workspacePath);
    if (!workspace) throw Object.assign(new Error("workspace is not trusted; run `autopw trust <absolute-path> --target <origin>` first"), { code: "WORKSPACE_NOT_TRUSTED" });
    const runId = runIdValue(input.run_id);
    const source = path.join(this.registry.configRoot, "runs", workspace.workspace_id, "runs", runId, "artifacts");
    const destination = path.join(workspace.realpath, ".autopw", "reports", runId);
    const artifacts = [["markdown", "report.md"], ["html", "report.html"], ["results", "results.json"]] as const;
    const paths: Record<string, string> = {};
    for (const [, filename] of artifacts) {
      const inputFile = path.join(source, filename);
      if (!fs.existsSync(inputFile) || !fs.statSync(inputFile).isFile()) throw Object.assign(new Error("report artifact is not available for run " + runId), { code: "REPORT_NOT_AVAILABLE" });
    }
    fs.mkdirSync(destination, { recursive: true });
    for (const [kind, filename] of artifacts) {
      const outputFile = path.join(destination, filename);
      fs.copyFileSync(path.join(source, filename), outputFile);
      paths[kind] = outputFile;
    }
    return { kind: "ok", run_id: runId, export_dir: destination, report_paths: paths };
  }

  prepareCrEvidence(input: JsonObject): JsonObject {
    const workspacePath = stringValue(input.workspace_path, "workspace_path");
    const workspace = this.registry.resolve(workspacePath);
    if (!workspace) throw Object.assign(new Error("workspace is not trusted; run `autopw trust <absolute-path> --target <origin>` first"), { code: "WORKSPACE_NOT_TRUSTED" });
    const runId = runIdValue(input.run_id);
    const reviewTier = reviewTierValue(input.review_tier);
    const sourceRoot = path.join(this.registry.configRoot, "runs", workspace.workspace_id, "runs", runId);
    return prepareCrEvidence({ sourceRoot, workspaceRoot: workspace.realpath, workspaceId: workspace.workspace_id, runId, reviewTier, project: optionalString(input.project) });
  }

  async close(): Promise<void> { await Promise.all([...this.servers.values()].map((server) => server.stop())); this.servers.clear(); }

  private serverFor(workspace: TrustedWorkspace): McpServer {
    const existing = this.servers.get(workspace.workspace_id);
    if (existing) return existing;
    const targetProvider: TargetProvider = new ExternalTargetProvider(workspace.target.base_url);
    const dataRoot = path.join(this.registry.configRoot, "runs", workspace.workspace_id);
    const server = new McpServer({ root: workspace.realpath, dataRoot, schemasDir: path.join(this.resourceRoot, "schemas"), toolsDir: path.join(this.resourceRoot, "contracts"), targetProvider, production: workspace.production });
    server.registerHostContext(workspace.workspace_id, { mcp_host_context: { workspace_authorization: { workspace_id: workspace.workspace_id, workspace_realpath: workspace.realpath, deny_symlink_escape: true }, trust_mode: "trusted", auth_scope: workspace.auth_scope, allowed_origins: workspace.target.allowed_origins, caller: "codex-plugin", policy_version: "2.2.0" } });
    server.start();
    this.servers.set(workspace.workspace_id, server);
    return server;
  }

  private internalRequest(toolName: string, workspace: TrustedWorkspace, input: JsonObject): JsonObject {
    const base: JsonObject = { schema_version: "2.1", workspace_id: workspace.workspace_id };
    if (toolName === "run_audit" || toolName === "derive_coverage") return { ...base, client_request_id: newClientRequestId(), project_subpath: optionalString(input.project_subpath) || ".", profile_path: workspace.profile_path, ...(toolName === "run_audit" ? { base_tier: optionalString(input.base_tier) || "fast" } : { tier: optionalString(input.tier) || "fast", diff_ref: optionalString(input.diff_ref) || "NOOP" }) };
    if (toolName === "get_operation_status" || toolName === "get_operation_result") return { ...base, operation_id: stringValue(input.operation_id, "operation_id") };
    if (toolName === "resume_run") return { ...base, client_request_id: optionalString(input.client_request_id) || newClientRequestId(), run_id: stringValue(input.run_id, "run_id") };
    if (["get_run_status", "get_run_result", "explain_run", "cancel_run", "cleanup_run"].includes(toolName)) return { ...base, run_id: stringValue(input.run_id, "run_id"), ...(optionalString(input.focus_case_id) ? { focus_case_id: optionalString(input.focus_case_id) } : {}) };
    throw Object.assign(new Error("unsupported plugin tool: " + toolName), { code: "PLUGIN_TOOL_UNSUPPORTED" });
  }
}

function stringValue(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error(name + " is required"), { code: "INVALID_INPUT" }); return value; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function runIdValue(value: unknown): string { const runId = stringValue(value, "run_id"); if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) throw Object.assign(new Error("run_id is invalid"), { code: "INVALID_INPUT" }); return runId; }
function reviewTierValue(value: unknown): ReviewTier { if (value !== "fast" && value !== "full") throw Object.assign(new Error("review_tier must be fast or full"), { code: "INVALID_INPUT" }); return value; }
function newClientRequestId(): string { return "plugin_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10); }
