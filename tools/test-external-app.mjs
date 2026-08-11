import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printUsage();
  process.exitCode = 0;
} else {
  try {
    const result = await runExternal(options);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.exit_code;
  } catch (error) {
    const code = error?.code || "OPERATIONAL_ERROR";
    process.stdout.write(JSON.stringify({ ok: false, code, message: error?.message || String(error) }) + "\n");
    process.exitCode = code.startsWith("INVALID_") || code === "MISSING_ARGUMENT" ? 64 : 70;
  }
}

async function runExternal(options) {
  if (!options.target || !options.url) throw Object.assign(new Error("--target and --url are required"), { code: "MISSING_ARGUMENT" });
  const targetRoot = path.resolve(options.target);
  if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) throw new Error("target directory does not exist: " + targetRoot);
  const targetUrl = new URL(options.url);
  if (!["http:", "https:"].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password) throw Object.assign(new Error("--url must be an http(s) URL without credentials"), { code: "INVALID_TARGET_URL" });
  const tier = options.tier || "fast";
  if (!["smoke", "fast", "full"].includes(tier)) throw Object.assign(new Error("--tier must be smoke, fast or full"), { code: "INVALID_TIER" });
  const browser = options.browser || "chromium";
  if (!["chromium", "firefox", "webkit"].includes(browser)) throw Object.assign(new Error("--browser must be chromium, firefox or webkit"), { code: "INVALID_BROWSER" });
  const planMode = options["plan-mode"] || "auto";
  if (!["auto", "overlay", "replace"].includes(planMode)) throw Object.assign(new Error("--plan-mode must be auto, overlay or replace"), { code: "INVALID_PLAN_MODE" });
  const outputRoot = path.resolve(options.out || options["data-root"] || path.join(targetRoot, ".autopw2"));
  const dataRoot = path.resolve(options["data-root"] || outputRoot);
  const testPlan = await import(pathToFileURL(path.join(root, "packages", "test-plan", "dist", "index.js")).href);
  const manualPlan = options.plan ? testPlan.loadPlanFile(path.resolve(options.plan), { authority: "trusted_manual" }) : undefined;
  if (planMode === "auto" && manualPlan) throw Object.assign(new Error("--plan requires --plan-mode overlay or replace"), { code: "INVALID_PLAN_MODE" });
  if (planMode !== "auto" && !manualPlan) throw Object.assign(new Error("--plan is required for overlay or replace mode"), { code: "INVALID_PLAN_MODE" });
  const profile = readProfile(options.profile);
  const core = await import(pathToFileURL(path.join(root, "packages", "core", "dist", "index.js")).href);
  const runtime = new core.AuditVerticalSlice({
    root: targetRoot,
    dataRoot,
    targetProvider: new core.ExternalTargetProvider(targetUrl.toString()),
    engineModes: { plan_engine: "declarative" }
  });
  const runId = "run_external_" + Date.now().toString(36) + "_" + process.pid;
  const run = {
    run_id: runId,
    operation_id: "op_external_" + Date.now().toString(36),
    workspace_id: "external",
    phase: "CREATED",
    run_status: "ACTIVE",
    audit_status: null,
    gate: null,
    fatal_class: null,
    progress_pct: 0,
    next_action: "run"
  };
  const request = {
    project_subpath: ".",
    profile_path: options.profile || "profiles/default/profile.json",
    tier,
    base_tier: tier,
    plan_mode: planMode,
    __manual_plan: manualPlan,
    __target_url: targetUrl.toString(),
    __allowed_origins: [targetUrl.origin],
    __trust_snapshot: { allowed_origins: [targetUrl.origin], workspace_id: "external", workspace_root: targetRoot },
    __gate_policy: profile.gate || {},
    matrix: { browsers: [browser], viewports: [{ width: 1280, height: 720 }], locales: ["en-US"], auth_scope_ids: ["as_demo"] }
  };
  const result = await runtime.execute({ run, request, onPhase: () => undefined });
  const latest = {
    schema_version: "2.1",
    run_id: runId,
    target_root: targetRoot,
    target_url: targetUrl.origin,
    plan_mode: planMode,
    gate: result.gate,
    audit_status: result.audit_status,
    report: {
      markdown: path.join("runs", runId, "artifacts", "report.md"),
      html: path.join("runs", runId, "artifacts", "report.html"),
      results: path.join("runs", runId, "artifacts", "results.json"),
      run: path.join("runs", runId)
    }
  };
  writeAtomic(path.join(outputRoot, "latest.json"), latest);
  return { ...latest, output_root: outputRoot, report_path: path.join(dataRoot, "runs", runId, "artifacts", "report.md"), results_path: path.join(dataRoot, "runs", runId, "artifacts", "results.json"), exit_code: result.gate === "pass" ? 0 : result.gate === "fail" || result.gate === "unstable" ? 1 : 2 };
}

function readProfile(file) {
  const resolved = path.resolve(file || path.join(root, "profiles", "default", "profile.json"));
  if (!fs.existsSync(resolved)) return { gate: { strategy: "product", min_p0_coverage_pct: 100 } };
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (value.startsWith("--")) result[value.slice(2)] = argv[index + 1];
  }
  return result;
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp." + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, file);
}

function printUsage() {
  process.stdout.write("Usage: node tools/test-external-app.mjs --target <project-path> --url <base-url> [--plan <plan.json>] [--plan-mode auto|overlay|replace] [--tier smoke|fast|full] [--data-root <path>] [--browser chromium|firefox|webkit]\n");
}
