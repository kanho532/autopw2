// AutoPW MCP Host Harness. It drives the M1 server through MCP-shaped calls.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@autopw/mcp-server";

type JsonObject = Record<string, any>;

export interface ContractInventory {
  tools: string[];
  schemas: string[];
  hostContext: string;
  cliCommands: string[];
  generatedAt: string;
}

export interface Harness {
  server: McpServer;
  dataRoot: string;
  hosts: Record<string, { mcp_host_context: JsonObject }>;
  cleanup(): Promise<void>;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HERE_TRUSTED = {
  mcp_host_context: {
    workspace_authorization: { workspace_id: "ws_demo", workspace_realpath: root, deny_symlink_escape: true },
    trust_mode: "trusted", auth_scope: { auth_scope_id: "as_demo", mode: "none", isolated: true },
    caller: "codex", policy_version: "1.0.0"
  }
};
const HERE_UNTRUSTED_PR = {
  mcp_host_context: {
    workspace_authorization: { workspace_id: "ws_pr", workspace_realpath: path.join(root, "fixtures"), deny_symlink_escape: true },
    trust_mode: "untrusted_pr", auth_scope: { auth_scope_id: "as_oneshot", mode: "credentials", one_shot: true, isolated: true },
    caller: "codex-ci", config_source: { base_revision: "origin/main", pr_head_allowed: false }, policy_version: "1.0.0"
  }
};
const logger = { info: () => {}, warn: () => {}, error: (message: unknown) => console.error("ERR", message) };

function readJson(relativePath: string): JsonObject { return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as JsonObject; }

export function loadInventory(): ContractInventory {
  const toolsManifest = readJson("packages/mcp-contracts/contracts/manifest.json");
  const schemasManifest = readJson("packages/schemas/schemas/manifest.json");
  const cli = readJson("packages/maintenance-cli/commands.json");
  return {
    tools: toolsManifest.tools as string[],
    schemas: schemasManifest.schemas as string[],
    hostContext: String(toolsManifest.host_context),
    cliCommands: (cli.commands as { name: string }[]).map((command) => command.name),
    generatedAt: new Date().toISOString()
  };
}

export async function newHarness({ retention, budgets, stepMs, fixtureVariant, dataRoot: requestedDataRoot }: {
  retention?: Record<string, number | boolean>;
  budgets?: Record<string, number>;
  stepMs?: number;
  fixtureVariant?: "pass" | "fail" | "incomplete";
  dataRoot?: string;
} = {}): Promise<Harness> {
  const dataRoot = requestedDataRoot || path.join(root, ".autopw", "test-" + crypto.randomBytes(6).toString("hex"));
  fs.mkdirSync(dataRoot, { recursive: true });
  const hosts = { ws_demo: HERE_TRUSTED, ws_pr: HERE_UNTRUSTED_PR };
  const server = new McpServer({ root, dataRoot, retention, budgets, stepMs, fixtureVariant, logger });
  for (const [workspace, context] of Object.entries(hosts)) server.registerHostContext(workspace, context);
  server.start();
  return { server, dataRoot, hosts, cleanup: async () => { await server.stop(); fs.rmSync(dataRoot, { recursive: true, force: true }); } };
}

export function call(server: McpServer, name: string, request: JsonObject): Promise<JsonObject> { return server.callTool(name, request); }
export function crashBetween(): string { return "no-op fixture: crash simulated by restart()"; }
export const TEST_HOSTS = { TRUSTED: HERE_TRUSTED, UNTRUSTED_PR: HERE_UNTRUSTED_PR };

const entryHref = pathToFileURL(process.argv[1] ?? "").href;
if (import.meta.url === entryHref) console.log(JSON.stringify(loadInventory(), null, 2));
