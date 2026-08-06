// verify:m0 — Milestone M0 acceptance verifier.
// Forces the 10 mandatory M0 checks from the milestone plan section 0.5, plus the
// canonical Data Schema Bundle parity and the lease safe-window safety factor.
// Exits 0 only when every check passes; otherwise prints a failure summary.
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
async function load(rel) { return import(pathToFileURL(path.join(root, rel)).href); }

const common = await load("packages/schemas/src/common.mjs");
const schemasMod = await load("packages/schemas/src/schemas.mjs");
const toolsMod = await load("packages/mcp-contracts/src/tools.mjs");
const hostMod = await load("packages/mcp-contracts/src/host-context.mjs");
const fixMod = await load("packages/mcp-contracts/src/fixtures.mjs");
const enumMod = await load("packages/schemas/src/enums.mjs");
const limitMod = await load("packages/schemas/src/limits.mjs");
const smMod = await load("packages/schemas/src/state-machine.mjs");

const { buildCommonSchema, ref } = common;
const { buildSchemas } = schemasMod;
const { buildToolContracts, TOOL_NAMES } = toolsMod;
const { HOST_CONTEXT_CONTRACT } = hostMod;
const { PERSISTENT_FIXTURES, HOST_CONTEXT_FIXTURES, TRANSITION_FIXTURES } = fixMod;
const { ENUMS, ENUM_KEYS, RUN_PHASE, GATE_PRIORITY } = enumMod;
const { LIMITS } = limitMod;
const { TRANSITIONS, NORMAL_PATH, BRANCH_AFTER, TERMINAL_PHASE, LEASE_WINDOW } = smMod;

// Canonical Data Schema Bundle from spec section 0.2C (39 persistents).
const CANONICAL_SCHEMAS = [
 "mcp-error-envelope","mcp-tool-common-request","mcp-operation","mcp-run-handle",
 "mcp-status-view","mcp-result-view","profile","coverage-policy","route-map",
 "scenario-contract","normalized-request","host-context-snapshot","input-versions",
 "run-state","operation-record","retention-policy","artifact-tombstone","target-result",
 "seed-result","discovery","derivation","planner-input","planner-output","plan-template",
 "plan","mapping-audit","execution-manifest","execution-result","event","checkpoint",
 "evidence-manifest","issues","terminalization","finalization-result","completion-audit",
 "gate-draft","results","failure","cleanup-result"
];

const only = process.argv.includes("--check") ? process.argv[process.argv.indexOf("--check") + 1] : "all";
// Subcommand grouping: verify:m0 runs all; npm run contract|schema:test|docs:check run a subset.
const GROUPS = {
  contract: ["01-", "05-", "09-"],
  schema:   ["02-", "03-", "06-", "07-", "custom-canonical", "custom-gate", "custom-lease"],
  docs:     ["04-", "08-", "10-"]
};
const checks = [];
let passed = 0, failed = 0;
function check(name, cond, detail) {
  const want = only === "all" || (GROUPS[only] ? GROUPS[only].some(function(p){return name.startsWith(p);}) : name.startsWith(only));
  if (!want) return;
  checks.push({ name, ok: !!cond, detail: detail || "" });
  if (cond) passed++; else failed++;
}

// ---- build ajv with the full schema registry ----
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);
const commonSchema = buildCommonSchema();
ajv.addSchema(commonSchema, commonSchema.$id);
const S = buildSchemas();
for (const schema of Object.values(S)) ajv.addSchema(schema, schema.$id);

// helper: compile a standalone subschema (strip $id with fragment if present)
function compileSub(schema) {
  const copy = JSON.parse(JSON.stringify(schema));
  delete copy.$id;
  return ajv.compile(copy);
}

// ---- Check 3: all Schema references resolvable ----
let refsOK = true; const refErrors = [];
try {
  for (const schema of Object.values(S)) { ajv.getSchema(schema.$id); }
  // compile each tool input + result variants to exercise $refs
  const T = buildToolContracts();
  for (const tname of TOOL_NAMES) {
    const t = T[tname];
    try { compileSub(t.input_schema); } catch (e) { refsOK = false; refErrors.push(tname + " input: " + e.message); }
    for (const r of t.result_union) {
      try { compileSub(r); } catch (e) { refsOK = false; refErrors.push(tname + " result: " + e.message); }
    }
  }
} catch (e) { refsOK = false; refErrors.push(String(e.message || e)); }
check("03-schema-refs-resolvable", refsOK, refErrors.join("; ") || "all $refs resolve against common $defs");

