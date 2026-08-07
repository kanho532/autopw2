import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const todo = await import(pathToFileURL(path.join(root, "apps", "todo-fixture-target", "dist", "index.js")).href);
let passed = 0;
let failed = 0;
function check(name, value, detail = "") { if (value) { passed += 1; console.log("PASS", name, detail ? "(" + detail + ")" : ""); } else { failed += 1; console.log("FAIL", name, detail); } }
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "tools", "test-external-app.mjs"), ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      let output;
      try { output = JSON.parse(stdout); } catch { output = {}; }
      resolve({ status, signal, stdout, stderr, output });
    });
  });
}

const target = await todo.startTodoTarget();
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m9.9-"));
try {
  const common = ["--target", path.join(root, "apps", "todo-fixture-target"), "--url", target.baseUrl, "--tier", "full", "--browser", "chromium", "--data-root", dataRoot];
  const automatic = await runCli(common);
  check("m9.9-external-auto-exits-pass", automatic.status === 0 && automatic.output.gate === "pass", automatic.stderr || automatic.output.message || "");
  check("m9.9-external-auto-uses-external-target", automatic.output.audit_status === "COMPLETE" && automatic.output.plan_mode === "auto", automatic.output.message || "");
  check("m9.9-external-latest-and-reports-exist", Boolean(automatic.output.run_id) && fs.existsSync(path.join(dataRoot, "latest.json")) && fs.existsSync(automatic.output.report_path) && fs.existsSync(automatic.output.results_path), automatic.output.message || "");
  if (!automatic.output.run_id) throw new Error("external CLI did not return a run_id: " + automatic.stdout + automatic.stderr);
  const generatedPlan = path.join(dataRoot, "manual-plan.json");
  fs.copyFileSync(path.join(dataRoot, "runs", automatic.output.run_id, "plan.json"), generatedPlan);
  const replaced = await runCli([...common, "--plan", generatedPlan, "--plan-mode", "replace"]);
  check("m9.9-external-replace-plan", replaced.status === 0 && replaced.output.gate === "pass" && replaced.output.plan_mode === "replace");
  const overlaid = await runCli([...common, "--plan", generatedPlan, "--plan-mode", "overlay"]);
  check("m9.9-external-overlay-plan", overlaid.status === 0 && overlaid.output.gate === "pass" && overlaid.output.plan_mode === "overlay");
  check("m9.9-external-plan-source-is-persisted", fs.existsSync(path.join(dataRoot, "runs", overlaid.output.run_id, "plan-source.json")));
  const weakPlan = path.join(dataRoot, "weak-manual-plan.json");
  const weak = JSON.parse(fs.readFileSync(generatedPlan, "utf8"));
  for (const item of weak.cases) item.steps = item.steps.filter((step) => !step.action.startsWith("expect_"));
  fs.writeFileSync(weakPlan, JSON.stringify(weak, null, 2));
  const laundered = await runCli([...common, "--plan", weakPlan, "--plan-mode", "replace"]);
  check("m9.9-external-manual-plan-cannot-launder-oracle", laundered.output.gate === "incomplete" && laundered.output.audit_status === "INCOMPLETE");
} finally {
  await target.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

console.log("\nM9.9 external verify: " + passed + " passed, " + failed + " failed");
if (failed) process.exitCode = 1;
