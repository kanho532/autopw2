import crypto from "node:crypto";
import { chromium, firefox, webkit, type Browser, type BrowserType } from "playwright";
import type { FixtureCase, FixturePlan, FixtureStep, FixtureVariant } from "@autopw/execution-fixture";
import type { ArtifactRef } from "@autopw/run-storage";
import { RunStorage } from "@autopw/run-storage";
import { BrowserNetworkGuard, redactSecrets } from "@autopw/security";

export type BrowserName = "chromium" | "firefox" | "webkit";
export interface ExecutionMatrix { browsers?: BrowserName[]; viewports?: { width: number; height: number }[]; locales?: string[]; auth_scope_ids?: string[]; }
export interface ExecutionResult { execution_id: string; case_id: string; batch_id: string; browser: BrowserName; viewport: { width: number; height: number }; locale: string; auth_scope_id: string; status: "PASSED" | "FAILED" | "BLOCKED_RESUME" | "INFRA_BLOCKED"; attempts: Record<string, unknown>[]; evidence_refs: ArtifactRef[]; at: string; error?: string; classification?: "PRODUCT_DEFECT" | "TEST_DEFECT" | "INFRA_DEFECT"; redaction_status?: "COMPLETE" | "INCOMPLETE"; }
export interface ExecutionManifest { batches: Record<string, unknown>[]; instances: Record<string, unknown>[]; }
export interface ExecutionOutcome { manifest: ExecutionManifest; results: ExecutionResult[]; evidence: Record<string, unknown>[]; }

export class PlaywrightFixtureRunner {
  async run({ runId, baseUrl, plan, variant, storage, allowedOrigins = [new URL(baseUrl).origin], matrix, tier = "fast" }: { runId: string; baseUrl: string; plan: FixturePlan; variant: FixtureVariant; storage: RunStorage; allowedOrigins?: string[]; matrix?: ExecutionMatrix; tier?: "smoke" | "fast" | "full" }): Promise<ExecutionOutcome> {
    const batches = buildBatches(matrix);
    const network = new BrowserNetworkGuard(allowedOrigins);
    const results: ExecutionResult[] = [];
    const evidence: Record<string, unknown>[] = [];
    const instances = batches.flatMap((batch) => plan.cases.map((item) => ({ execution_id: executionId(item.case_id, batch.batch_id), case_id: item.case_id, batch_id: batch.batch_id, status: "NOT_RUN" })));
    const batchRecords: Record<string, unknown>[] = [];
    for (const batch of batches) {
      const batchRecord = { ...batch, tier, case_ids: plan.cases.map((item) => item.case_id) };
      batchRecords.push(batchRecord);
      let browser: Browser | undefined;
      const completed = new Set<string>();
      try {
        browser = await browserType(batch.browser).launch({ headless: true });
        for (const item of plan.cases) {
          const id = executionId(item.case_id, batch.batch_id);
          if (variant === "incomplete" && item.case_id === "case_console_health") {
            const blocked = makeResult({ item, batch, status: "BLOCKED_RESUME", error: "fixture capability intentionally blocked" });
            results.push(blocked); completed.add(item.case_id); persistResult(storage, runId, blocked, evidence); continue;
          }
          const result = await this.runCase({ runId, baseUrl, item, variant, browser, batch, storage, network });
          results.push(result); completed.add(item.case_id); persistResult(storage, runId, result, evidence);
          if (id.length === 0) throw new Error("execution id generation failed");
        }
      } catch (error) {
        for (const item of plan.cases) if (!completed.has(item.case_id)) {
          const blocked = makeResult({ item, batch, status: "INFRA_BLOCKED", error: error instanceof Error ? error.message : String(error), classification: "INFRA_DEFECT" });
          results.push(blocked); persistResult(storage, runId, blocked, evidence);
        }
      } finally { if (browser) await browser.close().catch(() => undefined); }
    }
    for (const instance of instances) {
      const result = results.find((item) => item.execution_id === instance.execution_id);
      instance.status = result?.status || "INFRA_BLOCKED";
    }
    const manifest: ExecutionManifest = { batches: batchRecords, instances };
    storage.writeJson(runId, "execution-manifest.json", manifest);
    storage.writeJson(runId, "execution-results.json", results);
    const redactionComplete = results.every((result) => result.redaction_status !== "INCOMPLETE");
    storage.writeJson(runId, "evidence-manifest.json", { execution_id: results[0]?.execution_id || executionId("none", batches[0]?.batch_id || "none"), items: evidence, redacted: redactionComplete, redaction_status: redactionComplete ? "COMPLETE" : "INCOMPLETE" });
    return { manifest, results, evidence };
  }

