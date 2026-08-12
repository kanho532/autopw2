import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const runtimeRoot = path.join(root, "packages", "codex-plugin-runtime");
const outputRoot = path.join(runtimeRoot, "dist");
const resourceRoot = path.join(runtimeRoot, "resources");
const esbuild = await import("esbuild");

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
  // Discovery loads these packages at runtime. Keep them external so the
  // published plugin uses normal Node resolution instead of bundling
  // TypeScript's CommonJS dynamic-require shim into an ESM bundle.
  external: ["playwright", "@modelcontextprotocol/sdk", "zod", "typescript", "js-yaml"],
  sourcemap: false,
  legalComments: "none"
});