// ---- Check 1: all Tool examples pass Tool Schema ----
{
  const T = buildToolContracts();
  let ok = true; const errs = [];
  for (const tname of TOOL_NAMES) {
    const t = T[tname];
    const vIn = compileSub(t.input_schema);
    for (const req of (t.examples.request || [])) {
      if (!vIn(req)) { ok = false; errs.push(tname + " request example invalid: " + ajv.errorsText(vIn.errors)); }
    }
    const variants = {};
    for (const r of t.result_union) { if (r.$ref) continue; variants[r.properties.kind.const] = compileSub(r); }
    const errValidator = ajv.getSchema(ref.schema("mcp-error-envelope"));
    for (const r of (t.examples.ok || [])) {
      const v = variants[r.kind];
      if (!v) { ok = false; errs.push(tname + " ok example has unknown kind " + r.kind); continue; }
      if (!v(r)) { ok = false; errs.push(tname + " ok example invalid: " + ajv.errorsText(v.errors)); }
    }
    for (const r of (t.examples.error || [])) {
      if (!errValidator(r)) { ok = false; errs.push(tname + " error example invalid: " + ajv.errorsText(errValidator.errors)); }
    }
  }
  check("01-tool-examples-pass-schema", ok, errs.join("; ") || "all tool request/ok/error examples validate");
}

// ---- Check 5: each Tools error path has examples ----
{
  const T = buildToolContracts(); let ok = true; const errs = [];
  for (const tname of TOOL_NAMES) {
    const e = T[tname].examples.error;
    if (!e || e.length === 0) { ok = false; errs.push(tname + " missing error example"); }
  }
  check("05-tool-error-path-examples", ok, errs.join("; ") || "every tool has >=1 error-path example");
}

// ---- Check 2: all persistent JSON examples pass corresponding Schema ----
{
  let ok = true; const errs = [];
  for (const [name, fix] of Object.entries(PERSISTENT_FIXTURES)) {
    const v = ajv.getSchema(ref.schema(name));
    if (!v) { ok = false; errs.push(name + " schema not found"); continue; }
    for (const p of (fix.positive || [])) { if (!v(p)) { ok = false; errs.push(name + " positive should pass: " + ajv.errorsText(v.errors)); } }
    for (const n of (fix.negative || [])) { if (v(n)) { ok = false; errs.push(name + " negative should fail but passed"); } }
  }
  check("02-persistent-examples-pass-schema", ok, errs.join("; ") || "all positives pass, all negatives fail");
}

// ---- Check 6: each persistent file has a unique Schema ----
{
  const ids = Object.values(S).map((s) => s.$id);
  const dup = ids.length !== new Set(ids).size;
  let fixMatch = true; const fmErrs = [];
  // each fixtures file references a schema $id that exists
  for (const name of Object.keys(PERSISTENT_FIXTURES)) {
    if (!S[name]) { fixMatch = false; fmErrs.push(name + " fixture without matching schema"); }
  }
  check("06-unique-schema-per-persistent", !dup && fixMatch, dup ? "duplicate $id(s)" : (fmErrs.join("; ") || "unique $ids; fixtures map 1:1 to schemas"));
}

// ---- Check 7: workspace/path/ID length + format limits fixed ----
{
  let ok = true; const errs = [];
  const idKeys = ["workspaceId","projectSubpath","clientRequestId","operationId","runId","handleToken","caseId","executionId","batchId","featureId"];
  for (const k of idKeys) {
    const l = LIMITS[k];
    if (!l) { ok = false; errs.push(k + " limit missing"); continue; }
    if (typeof l.max !== "number" || l.max <= 0) { ok = false; errs.push(k + " max not positive"); }
    if (typeof l.pattern !== "string" || l.pattern.length === 0) { ok = false; errs.push(k + " pattern empty"); }
  }
  // numeric limits finite/positive where present (skip non-object entries like schemaVersionPattern)
  for (const [k, l] of Object.entries(LIMITS)) { if (typeof l !== "object" || l === null) continue;
    if ("max" in l && (typeof l.max !== "number" || !isFinite(l.max))) { ok = false; errs.push(k + " max not finite"); }
    if ("min" in l && (typeof l.min !== "number" || !isFinite(l.min) || l.min < 0)) { ok = false; errs.push(k + " min invalid"); }
  }
  check("07-id-format-length-limits-fixed", ok, errs.join("; ") || "all id/format limits positive and finite");
}

