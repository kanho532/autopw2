// AutoPW MCP Server M1 runtime.
import path from "node:path";
import { OperationRegistry } from "@autopw/operation-registry";
import type { Logger, RetentionPolicy } from "@autopw/operation-registry";
import { ControlPlane } from "@autopw/control-plane";
import { FixtureWorker } from "@autopw/worker";

type JsonObject = Record<string, any>;

const DEFAULT_RETENTION: RetentionPolicy = {
  operation_ttl_ms: 86_400_000,
  run_ttl_ms: 7 * 86_400_000,
  evidence_ttl_ms: 30 * 86_400_000,
  cache_ttl_ms: 6 * 60 * 60_000,
  artifact_ttl_ms: 14 * 86_400_000,
  high_watermark: 1000,
  low_watermark: 100,
  tombstone_queryable: true
};

export interface McpServerOptions {
  root?: string;
  dataRoot?: string;
  hostContexts?: Record<string, { mcp_host_context: JsonObject }>;
  retention?: Partial<RetentionPolicy>;
  budgets?: Partial<{ installation: number; workspace: number; global: number; workspacePerRun: number }>;
  stepMs?: number;
  logger?: Logger;
}

export class McpServer {
  readonly root: string;
  readonly dataRoot: string;
  readonly schemasDir: string;
  readonly toolsDir: string;
  readonly retention: RetentionPolicy;
  readonly registry: OperationRegistry;
  readonly worker: FixtureWorker;
  readonly cp: ControlPlane;
  readonly log: Logger;
  readonly minPollMs = 100;

  constructor({ root = process.cwd(), dataRoot, hostContexts, retention, budgets, stepMs, logger }: McpServerOptions = {}) {
    this.root = path.resolve(root);
    this.dataRoot = path.resolve(dataRoot || path.join(this.root, ".autopw", "data"));
    this.schemasDir = path.join(this.root, "packages", "schemas", "schemas");
    this.toolsDir = path.join(this.root, "packages", "mcp-contracts", "contracts", "tools");
    this.retention = Object.assign({}, DEFAULT_RETENTION, retention || {});
    this.registry = new OperationRegistry({ dataRoot: this.dataRoot, retention: this.retention, logger });
    this.worker = new FixtureWorker({ registry: this.registry, budgets, stepMs, logger });
    this.cp = new ControlPlane({ schemasDir: this.schemasDir, toolsDir: this.toolsDir, hostContexts, operationRegistry: this.registry, worker: this.worker, logger });
    this.log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  }

  start(): void { this.worker.start(); this.log.info("mcp server started; policies v1.0.0"); }
  stop(): void { this.worker.stop(); this.log.info("mcp server stopped"); }
  restart(hostContexts?: Record<string, { mcp_host_context: JsonObject }>): void {
    this.registry.reload();
    this.worker.reload();
    if (hostContexts) for (const [workspace, context] of Object.entries(hostContexts)) this.cp.registerHostContext(workspace, context);
    this.log.info("mcp server restarted; " + this.registry.byId.size + " operations");
  }
  registerHostContext(workspace_id: string, ctx: { mcp_host_context: JsonObject }): void { this.cp.registerHostContext(workspace_id, ctx); }
  serverInfo(): JsonObject { return this.cp.serverInfo(); }
  async callTool(name: string, request: JsonObject): Promise<JsonObject> {
    const startedAt = Date.now();
    const output = await this.cp.handle(name, request);
    this.log.info("tool " + name + " -> " + (output.kind || "?") + " in " + (Date.now() - startedAt) + "ms");
    return output;
  }
  sweep(): { reclaimed: number; tombstoned: number } { return this.registry.sweep(); }
  registryRef(): OperationRegistry { return this.registry; }
  workerRef(): FixtureWorker { return this.worker; }
}
