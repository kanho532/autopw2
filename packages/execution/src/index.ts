import { chromium } from "playwright";
import type { FixtureCase, FixturePlan, FixtureStep, FixtureVariant } from "@autopw/execution-fixture";
import type { ArtifactRef } from "@autopw/run-storage";
import { RunStorage } from "@autopw/run-storage";

export interface ExecutionResult { execution_id: string; case_id: string; status: "PASSED" | "FAILED" | "BLOCKED_RESUME"; attempts: Record<string, unknown>[]; evidence_refs: ArtifactRef[]; at: string; error?: string; classification?: "PRODUCT_DEFECT" | "TEST_DEFECT" | "INFRA_DEFECT"; }
export interface ExecutionManifest { batches: Record<string, unknown>[]; instances: Record<string, unknown>[]; }
export interface ExecutionOutcome { manifest: ExecutionManifest; results: ExecutionResult[]; evidence: Record<string, unknown>[]; }

export class PlaywrightFixtureRunner {
  async run({ runId, baseUrl, plan, variant, storage }: { runId: string; baseUrl: string; plan: FixturePlan; variant: FixtureVariant; storage: RunStorage }): Promise<ExecutionOutcome> {
    const browser = await chromium.launch({ headless: true });
    const results: ExecutionResult[] = [];
    const evidence: Record<string, unknown>[] = [];
    const instances = plan.cases.map((item) => ({ execution_id: executionId(item.case_id), case_id: item.case_id, batch_id: batchId(), status: "NOT_RUN" }));
    const batch = { batch_id: String(instances[0]?.batch_id || batchId()), tier: "fast", browser: "chromium", viewport: { width: 1280, height: 720 }, locale: "en-US", auth_scope_id: "as_demo" };
    try {
      for (const item of plan.cases) {
        if (variant === "incomplete" && item.case_id === "case_console_health") {
          results.push({ execution_id: executionId(item.case_id), case_id: item.case_id, status: "BLOCKED_RESUME", attempts: [], evidence_refs: [], at: new Date().toISOString(), error: "fixture capability intentionally blocked" });
          continue;
        }
        const result = await this.runCase({ runId, baseUrl, item, variant, browser, storage });
        results.push(result);
        evidence.push({ execution_id: result.execution_id, items: result.evidence_refs, redacted: true });
      }
    } finally { await browser.close(); }
    for (const instance of instances) {
      const result = results.find((item) => item.execution_id === instance.execution_id);
      instance.status = result?.status || "BLOCKED_RESUME";
    }
    const manifest: ExecutionManifest = { batches: [batch], instances };
    storage.writeJson(runId, "execution-manifest.json", manifest);
    storage.writeJson(runId, "execution-results.json", results);
    storage.writeJson(runId, "evidence-manifest.json", { execution_id: results[0]?.execution_id || executionId("none"), items: evidence, redacted: true });
    return { manifest, results, evidence };
  }

  private async runCase({ runId, baseUrl, item, variant, browser, storage }: { runId: string; baseUrl: string; item: FixtureCase; variant: FixtureVariant; browser: Awaited<ReturnType<typeof chromium.launch>>; storage: RunStorage }): Promise<ExecutionResult> {
    const execution_id = executionId(item.case_id);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("requestfailed", (request) => failedRequests.push(request.url()));
    const evidenceRefs: ArtifactRef[] = [];
    try {
      for (const step of item.steps) await this.executeStep(page, step, baseUrl, variant, consoleErrors);
      const screenshot = await page.screenshot({ type: "png", fullPage: true });
      evidenceRefs.push(storage.writeArtifact(runId, execution_id + ".png", "screenshot", screenshot));
      const consoleRef = storage.writeArtifact(runId, execution_id + ".console.json", "console.json", JSON.stringify({ errors: consoleErrors, failed_requests: failedRequests }, null, 2));
      evidenceRefs.push(consoleRef);
      return { execution_id, case_id: item.case_id, status: "PASSED", attempts: [{ at: new Date().toISOString() }], evidence_refs: evidenceRefs, at: new Date().toISOString() };
    } catch (error) {
      const screenshot = await page.screenshot({ type: "png", fullPage: true }).catch(() => Buffer.from([]));
      if (screenshot.length) evidenceRefs.push(storage.writeArtifact(runId, execution_id + ".png", "screenshot", screenshot));
      evidenceRefs.push(storage.writeArtifact(runId, execution_id + ".console.json", "console.json", JSON.stringify({ errors: consoleErrors, failed_requests: failedRequests }, null, 2)));
      return { execution_id, case_id: item.case_id, status: "FAILED", attempts: [{ at: new Date().toISOString() }], evidence_refs: evidenceRefs, at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), classification: "PRODUCT_DEFECT" };
    } finally { await context.close(); }
  }

  private async executeStep(page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>, step: FixtureStep, baseUrl: string, variant: FixtureVariant, consoleErrors: string[]): Promise<void> {
    if (step.action === "goto") { await page.goto(baseUrl + step.path.replace("{variant}", variant), { waitUntil: "networkidle" }); return; }
    if (step.action === "fill") { await page.locator(step.selector).fill(step.value); return; }
    if (step.action === "click") { await page.locator(step.selector).click(); return; }
    if (step.action === "expect_visible") { await page.locator(step.selector).waitFor({ state: "visible", timeout: 1500 }); return; }
    if (step.action === "expect_no_console_errors" && consoleErrors.length > 0) throw new Error("console error: " + consoleErrors.join(" | "));
  }
}

function executionId(caseId: string): string { return "EXE-" + Buffer.from(caseId).toString("hex").padEnd(16, "0").slice(0, 16); }
function batchId(): string { return "BAT-" + "m2fixture0000000".slice(0, 16); }