  private async runCase({ runId, baseUrl, item, variant, browser, batch, storage, network }: { runId: string; baseUrl: string; item: FixtureCase; variant: FixtureVariant; browser: Browser; batch: MatrixBatch; storage: RunStorage; network: BrowserNetworkGuard }): Promise<ExecutionResult> {
    const execution_id = executionId(item.case_id, batch.batch_id);
    const context = await browser.newContext({ viewport: batch.viewport, locale: batch.locale, serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      try { await network.assertAllowedAsync(route.request().url()); await route.continue(); }
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
      return makeResult({ item, batch, execution_id, status: "PASSED", attempts: [{ at: new Date().toISOString() }], evidence_refs: evidenceRefs, redaction_status: "COMPLETE" });
    } catch (error) {
      const screenshot = await this.captureScreenshot(page).catch(() => Buffer.from([]));
      const redactionStatus = screenshot.length ? "COMPLETE" as const : "INCOMPLETE" as const;
      if (screenshot.length) evidenceRefs.push(storage.writeArtifact(runId, execution_id + ".png", "screenshot", screenshot));
      evidenceRefs.push(storage.writeArtifact(runId, execution_id + ".console.json", "console.json", JSON.stringify(redactSecrets({ errors: consoleErrors.map(redact), failed_requests: failedRequests.map(redact) }), null, 2)));
      return makeResult({ item, batch, execution_id, status: "FAILED", attempts: [{ at: new Date().toISOString() }], evidence_refs: evidenceRefs, error: redact(error instanceof Error ? error.message : String(error)), classification: redactionStatus === "INCOMPLETE" ? "INFRA_DEFECT" : "PRODUCT_DEFECT", redaction_status: redactionStatus });
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

interface MatrixBatch { batch_id: string; browser: BrowserName; viewport: { width: number; height: number }; locale: string; auth_scope_id: string; }
const DEFAULT_MATRIX: Required<ExecutionMatrix> = { browsers: ["chromium"], viewports: [{ width: 1280, height: 720 }], locales: ["en-US"], auth_scope_ids: ["as_demo"] };
function buildBatches(matrix: ExecutionMatrix | undefined): MatrixBatch[] {
  const value = { ...DEFAULT_MATRIX, ...(matrix || {}) };
  const batches: MatrixBatch[] = [];
  for (const browser of value.browsers) for (const viewport of value.viewports) for (const locale of value.locales) for (const auth_scope_id of value.auth_scope_ids) {
    const key = JSON.stringify({ browser, viewport, locale, auth_scope_id });
    batches.push({ batch_id: "BAT-" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 16), browser, viewport, locale, auth_scope_id });
  }
  return batches;
}
function browserType(name: BrowserName): BrowserType { return name === "firefox" ? firefox : name === "webkit" ? webkit : chromium; }
function executionId(caseId: string, batch: string): string { return "EXE-" + crypto.createHash("sha256").update(caseId + "|" + batch).digest("hex").slice(0, 16); }
function makeResult({ item, batch, execution_id = executionId(item.case_id, batch.batch_id), status, attempts = [], evidence_refs = [], error, classification, redaction_status }: { item: FixtureCase; batch: MatrixBatch; execution_id?: string; status: ExecutionResult["status"]; attempts?: Record<string, unknown>[]; evidence_refs?: ArtifactRef[]; error?: string; classification?: ExecutionResult["classification"]; redaction_status?: ExecutionResult["redaction_status"] }): ExecutionResult { return { execution_id, case_id: item.case_id, batch_id: batch.batch_id, browser: batch.browser, viewport: batch.viewport, locale: batch.locale, auth_scope_id: batch.auth_scope_id, status, attempts, evidence_refs, at: new Date().toISOString(), ...(error ? { error } : {}), ...(classification ? { classification } : {}), ...(redaction_status ? { redaction_status } : {}) }; }
function persistResult(storage: RunStorage, runId: string, result: ExecutionResult, evidence: Record<string, unknown>[]): void { storage.writeJson(runId, pathForCheckpoint(result.execution_id), { execution_id: result.execution_id, case_id: result.case_id, status: result.status, attempt: result.attempts.length, at: result.at }); evidence.push({ execution_id: result.execution_id, items: result.evidence_refs, redacted: result.redaction_status !== "INCOMPLETE", redaction_status: result.redaction_status || "COMPLETE" }); }
function pathForCheckpoint(executionIdValue: string): string { return "checkpoints/" + executionIdValue + ".json"; }
function redact(value: string): string { return value.replace(/([?&](?:token|secret|password|authorization|cookie)=)[^&\s]+/gi, "$1[REDACTED]").replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]").replace(/(password|secret|token)\s*[:=]\s*[^,\s]+/gi, "$1=[REDACTED]"); }
