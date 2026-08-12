import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(root, "plugins", "autopw");
const plugin = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));
const marketplace = JSON.parse(fs.readFileSync(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
let passed = 0; let failed = 0;
function check(name, value) { console.log((value ? "PASS " : "FAIL ") + name); if (value) passed += 1; else failed += 1; }

check("plugin-required-manifest", plugin.name === "autopw" && /^2\.2\.0(?:\+codex\.[A-Za-z0-9._-]+)?$/.test(plugin.version) && plugin.skills === "./skills/" && plugin.mcpServers === "./.mcp.json");
check("plugin-skills-are-present", ["web-audit", "audit-triage", "cr-report"].every((name) => fs.existsSync(path.join(pluginRoot, "skills", name, "SKILL.md"))));
check("plugin-mcp-is-version-pinned", mcp.mcpServers?.autopw?.command === "npx" && mcp.mcpServers.autopw.args?.includes("@autopw/codex-plugin-runtime@2.2.0") && !mcp.mcpServers.autopw.args?.some((value) => String(value).includes("latest")));
check("plugin-marketplace-entry", marketplace.plugins?.some((item) => item.name === "autopw" && item.source?.path === "./plugins/autopw" && item.policy?.installation === "AVAILABLE" && item.policy?.authentication === "ON_INSTALL"));
check("plugin-runtime-contract-resources", fs.existsSync(path.join(root, "packages", "codex-plugin-runtime", "resources", "schemas")) && fs.existsSync(path.join(root, "packages", "codex-plugin-runtime", "resources", "contracts")));
console.log(`\nPlugin contract verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
