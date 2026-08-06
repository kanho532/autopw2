import { chromium } from "playwright";
import type { FixtureCase, FixturePlan, FixtureStep, FixtureVariant } from "@autopw/execution-fixture";
import type { ArtifactRef } from "@autopw/run-storage";
import { RunStorage } from "@autopw/run-storage";
import { BrowserNetworkGuard, redactSecrets } from "@autopw/security";

export interface ExecutionResult { execution_id: string; case_id: string; status: "PASSED" | "FAILED" | "BLOCKED_RESUME"; attempts: Record<string, unknown>[]; evidence_refs: ArtifactRef[]; at: string; error?: string; classification?: "PRODUCT_DEFECT" | "TEST_DEFECT" | "INFRA_DEFECT"; redaction_status?: "COMPLETE" | "INCOMPLETE"; }
export interface ExecutionManifest { batches: Record<string, unknown>[]; instances: Record<string, unknown>[]; }
export interface ExecutionOutcome { manifest: ExecutionManifest; results: ExecutionResult[]; evidence: Record<string, unknown>[]; }

export class PlaywrightFixtureRunner {
  async run({ runId, baseUrl, plan, variant, storage, allowedOrigins = [new URL(baseUrl).origin] }: { runId: string; baseUrl: string; plan: FixturePlan; variant: FixtureVariant; storage: RunStorage; allowedOrigins?: string[] }): Promise<ExecutionOutcome> {
    const browser = await chromium.launch({ headless: true });
    const network = new BrowserNetworkGuard(allowedOrigins);
    const results: ExecutionResult[] = [];
    const evidence: Record<string, unknown>[] = [];
    const instances = plan.cases.map((item) => ({ execution_id: executionId(item.case_id), case_id: item.case_id, batch_id: batchId(), status: "NOT_RUN" }));
    const batch = { batch_id: String(instances[0]?.batch_id || batchId()), tier: "fast", browser: "chromium", viewport: { width: 1280, height: 720 }, locale: "en-US", auth_scope_id: "as_demo" };
    try {
      for (const item of plan.cases) {
        if (variant === "incomplete" && item.case_id === "case_console_health") {
          const blocked = { execution_id: executionId(item.case_id), case_id: item.case_id, status: "BLOCKED_RESUME" as const, attempts: [], evidence_refs: [], at: new Date().toISOString(), error: "fixture capability intentionally blocked" };
          results.push(blocked);
          storage.writeJson(runId, pathForCheckpoint(blocked.execution_id), { execution_id: blocked.execution_id, case_id: blocked.case_id, status: blocked.status, attempt: 0, at: blocked.at });
          continue;
        }
        const result = await this.runCase({ runId, baseUrl, item, variant, browser, storage, network });
        results.push(result);
        storage.writeJson(runId, pathForCheckpoint(result.execution_id), { execution_id: result.execution_id, case_id: result.case_id, status: result.status, attempt: result.attempts.length, at: result.at });
        evidence.push({ execution_id: result.execution_id, items: result.evidence_refs, redacted: result.redaction_status !== "INCOMPLETE", redaction_status: result.redaction_status || "COMPLETE" });
      }
    } finally { await browser.close(); }
    for (const instance of instances) {
      const result = results.find((item) => item.execution_id === instance.execution_id);
      instance.status = result?.status || "BLOCKED_RESUME";
    }
    const manifest: ExecutionManifest = { batches: [batch], instances };
    storage.writeJson(runId, "execution-manifest.json", manifest);
    storage.writeJson(runId, "execution-results.json", results);
    const redactionComplete = results.every((result) => result.redaction_status !== "INCOMPLETE");
    storage.writeJson(runId, "evidence-manifest.json", { execution_id: results[0]?.execution_id || executionId("none"), items: evidence, redacted: redactionComplete, redaction_status: redactionComplete ? "COMPLETE" : "INCOMPLETE" });
    return { manifest, results, evidence };
  }

  private async runCase({ runId, baseUrl, item, variant, browser, storage, network }: { runId: string; baseUrl: string; item: FixtureCase; variant: FixtureVariant; browser: Awaited<ReturnType<typeof chromium.launch>>; storage: RunStorage; network: BrowserNetworkGuard }): Promise<ExecutionResult> {
    const execution_id = executionId(item.case_id);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US", serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      try { network.assertAllowed(route.request().url()); await route.continue(); }
      catch { await route.abort("blockedbyclient"); }
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("requestfailed", (request) => failedRequests.push(request.url()));
    const evidenceRefs: ArtifactRef[] = [];
    try {
      for (const step of item.steps) await this.executeStep(page, step, baseUrl, variant, consoleErrors);
      const screenshot = await this.captureScreenshot(page);
      evidenceRefs.push(storage.writeArtifact(runId, execution_id + ".png", "screenshot", screenshot));
      const consoleRef = storage.writeArtifact(runId, execution_id + ".console.json", "console.json", JSON.stringify(redactSecrets({ errors: consoleErrors.map(redact), failed_requests: failedRequests.map(redact) }), null, 2));
      evidenceRefs.push(consoleRef);
      return { execution_id, case_id: item.case_id, status: "PASSED", attempts: [{ at: new Date().toISOString() }], evidence_refs: evidenceRefs, at: new Date().toISOString(), redaction_status: "COMPLETE" };
    } catch (error) {
      const screenshot = await this.captureScreenshot(page).catch(() => Buffer.from([]));
      const redactionStatus = screenshot.length ? "COMPLETE" as const : "INCOMPLETE" as const;
      if (screenshot.length) evidenceRefs.push(storage.writeArtifact(runId, execution_id + ".png", "screenshot", screenshot));
      evidenceRefs.push(storage.writeArtifact(runId, execution_id + ".console.json", "console.json", JSON.stringify(redactSecrets({ errors: consoleErrors.map(redact), failed_requests: failedRequests.map(redact) }), null, 2)));
      return { execution_id, case_id: item.case_id, status: "FAILED", attempts: [{ at: new Date().toISOString() }], evidence_refs: evidenceRefs, at: new Date().toISOString(), error: redact(error instanceof Error ? error.message : String(error)), classification: redactionStatus === "INCOMPLETE" ? "INFRA_DEFECT" : "PRODUCT_DEFECT", redaction_status: redactionStatus };
    } finally { await context.close(); }
  }

  private async captureScreenshot(page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>): Promise<Buffer> {
    return page.screenshot({ type: "png", fullPage: true, mask: [page.locator("input[type=password]"), page.locator("[data-secret], [data-sensitive]")], maskColor: "#000000" });
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
function pathForCheckpoint(executionIdValue: string): string { return "checkpoints/" + executionIdValue + ".json"; }
function redact(value: string): string { return value.replace(/([?&](?:token|secret|password|authorization|cookie)=)[^&\s]+/gi, "$1[REDACTED]").replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]").replace(/(password|secret|token)\s*[:=]\s*[^,\s]+/gi, "$1=[REDACTED]"); }