// ---- Check 8: no undefined transitions in state table ----
{
  let ok = true; const errs = [];
  const set = new Set(RUN_PHASE);
  for (const t of TRANSITIONS) {
    if (!set.has(t.from)) { ok = false; errs.push("from " + t.from + " undefined"); }
    if (!set.has(t.to)) { ok = false; errs.push("to " + t.to + " undefined"); }
  }
  // every normal-path phase reachable from CREATED
  const reach = new Set(["CREATED"]);
  let changed = true;
  while (changed) { changed = false; for (const t of TRANSITIONS) if (reach.has(t.from) && t.type === "normal" && !reach.has(t.to)) { reach.add(t.to); changed = true; } }
  for (const p of NORMAL_PATH) if (!reach.has(p)) { ok = false; errs.push(p + " unreachable"); }
  // terminal phase has no outbound
  if (TRANSITIONS.some((t) => t.from === TERMINAL_PHASE)) { ok = false; errs.push("terminal " + TERMINAL_PHASE + " must have no outbound"); }
  // branch allowed only from BRANCH_AFTER
  for (const t of TRANSITIONS) if (t.type === "branch" && !BRANCH_AFTER.includes(t.from)) { ok = false; errs.push("branch from " + t.from + " not allowed"); }
  // post-final phases cannot branch
  for (const t of TRANSITIONS) if (t.type === "branch" && ["TERMINALIZING","RUNTIME_FINALIZED","AUDITED","REPORTED","GATED"].includes(t.from)) { ok = false; errs.push("branch forbidden from " + t.from); }
  // transition fixtures: valid ones in table, invalid ones not
  const tablePairs = new Set(TRANSITIONS.map((t) => t.from + ">" + t.to));
  for (const [f, to] of TRANSITION_FIXTURES.valid) { if (!tablePairs.has(f + ">" + to)) { ok = false; errs.push("valid fixture " + f + ">" + to + " not in table"); } }
  for (const [f, to] of TRANSITION_FIXTURES.invalid) { if (tablePairs.has(f + ">" + to)) { ok = false; errs.push("invalid fixture " + f + ">" + to + " must not be in table"); } }
  check("08-no-undefined-transitions", ok, errs.join("; ") || "transition table is closed and matches fixtures");
}

// ---- Check 9: tool params cannot elevate trust/auth/network ----
{
  const T = buildToolContracts(); let ok = true; const errs = [];
  const forbidden = ["trust_mode"]; // host-only; must never be a settable tool input
  for (const tname of TOOL_NAMES) {
    const props = T[tname].input_schema.properties || {};
    for (const fk of forbidden) {
      if (Object.prototype.hasOwnProperty.call(props, fk)) { ok = false; errs.push(tname + " must not declare input " + fk); }
    }
    // auth_scope_id may be present ONLY as a narrowing reference (string), not an elevation
    if (props.auth_scope_id) {
      const ps = props.auth_scope_id;
      const descOK = typeof ps.description === "string" && /reference/i.test(ps.description);
      if (ps.type !== "string" || !descOK) { ok = false; errs.push(tname + " auth_scope_id must be a string reference descriptor"); }
    }
  }
  // host-context contract must force deny_symlink_escape const true + untrusted_pr config from base/fixed
  const hc = HOST_CONTEXT_CONTRACT.$defs.WorkspaceAuthorization.properties.deny_symlink_escape;
  if (!(hc.const === true)) { ok = false; errs.push("host context must const true deny_symlink_escape"); }
  // negative host-context fixture (agent elevate trust_mode) must fail the contract
  const v = ajv.compile(HOST_CONTEXT_CONTRACT);
  if (v(HOST_CONTEXT_FIXTURES.negative_agent_elevate)) { ok = false; errs.push("agent-elevate host context must be rejected"); }
  if (!v(HOST_CONTEXT_FIXTURES.positive_trusted)) { ok = false; errs.push("trusted host context should validate: " + ajv.errorsText(v.errors)); }
  if (!v(HOST_CONTEXT_FIXTURES.positive_untrusted_pr)) { ok = false; errs.push("untrusted_pr host context should validate: " + ajv.errorsText(v.errors)); }
  check("09-tool-params-cannot-elevate", ok, errs.join("; ") || "no tool widens trust/auth/network; host context narrows only");
}

