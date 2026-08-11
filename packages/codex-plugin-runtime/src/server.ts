import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AutoPwPluginHost, type JsonObject } from "./host.js";
export { WorkspaceTrustRegistry } from "./workspace-registry.js";

const workspace = { workspace_path: z.string().describe("Absolute path to a workspace previously trusted with the autopw CLI.") };
const run = { ...workspace, run_id: z.string() };
const resumableRun = { ...run, client_request_id: z.string().optional().describe("Optional idempotency key preserved when retrying the same resume request.") };
const operation = { ...workspace, operation_id: z.string() };

export function createPluginServer(host = new AutoPwPluginHost()): McpServer {
  const server = new McpServer({ name: "autopw", version: "2.2.0" }, { instructions: "AutoPW audits only user-trusted workspaces. Call autopw_status before derive_coverage or run_audit. Never invent workspace paths, target URLs, allowed origins, or auth scopes. If a workspace is not trusted, instruct the user to run the explicit autopw trust CLI command." });
  server.registerTool("autopw_status", { title: "Check AutoPW workspace status", description: "Check whether an absolute workspace path has trusted AutoPW target configuration.", inputSchema: workspace, annotations: readOnly() }, async ({ workspace_path }) => success(host.status(workspace_path)));
  server.registerTool("derive_coverage", { title: "Derive test coverage", description: "Discover a trusted workspace and derive bounded test requirements without executing the audit suite.", inputSchema: { ...workspace, project_subpath: z.string().optional(), tier: z.enum(["smoke", "fast", "full"]).optional(), diff_ref: z.string().optional() }, annotations: readOnly() }, async (input) => call(host, "derive_coverage", input));
  server.registerTool("run_audit", { title: "Run AutoPW audit", description: "Generate and execute a test plan for a trusted workspace. This may mutate the configured target according to the generated plan.", inputSchema: { ...workspace, project_subpath: z.string().optional(), base_tier: z.enum(["smoke", "fast", "full"]).optional() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async (input) => call(host, "run_audit", input));
  server.registerTool("get_operation_status", { title: "Get coverage operation status", description: "Poll a coverage derivation operation.", inputSchema: operation, annotations: readOnly() }, async (input) => call(host, "get_operation_status", input));
  server.registerTool("get_operation_result", { title: "Get coverage operation result", description: "Read a completed coverage derivation result.", inputSchema: operation, annotations: readOnly() }, async (input) => call(host, "get_operation_result", input));
  server.registerTool("get_run_status", { title: "Get audit run status", description: "Poll an AutoPW audit run.", inputSchema: run, annotations: readOnly() }, async (input) => call(host, "get_run_status", input));
  server.registerTool("get_run_result", { title: "Get audit run result", description: "Read a completed AutoPW audit result and report handles.", inputSchema: run, annotations: readOnly() }, async (input) => call(host, "get_run_result", input));
  server.registerTool("explain_run", { title: "Explain audit run", description: "Explain cases, failures, and evidence for a completed audit run.", inputSchema: { ...run, focus_case_id: z.string().optional() }, annotations: readOnly() }, async (input) => call(host, "explain_run", input));
  server.registerTool("resume_run", { title: "Resume audit run", description: "Resume an interrupted trusted audit run. Provide client_request_id when retrying the same request.", inputSchema: resumableRun, annotations: mutating() }, async (input) => call(host, "resume_run", input));
  server.registerTool("cancel_run", { title: "Cancel audit run", description: "Request cancellation for an active trusted audit run.", inputSchema: run, annotations: mutating() }, async (input) => call(host, "cancel_run", input));
  server.registerTool("cleanup_run", { title: "Cleanup audit run", description: "Delete retained artifacts for a trusted audit run.", inputSchema: run, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async (input) => call(host, "cleanup_run", input));
  return server;
}

async function call(host: AutoPwPluginHost, toolName: string, input: JsonObject) {
  try { return success(await host.call(toolName, input)); }
  catch (error) { const value = error as Error & { code?: string }; return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ kind: "error", error: { code: value.code || "PLUGIN_ERROR", message: value.message } }) }] }; }
}

function success(value: JsonObject) { return { structuredContent: value, content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
function readOnly() { return { readOnlyHint: true, destructiveHint: false, openWorldHint: false }; }
function mutating() { return { readOnlyHint: false, destructiveHint: false, openWorldHint: false }; }
