// AutoPW MCP Host Harness — Phase 0 shell.
// Loads the frozen MCP/Schema contract inventory. No real MCP Server or Worker
// runs in M0 (spec 0.7); the harness exists so later milestones can drive the
// same contracts from the host side without re-deriving them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ContractInventory {
  tools: string[];
  schemas: string[];
  hostContext: string;
  cliCommands: string[];
  generatedAt: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

function readJson(rel: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

export function loadInventory(): ContractInventory {
  const toolsManifest = readJson("packages/mcp-contracts/contracts/manifest.json") as {
    tools: string[]; host_context: string;
  };
  const schemasManifest = readJson("packages/schemas/schemas/manifest.json") as { schemas: string[] };
  const cli = readJson("packages/maintenance-cli/commands.json") as { commands: { name: string }[] };
  return {
    tools: toolsManifest.tools,
    schemas: schemasManifest.schemas,
    hostContext: toolsManifest.host_context,
    cliCommands: cli.commands.map((c) => c.name),
    generatedAt: new Date().toISOString()
  };
}

const entryHref = pathToFileURL(process.argv[1] ?? "").href;
if (import.meta.url === entryHref) {
  console.log(JSON.stringify(loadInventory(), null, 2));
}