// ---- Check 10: CLI not in main user workflow or audit path ----
{
  const cliManifest = JSON.parse(fs.readFileSync(path.join(root, "packages", "maintenance-cli", "commands.json"), "utf8"));
  const forbidden = ["audit", "orchestrate", "run_audit", "derive_coverage", "compile_suite", "execute_batch", "commit_gate"];
  let ok = true; const errs = [];
  for (const cmd of cliManifest.commands) {
    if (forbidden.includes(cmd.name)) { ok = false; errs.push("CLI exposes orchestration command " + cmd.name); }
  }
  // maintenance CLI must only contain maintenance verbs
  const allowed = ["doctor", "server", "run_status", "run_resume", "run_cancel", "run_cleanup", "profile_validate", "schema_verify"];
  for (const cmd of cliManifest.commands) {
    if (!allowed.includes(cmd.name)) { ok = false; errs.push("CLI has non-maintenance command " + cmd.name); }
  }
  // MCP manifest must include the audit entry tools
  const mcpManifest = JSON.parse(fs.readFileSync(path.join(root, "packages", "mcp-contracts", "contracts", "manifest.json"), "utf8"));
  for (const t of ["run_audit", "derive_coverage"]) {
    if (!mcpManifest.tools.includes(ref.tool(t))) { ok = false; errs.push("MCP manifest missing " + t); }
  }
  check("10-cli-not-in-main-path", ok, errs.join("; ") || "CLI is maintenance-only; MCP is the audit entry");
}

// ---- Check 4: same enum consistent across docs, Schema and generated types ----
{
  let ok = true; const errs = [];
  // docs: enums-table.json
  const table = JSON.parse(fs.readFileSync(path.join(root, "packages", "schemas", "enums-table.json"), "utf8"));
  for (const k of ENUM_KEYS) {
    if (JSON.stringify(table.enums[k]) !== JSON.stringify(ENUMS[k])) { ok = false; errs.push("enums-table mismatch for " + k); }
  }
  // types: enums.ts literals match ENUMS
  const ts = fs.readFileSync(path.join(root, "packages", "mcp-contracts", "src", "types", "enums.ts"), "utf8");
  for (const k of ENUM_KEYS) {
    const re = new RegExp("export const " + k + " = \\s*\\[([^\\]]*)\\]");
    const m = ts.match(re);
    if (!m) { ok = false; errs.push("enums.ts missing " + k); continue; }
    const literals = m[1].split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/^"|"$/g, "").replace(/^'/, "").replace(/'$/, ""));
    if (JSON.stringify(literals) !== JSON.stringify(ENUMS[k])) { ok = false; errs.push("enums.ts mismatch for " + k); }
  }
  // schema: common.schema.json enum $defs match ENUMS
  const commonFile = JSON.parse(fs.readFileSync(path.join(root, "packages", "schemas", "schemas", "common.schema.json"), "utf8"));
  for (const k of ENUM_KEYS) {
    if (JSON.stringify(commonFile.$defs.enum[k].enum) !== JSON.stringify(ENUMS[k])) { ok = false; errs.push("common.schema enum mismatch for " + k); }
  }
  check("04-enum-consistency", ok, errs.join("; ") || "enums identical across docs table, schema $defs and TS types");
}

// ---- Canonical Data Schema Bundle parity ----
{
  let ok = true; const errs = [];
  const have = new Set(Object.keys(S));
  for (const n of CANONICAL_SCHEMAS) if (!have.has(n)) { ok = false; errs.push("missing canonical schema " + n); }
  if (Object.keys(S).length !== CANONICAL_SCHEMAS.length) { ok = false; errs.push("schema count mismatch: have " + Object.keys(S).length + " want " + CANONICAL_SCHEMAS.length); }
  check("custom-canonical-schema-bundle", ok, errs.join("; ") || "all " + CANONICAL_SCHEMAS.length + " canonical schemas present");
}

// ---- Fixed gate priority ----
{
  const order = ["incomplete", "infra", "fail", "unstable", "pass"];
  check("custom-gate-priority-fixed", JSON.stringify(GATE_PRIORITY) === JSON.stringify(order), "gate priority fixed incomplete>infra>fail>unstable>pass");
}

// ---- Lease safe-window safety factor ----
{
  const L = LEASE_WINDOW;
  const safe = L.ttl_ms_min >= 3 * (L.heartbeat_max_ms) && L.takeover_confirm_min_ms >= (L.heartbeat_max_ms + L.clock_skew_max_ms);
  check("custom-lease-safe-window", safe, "ttl>=3*heartbeat && takeover>=heartbeat+skew (lease safe factor holds)");
}

// ---- report ----
for (const c of checks) console.log((c.ok ? "PASS" : "FAIL") + "  " + c.name + (c.detail ? "  (" + c.detail + ")" : ""));
console.log("\nM0 verify: " + passed + " passed, " + failed + " failed");
if (failed > 0) {
  console.log("BLOCKED — M0 contract not frozen; resolve failures above (do not hand-patch).");
  process.exit(1);
}
console.log("OK — M0 MCP Contract Frozen acceptance met.");
process.exit(0);
