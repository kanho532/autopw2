import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(root, "plugins", "autopw");
const runtimeRoot = path.join(root, "packages", "codex-plugin-runtime");
let passed = 0; let failed = 0;
function check(name, value, detail = "") { console.log((value ? "PASS " : "FAIL ") + name + (detail ? " " + detail : "")); if (value) passed += 1; else failed += 1; }
try { const plugin = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")); check("plugin-manifest-validates", plugin.name === "autopw" && /^\d+\.\d+\.\d+$/.test(plugin.version) && plugin.author?.name && plugin.interface?.displayName && plugin.mcpServers === "./.mcp.json"); } catch (error) { check("plugin-manifest-validates", false, String(error)); }
try { const output = process.platform === "win32" ? execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm pack --dry-run --json"], { cwd: runtimeRoot, encoding: "utf8" }) : execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: runtimeRoot, encoding: "utf8" }); const packed = JSON.parse(output)[0]; check("plugin-runtime-pack-includes-bundle-and-resources", packed.files.some((item) => item.path === "dist/stdio.js") && packed.files.some((item) => item.path.startsWith("resources/schemas/")) && packed.files.some((item) => item.path.startsWith("resources/contracts/"))); } catch (error) { check("plugin-runtime-pack-includes-bundle-and-resources", false, String(error)); }
check("plugin-runtime-bundles-internal-autopw-packages", !fs.readdirSync(path.join(runtimeRoot, "dist")).some((file) => fs.readFileSync(path.join(runtimeRoot, "dist", file), "utf8").includes("@autopw/")));
console.log(`\nPlugin package verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
