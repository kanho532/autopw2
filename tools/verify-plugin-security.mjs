import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const runtime = await import(pathToFileURL(path.join(root, "packages", "codex-plugin-runtime", "dist", "server.js")).href);
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-plugin-security-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-plugin-workspace-"));
let passed = 0; let failed = 0;
function check(name, value) { console.log((value ? "PASS " : "FAIL ") + name); if (value) passed += 1; else failed += 1; }
function rejects(fn, code) { try { fn(); return false; } catch (error) { return error?.code === code; } }
try {
  const registry = new runtime.WorkspaceTrustRegistry(configRoot);
  const entry = registry.trust({ workspacePath: workspace, targetUrl: "http://127.0.0.1:3000" });
  check("plugin-trust-record-is-host-owned", entry.workspace_id.startsWith("ws_") && entry.realpath === fs.realpathSync.native(workspace) && entry.target.allowed_origins[0] === "http://127.0.0.1:3000" && fs.existsSync(path.join(configRoot, "workspaces.json")));
  check("plugin-rejects-credential-target", rejects(() => registry.trust({ workspacePath: workspace, targetUrl: "http://user:secret@127.0.0.1:3000" }), "TARGET_URL_INVALID"));
  check("plugin-rejects-uncontained-profile", rejects(() => registry.trust({ workspacePath: workspace, targetUrl: "http://127.0.0.1:3000", profilePath: "../profile.json" }), "PROFILE_PATH_INVALID"));
  check("plugin-resolves-only-canonical-workspace", registry.resolve(workspace)?.workspace_id === entry.workspace_id);
} finally { fs.rmSync(configRoot, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); }
console.log(`\nPlugin security verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
