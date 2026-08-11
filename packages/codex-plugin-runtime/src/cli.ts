import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceTrustRegistry } from "./workspace-registry.js";

const [command, ...args] = process.argv.slice(2);
const registry = new WorkspaceTrustRegistry();

try {
  if (command === "trust") {
    const workspacePath = args[0]; const targetIndex = args.indexOf("--target");
    if (!workspacePath || targetIndex < 0 || !args[targetIndex + 1]) throw new Error("usage: autopw trust <absolute-workspace-path> --target <http(s)-origin>");
    console.log(JSON.stringify(registry.trust({ workspacePath, targetUrl: args[targetIndex + 1] }), null, 2));
  } else if (command === "untrust") {
    if (!args[0]) throw new Error("usage: autopw untrust <absolute-workspace-path>");
    console.log(JSON.stringify({ removed: registry.untrust(args[0]) }));
  } else if (command === "list") console.log(JSON.stringify({ workspaces: registry.list() }, null, 2));
  else if (command === "doctor") console.log(JSON.stringify({ runtime_version: "2.2.0", config_root: registry.configRoot, trusted_workspaces: registry.list().length, browser_install_command: "autopw install-browser" }, null, 2));
  else if (command === "install-browser") {
    const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const result = spawnSync(process.execPath, [path.join(runtimeRoot, "node_modules", "playwright", "cli.js"), "install", "chromium"], { stdio: "inherit" });
    process.exitCode = result.status || 0;
  } else if (command === "stdio") await import("./stdio.js");
  else throw new Error("usage: autopw <trust|untrust|list|doctor|install-browser|stdio>");
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
