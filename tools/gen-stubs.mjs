import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname.replace(/\\/g,"/").replace(/\/tools$/,""));
const noBom = new TextEncoder();
function wj(p, o){ fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n"); }
const stubs = [
 "control-plane","worker","core","run-storage","operation-registry","discovery",
 "derivation","planner","compiler","execution-fixture","execution","audit",
 "reporting","gate","security","maintenance-cli"
];
for (const n of stubs) {
  wj(path.join(root, "packages", n, "package.json"), {
    name: "@autopw/" + n,
    version: "2.1.0-rc5.mcp-first",
    private: true,
    type: "module",
    main: "src/index.ts",
    description: "AutoPW " + n + " (Phase 0 stub — not implemented in M0)."
  });
  fs.writeFileSync(path.join(root, "packages", n, "src", "index.ts"),
    "// AutoPW " + n + " — Phase 0 stub.\n// Not implemented in M0 (MCP Contract Frozen). See tools/verify-m0.mjs and docs/M0-milestone-report.md.\nexport const PACKAGE = \"@autopw/" + n + "\";\nexport const PHASE0_STUB = true;\n", "utf8");
}
wj(path.join(root, "apps", "demo-target", "package.json"), {
  name: "@autopw/demo-target",
  version: "2.1.0-rc5.mcp-first",
  private: true,
  description: "Local demo target app for deterministic baseline runs (Phase 0 placeholder)."
});
console.log("stubs done:", stubs.length, "+ demo-target");