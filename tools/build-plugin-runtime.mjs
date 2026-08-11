import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const runtimeRoot = path.join(root, "packages", "codex-plugin-runtime");
const outputRoot = path.join(runtimeRoot, "dist");
const resourceRoot = path.join(runtimeRoot, "resources");
const esbuild = await import(pathToFileURL(path.join(runtimeRoot, "node_modules", "esbuild", "lib", "main.js")).href);

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.rmSync(resourceRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });
fs.cpSync(path.join(root, "packages", "schemas", "schemas"), path.join(resourceRoot, "schemas"), { recursive: true });
fs.cpSync(path.join(root, "packages", "mcp-contracts", "contracts", "tools"), path.join(resourceRoot, "contracts"), { recursive: true });

await esbuild.build({
  entryPoints: [path.join(runtimeRoot, "src", "stdio.ts"), path.join(runtimeRoot, "src", "cli.ts"), path.join(runtimeRoot, "src", "server.ts")],
  outdir: outputRoot,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["playwright", "@modelcontextprotocol/sdk", "zod"],
  sourcemap: false,
  legalComments: "none"
});
