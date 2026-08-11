import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv from "ajv";
import { chromium, firefox, webkit, type APIResponse, type Browser, type BrowserContext, type BrowserType, type Page } from "playwright";
import { assertValidPlan, fromFixturePlan, normalizePlan, resolveInterpolation, type EffectiveTier, type LocatorRef, type SemanticOperand, type TestCase, type TestPlan, type TestStep, type PlanValidationContext } from "@autopw/test-plan";
import type { FixturePlan, FixtureVariant } from "@autopw/execution-fixture";
import type { ArtifactRef } from "@autopw/run-storage";
import { RunStorage } from "@autopw/run-storage";
import { BrowserNetworkGuard, redactSecrets } from "@autopw/security";

export type BrowserName = "chromium" | "firefox" | "webkit";
export interface ExecutionMatrix { browsers?: BrowserName[]; viewports?: { width: number; height: number }[]; locales?: string[]; auth_scope_ids?: string[]; }
export interface ExecutionPathStep {
  step_index: number;
  phase: "setup" | "test" | "cleanup";
  action: string;
  locator_ref?: string;
  endpoint_ref?: string;
  input_summary?: unknown;
  output_summary?: unknown;
  value_redacted?: string;
  status: "PASSED" | "FAILED" | "SKIPPED" | "BLOCKED";
  started_at: string;
  ended_at: string;
  finished_at: string;
  duration_ms: number;
  error?: string;
  evidence_refs: ArtifactRef[];
}
export interface StepResult extends ExecutionPathStep { step_index: number; }
export interface ExecutionResult {
  execution_id: string; case_id: string; batch_id: string; browser: BrowserName;
  viewport: { width: number; height: number }; locale: string; auth_scope_id: string;
  status: "PASSED" | "FAILED" | "BLOCKED_RESUME" | "INFRA_BLOCKED";
  stability?: "STABLE" | "FLAKY";
  attempts: Record<string, unknown>[]; path: ExecutionPathStep[]; evidence_refs: ArtifactRef[]; at: string;
  cleanup_status?: "PASSED" | "FAILED" | "SKIPPED";
  error?: string; classification?: "PRODUCT_DEFECT" | "TEST_DEFECT" | "PLAN_DEFECT" | "INFRA_DEFECT"; redaction_status?: "COMPLETE" | "INCOMPLETE";
  failure_signal?: FailureSignal;
}
export interface FailureSignal { code: string; kind: "assertion" | "contract" | "network" | "timeout" | "policy" | "unknown"; phase: "setup" | "test" | "cleanup" | "unknown"; action?: string; expected?: unknown; actual?: unknown; }
export interface ExecutionManifest { batches: Record<string, unknown>[]; instances: Record<string, unknown>[]; }
export interface ExecutionOutcome { manifest: ExecutionManifest; results: ExecutionResult[]; evidence: Record<string, unknown>[]; }

export interface PlanRunnerOptions {
  runId: string;
  baseUrl: string;
  plan: TestPlan;
  storage: RunStorage;
  allowedOrigins?: string[];
  matrix?: ExecutionMatrix;
  tier?: EffectiveTier;
  trace?: boolean;
  planAuthority?: PlanValidationContext["authority"];
  production?: boolean;
  fixtureVariant?: FixtureVariant;
  blockedCaseIds?: Record<string, string>;
}
interface FixtureRunnerOptions {
  runId: string; baseUrl: string; plan: FixturePlan; variant: FixtureVariant; storage: RunStorage;
  allowedOrigins?: string[]; matrix?: ExecutionMatrix; tier?: EffectiveTier; trace?: boolean;
}

/** Executes the declarative TestPlan contract. It never evaluates plan-provided code. */
export class PlaywrightPlanRunner {
  async run(options: PlanRunnerOptions): Promise<ExecutionOutcome> {
    const authority = options.planAuthority || "untrusted";
    let plan: TestPlan;
    try { plan = fromNormalizedPlan(options.plan, authority); }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { classification: "TEST_DEFECT" as const }); }
    const requestedTier = options.tier || "fast";
    const selectedCases = selectCases(plan, requestedTier);
    const batches = buildBatches(options.matrix);
    const network = new BrowserNetworkGuard(options.allowedOrigins || [new URL(options.baseUrl).origin]);
    const results: ExecutionResult[] = [];
    const evidence: Record<string, unknown>[] = [];
    const batchRecords: Record<string, unknown>[] = [];
    const instances = batches.flatMap((batch) => selectedCases.map((item) => ({ execution_id: executionId(item.case_id, batch.batch_id), case_id: item.case_id, batch_id: batch.batch_id, status: "NOT_RUN" })));

    for (const batch of batches) {
      batchRecords.push({ ...batch, tier: requestedTier, case_ids: selectedCases.map((item) => item.case_id) });
      let browser: Browser | undefined;
      const completed = new Set<string>();
      try {
        browser = await browserType(batch.browser).launch({ headless: true });
        for (const item of selectedCases) {
          const blockedReason = options.blockedCaseIds?.[item.case_id];
          if (blockedReason) {
            const blocked = makeResult({ item, batch, status: "BLOCKED_RESUME", error: blockedReason, classification: "INFRA_DEFECT" });
            results.push(blocked); completed.add(item.case_id); persistResult(options.storage, options.runId, blocked, evidence); continue;
          }
          const result = await this.runCase({ ...options, plan, item, batch, browser, network });
          results.push(result); completed.add(item.case_id); persistResult(options.storage, options.runId, result, evidence);
        }
      } catch (error) {
        for (const item of selectedCases) if (!completed.has(item.case_id)) {
          const blocked = makeResult({ item, batch, status: "INFRA_BLOCKED", error: redact(errorMessage(error)), classification: "INFRA_DEFECT" });
          results.push(blocked); persistResult(options.storage, options.runId, blocked, evidence);
        }
      } finally { if (browser) await browser.close().catch(() => undefined); }
    }
    for (const instance of instances) instance.status = results.find((item) => item.execution_id === instance.execution_id)?.status || "INFRA_BLOCKED";
    const manifest: ExecutionManifest = { batches: batchRecords, instances };
    options.storage.writeJson(options.runId, "execution-manifest.json", manifest);
    options.storage.writeJson(options.runId, "execution-results.json", results);
    const redactionComplete = results.every((result) => result.redaction_status !== "INCOMPLETE");
    options.storage.writeJson(options.runId, "evidence-manifest.json", { execution_id: results[0]?.execution_id || executionId("none", batches[0]?.batch_id || "none"), items: evidence, redacted: redactionComplete, redaction_status: redactionComplete ? "COMPLETE" : "INCOMPLETE" });
    return { manifest, results, evidence };
  }

  private async runCase({ runId, baseUrl, plan, item, batch, browser, storage, network, trace: traceEnabled = true, fixtureVariant, production = false }: PlanRunnerOptions & { plan: TestPlan; item: TestCase; batch: MatrixBatch; browser: Browser; network: BrowserNetworkGuard }): Promise<ExecutionResult> {
    const retries = item.execution_policy.retries || 0;
    const attempts: Record<string, unknown>[] = [];
    let last: AttemptOutcome | undefined;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const started = Date.now();
      last = await this.runAttempt({ runId, baseUrl, plan, item, batch, browser, storage, network, traceEnabled, fixtureVariant, production, timeoutMs: item.execution_policy.timeout_ms });
      attempts.push({ attempt: attempt + 1, status: last.status, classification: last.classification, error: last.error, failure_signal: last.failure_signal, duration_ms: Date.now() - started });
      if (last.status === "PASSED") break;
    }
    if (!last) throw new Error("no execution attempt was made");
    const flaky = attempts.length > 1 && last.status === "PASSED" && attempts.slice(0, -1).some((item) => item.status !== "PASSED");
    const result = makeResult({ item, batch, status: last.status, attempts, path: last.path, evidence_refs: last.evidence_refs, error: last.error, classification: last.classification, failure_signal: last.failure_signal, redaction_status: last.redaction_status });
    result.cleanup_status = last.cleanup_status;
    if (flaky) result.stability = "FLAKY";
    storage.writeCaseJson(runId, item.case_id, "case.json", { case_id: item.case_id, title: item.title, feature_id: item.feature_id, kind: item.kind, risk: item.risk, requirement_refs: item.requirement_refs, execution_id: result.execution_id, status: result.status, stability: result.stability || "STABLE" });
    storage.writeCaseJson(runId, item.case_id, "execution.json", result);
    storage.writeCaseJson(runId, item.case_id, "steps.json", result.path);
    storage.writeCaseJson(runId, item.case_id, "path.json", result.path);
    return result;
  }

  private async runAttempt({ runId, baseUrl, plan, item, batch, browser, storage, network, traceEnabled, fixtureVariant, production, timeoutMs }: { runId: string; baseUrl: string; plan: TestPlan; item: TestCase; batch: MatrixBatch; browser: Browser; storage: RunStorage; network: BrowserNetworkGuard; traceEnabled: boolean; fixtureVariant?: FixtureVariant; production: boolean; timeoutMs?: number }): Promise<AttemptOutcome> {
    if (production && (!item.execution_policy.production_allowed || item.risk !== "read_only" || caseHasMutatingStep(item))) return { status: "FAILED", path: [], evidence_refs: [], error: "production policy forbids this case", classification: "TEST_DEFECT", redaction_status: "COMPLETE", cleanup_status: "SKIPPED" };
    const generatedPlan = item.origin?.type === "generated" || (item.origin === undefined && plan.origin.type === "generated");
    const context = await browser.newContext({ viewport: batch.viewport, locale: batch.locale, serviceWorkers: "block" });
    const deadline = timeoutMs ? Date.now() + timeoutMs : undefined;
    if (timeoutMs) { context.setDefaultTimeout(timeoutMs); context.setDefaultNavigationTimeout(timeoutMs); }
    const tracePath = traceEnabled && (item.kind === "ui" || item.kind === "hybrid") ? path.join(os.tmpdir(), `autopw-${executionId(item.case_id, batch.batch_id)}-${crypto.randomUUID()}.trace.zip`) : undefined;
    const scopes: Record<string, unknown> = { fixtures: plan.fixtures || {}, variables: {}, responses: {} };
    const pathResults: ExecutionPathStep[] = [];
    const evidenceRefs: ArtifactRef[] = [];
    const consoleErrors: string[] = [];
    let page: Page | undefined;
    let cleanupStatus: "PASSED" | "FAILED" | "SKIPPED" = "SKIPPED";
    let testFailure: Failure | undefined;
    let redactionStatus: "COMPLETE" | "INCOMPLETE" = "COMPLETE";
    try {
      if (tracePath) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      await context.route("**/*", async (route) => { try { await network.assertAllowedAsync(route.request().url()); await route.continue(); } catch { await route.abort("blockedbyclient"); } });
      page = await context.newPage();
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
      page.on("pageerror", (error) => consoleErrors.push(error.message));
      const runPhase = async (phase: "setup" | "test" | "cleanup", steps: TestStep[] | undefined, stopOnFailure: boolean): Promise<void> => {
        for (const step of steps || []) {
          const result = await this.runStep({ page: page!, context, step, phase, index: pathResults.length, baseUrl, scopes, network, storage, runId, caseId: item.case_id, consoleErrors, fixtureVariant, deadline, generatedPlan });
          pathResults.push(result.step);
          if (result.failure && stopOnFailure) throw result.failure;
        }
      };
      try { await runPhase("setup", item.setup, true); await runPhase("test", item.steps, true); }
      catch (error) { testFailure = isFailure(error) ? error : asFailure(error, undefined, generatedPlan); }
    } finally {
      try {
        if (page && item.cleanup) {
          // Start the cleanup budget when cleanup begins, not when the test attempt begins.
          const cleanupDeadline = timeoutMs === undefined ? undefined : Date.now() + Math.min(Math.max(timeoutMs, CLEANUP_TIMEOUT_FLOOR_MS), CLEANUP_TIMEOUT_CEILING_MS);
          try { await this.runCleanup({ page, context, steps: item.cleanup, pathResults, baseUrl, scopes, network, storage, runId, caseId: item.case_id, consoleErrors, fixtureVariant, deadline: cleanupDeadline, generatedPlan }); cleanupStatus = "PASSED"; }
          catch (error) { cleanupStatus = "FAILED"; if (!testFailure) testFailure = isFailure(error) ? error : asFailure(error, "cleanup", generatedPlan); }
        }
        if (page && (item.kind === "ui" || item.kind === "hybrid")) {
          try { evidenceRefs.push(storage.writeCaseArtifact(runId, item.case_id, "screenshot.png", "screenshot", await page.screenshot({ type: "png", fullPage: true, mask: [page.locator("input[type=password]"), page.locator("[data-secret], [data-sensitive]")], maskColor: "#000000" }))); }
          catch { redactionStatus = "INCOMPLETE"; }
          evidenceRefs.push(storage.writeCaseArtifact(runId, item.case_id, "console.json", "console.json", JSON.stringify(redactSecrets({ errors: consoleErrors }), null, 2)));
        }
      } finally {
        if (tracePath) {
          try { await context.tracing.stop({ path: tracePath }); if (fs.existsSync(tracePath)) evidenceRefs.push(storage.writeCaseArtifact(runId, item.case_id, "trace.zip", "playwright-trace", fs.readFileSync(tracePath))); }
          catch { redactionStatus = "INCOMPLETE"; }
          try { fs.rmSync(tracePath, { force: true }); } catch { /* best effort */ }
        }
        await context.close().catch((error) => { if (!testFailure) testFailure = asFailure(error, "context close", generatedPlan); });
      }
    }
    evidenceRefs.push(...pathResults.flatMap((step) => step.evidence_refs));
    const status = testFailure || cleanupStatus === "FAILED" ? "FAILED" : "PASSED";
    const failure = testFailure || (cleanupStatus === "FAILED" ? { error: "cleanup failed", classification: "TEST_DEFECT" as const, failure_signal: { code: "CLEANUP_FAILED", kind: "contract" as const, phase: "cleanup" as const } } : undefined);
    return { status, path: pathResults, evidence_refs: evidenceRefs, error: failure?.error, classification: failure?.classification, failure_signal: failure?.failure_signal, redaction_status: redactionStatus, cleanup_status: cleanupStatus };
  }

  private async runCleanup({ page, context, steps, pathResults, baseUrl, scopes, network, storage, runId, caseId, consoleErrors, fixtureVariant, deadline, generatedPlan }: { page: Page; context: BrowserContext; steps: TestStep[]; pathResults: ExecutionPathStep[]; baseUrl: string; scopes: Record<string, unknown>; network: BrowserNetworkGuard; storage: RunStorage; runId: string; caseId: string; consoleErrors: string[]; fixtureVariant?: FixtureVariant; deadline?: number; generatedPlan: boolean }): Promise<void> {
    let firstFailure: Failure | undefined;
    for (const step of steps) {
      const result = await this.runStep({ page, context, step, phase: "cleanup", index: pathResults.length, baseUrl, scopes, network, storage, runId, caseId, consoleErrors, fixtureVariant, deadline, generatedPlan });
      pathResults.push(result.step);
      if (result.failure && !firstFailure) firstFailure = result.failure;
    }
    if (firstFailure) throw firstFailure;
  }

  private async runStep({ page, context, step, phase, index, baseUrl, scopes, network, storage, runId, caseId, consoleErrors, fixtureVariant, deadline, generatedPlan }: StepContext): Promise<{ step: ExecutionPathStep; failure?: Failure }> {
    const started = Date.now(); const startedAt = new Date(started).toISOString();
    const record: ExecutionPathStep = { step_index: index, phase, action: step.action, ...("locator" in step && step.locator ? { locator_ref: JSON.stringify(step.locator) } : {}), status: "FAILED", started_at: startedAt, ended_at: startedAt, finished_at: startedAt, duration_ms: 0, evidence_refs: [] };
    try {
      assertDeadline(deadline);
      const resolved = resolveInterpolation(step, scopes) as TestStep;
      const output = await this.executeStep({ page, context, step: resolved, baseUrl, scopes, network, storage, runId, caseId, consoleErrors, fixtureVariant, deadline });
      assertDeadline(deadline);
      record.status = "PASSED"; record.output_summary = output.summary; if (output.endpoint_ref) record.endpoint_ref = output.endpoint_ref; if (output.evidence_refs) record.evidence_refs.push(...output.evidence_refs);
      record.ended_at = new Date().toISOString(); record.finished_at = record.ended_at; record.duration_ms = Date.now() - started; return { step: record };
    } catch (error) {
      record.error = redact(errorMessage(error)); record.ended_at = new Date().toISOString(); record.finished_at = record.ended_at; record.duration_ms = Date.now() - started;
      return { step: record, failure: classifyFailure(error, step.action, phase, generatedPlan) };
    }
  }

  private async executeStep({ page, context, step, baseUrl, scopes, network, storage, runId, caseId, consoleErrors, fixtureVariant, deadline }: ExecuteContext): Promise<{ summary?: unknown; endpoint_ref?: string; evidence_refs?: ArtifactRef[] }> {
    const withVariant = (value: string): string => value.replaceAll("{variant}", String(fixtureVariant || "pass"));
    const urlFor = (value: string): string => { const url = new URL(withVariant(value), baseUrl); network.assertAllowed(url.toString()); return url.toString(); };
    if (step.action === "goto") { await page.goto(urlFor(step.path), { waitUntil: "networkidle" }); return {}; }
    if (step.action === "reload") { await page.reload({ waitUntil: "networkidle" }); return {}; }
    if (step.action === "fill") { await locate(page, step.locator).fill(step.value); return { summary: { value: "[REDACTED]" } }; }
    if (step.action === "click") { await locate(page, step.locator).click(); return {}; }
    if (step.action === "select") { await locate(page, step.locator).selectOption(step.value); return {}; }
    if (step.action === "check") { await locate(page, step.locator).check(); return {}; }
    if (step.action === "uncheck") { await locate(page, step.locator).uncheck(); return {}; }
    if (step.action === "press") { await locate(page, step.locator).press(step.key); return {}; }
    if (step.action === "wait_for") { if (step.locator) await locate(page, step.locator).waitFor({ state: step.state || "visible", ...(step.timeout_ms !== undefined || deadline !== undefined ? { timeout: step.timeout_ms !== undefined ? Math.min(step.timeout_ms, remainingMs(deadline)) : remainingMs(deadline) } : {}) }); else await page.waitForTimeout(Math.min(step.timeout_ms || 50, remainingMs(deadline))); return {}; }
    if (step.action === "expect_visible" || step.action === "expect_hidden") { await locate(page, step.locator).waitFor({ state: step.action === "expect_visible" ? "visible" : "hidden", timeout: Math.min(1_500, remainingMs(deadline)) }); return {}; }
    if (step.action === "expect_text") { const text = await locate(page, step.locator).innerText(); if (step.equals !== undefined && text !== step.equals || step.contains !== undefined && !text.includes(step.contains)) throw new Error(`expect_text failed: ${JSON.stringify(text)}`); return { summary: { text: redactText(text) } }; }
    if (step.action === "expect_value") { const value = await locate(page, step.locator).inputValue(); if (value !== step.equals) throw new Error("expect_value failed"); return {}; }
    if (step.action === "expect_count") { const count = await locate(page, step.locator).count(); if (count !== step.equals) throw new Error(`expect_count failed: ${count}`); return { summary: { count } }; }
    if (step.action === "expect_url") { const actual = new URL(page.url()); const expected = new URL(withVariant(step.path), baseUrl); if (actual.pathname + actual.search + actual.hash !== expected.pathname + expected.search + expected.hash) throw new Error("expect_url failed"); return {}; }
    if (step.action === "expect_checked") { if (await locate(page, step.locator).isChecked() !== step.checked) throw new Error("expect_checked failed"); return {}; }
    if (step.action === "expect_no_console_errors") { if (consoleErrors.length) throw new Error("console error: " + consoleErrors.join(" | ")); return {}; }
    if (step.action === "set_variable") { (scopes.variables as Record<string, unknown>)[step.name] = step.value; return { summary: { name: step.name } }; }
    if (step.action === "capture_text") { (scopes.variables as Record<string, unknown>)[step.save_as] = await locate(page, step.locator).innerText(); return { summary: { name: step.save_as } }; }
    if (step.action === "capture_attribute") { (scopes.variables as Record<string, unknown>)[step.save_as] = await locate(page, step.locator).getAttribute(step.attribute); return { summary: { name: step.save_as } }; }
    if (step.action === "api_request") { const response = await apiRequest(context, urlFor(step.path), step, network, deadline); const value = await responseValue(response); if (step.save_as) (scopes.responses as Record<string, unknown>)[step.save_as] = value; const ref = storage.writeCaseArtifact(runId, caseId, `api-${Date.now()}-${crypto.randomUUID()}.json`, "api-response", JSON.stringify(redactSecrets(value), null, 2)); if (step.acceptable_statuses && !step.acceptable_statuses.includes(Number(value.status))) throw failureError(`api_request status ${value.status} is not acceptable`, "API_STATUS_UNACCEPTABLE", step.acceptable_statuses, value.status); return { endpoint_ref: step.path, evidence_refs: [ref], summary: { status: value.status, response_ref: ref.handle } }; }
    if (step.action === "expect_status") { const source = getSource(scopes, step.source); if (source.status !== step.equals) throw failureError("expect_status failed", "ASSERT_STATUS", step.equals, source.status); return {}; }
    if (step.action === "expect_header") { const source = getSource(scopes, step.source); const value = source.headers[String(step.name).toLowerCase()] || source.headers[step.name]; if (step.equals !== undefined && value !== step.equals || step.contains !== undefined && !String(value || "").includes(step.contains)) throw new Error("expect_header failed"); return {}; }
    if (step.action === "expect_json") { const source = getSource(scopes, step.source); const actual = jsonPath(source.body, step.path); if (step.exists !== undefined ? (step.exists !== (actual !== undefined)) : stableValue(actual) !== stableValue(step.equals)) throw new Error("expect_json failed"); return {}; }
    if (step.action === "expect_json_schema") { const source = getSource(scopes, step.source); validateJsonSchema(source.body, step.schema); return {}; }
    if (step.action === "expect_relation") { const left = semanticValue(step.left, scopes); const right = semanticValue(step.right, scopes); if (!relationMatches(left, step.operator, right)) throw failureError("expect_relation failed", "ASSERT_RELATION", { operator: step.operator, right }, left); return { summary: { operator: step.operator } }; }
    if (step.action === "expect_collection") { const source = getSource(scopes, step.source); const collection = step.path ? jsonPath(source.body, step.path) : source.body; if (!Array.isArray(collection)) throw failureError("expect_collection source is not an array", "ASSERT_COLLECTION_TYPE", "array", typeof collection); const matches = collection.map((item) => collectionMatches(item, step.predicate)); const passed = step.quantifier === "every" ? matches.every(Boolean) : step.quantifier === "some" ? matches.some(Boolean) : matches.every((item) => !item); if (!passed) throw failureError("expect_collection failed", "ASSERT_COLLECTION", { quantifier: step.quantifier, predicate: step.predicate }, { count: collection.length, matching: matches.filter(Boolean).length }); return { summary: { count: collection.length, quantifier: step.quantifier } }; }
    if (step.action === "capture_json") { const source = getSource(scopes, step.source); (scopes.variables as Record<string, unknown>)[step.save_as] = step.path ? jsonPath(source.body, step.path) : source.body; return { summary: { name: step.save_as } }; }
    throw Object.assign(new Error("unsupported TestPlan step: " + step.action), { code: "PLAN_STEP_UNSUPPORTED" });
  }

}

/** Compatibility adapter for the frozen M2 FixturePlan path. */
export class PlaywrightFixtureRunner extends PlaywrightPlanRunner {
  async run(options: PlanRunnerOptions | FixtureRunnerOptions): Promise<ExecutionOutcome> {
    if ("variant" in options) {
      const { runId, baseUrl, plan, variant, storage, allowedOrigins = [new URL(baseUrl).origin], matrix, tier = "fast", trace = false } = options;
      return super.run({ runId, baseUrl, plan: fromFixturePlan(plan), planAuthority: "migrated_fixture", fixtureVariant: variant, allowedOrigins, matrix, tier, trace, storage, blockedCaseIds: variant === "incomplete" ? { case_console_health: "fixture capability intentionally blocked" } : undefined });
    }
    return super.run(options);
  }
}

interface MatrixBatch { batch_id: string; browser: BrowserName; viewport: { width: number; height: number }; locale: string; auth_scope_id: string; }
interface StepContext { page: Page; context: BrowserContext; step: TestStep; phase: "setup" | "test" | "cleanup"; index: number; baseUrl: string; scopes: Record<string, unknown>; network: BrowserNetworkGuard; storage: RunStorage; runId: string; caseId: string; consoleErrors: string[]; fixtureVariant?: FixtureVariant; deadline?: number; generatedPlan: boolean; }
interface ExecuteContext { page: Page; context: BrowserContext; step: TestStep; baseUrl: string; scopes: Record<string, unknown>; network: BrowserNetworkGuard; storage: RunStorage; runId: string; caseId: string; consoleErrors: string[]; fixtureVariant?: FixtureVariant; deadline?: number; }
interface Failure { error: string; classification: "PRODUCT_DEFECT" | "TEST_DEFECT" | "PLAN_DEFECT" | "INFRA_DEFECT"; failure_signal: FailureSignal; }
interface AttemptOutcome { status: "PASSED" | "FAILED"; path: ExecutionPathStep[]; evidence_refs: ArtifactRef[]; error?: string; classification?: Failure["classification"]; failure_signal?: FailureSignal; redaction_status: "COMPLETE" | "INCOMPLETE"; cleanup_status: "PASSED" | "FAILED" | "SKIPPED"; }

const DEFAULT_MATRIX: Required<ExecutionMatrix> = { browsers: ["chromium"], viewports: [{ width: 1280, height: 720 }], locales: ["en-US"], auth_scope_ids: ["as_demo"] };
const CLEANUP_TIMEOUT_FLOOR_MS = 1_000;
const CLEANUP_TIMEOUT_CEILING_MS = 10_000;
function buildBatches(matrix: ExecutionMatrix | undefined): MatrixBatch[] { const value = { ...DEFAULT_MATRIX, ...(matrix || {}) }; const batches: MatrixBatch[] = []; for (const browser of value.browsers) for (const viewport of value.viewports) for (const locale of value.locales) for (const auth_scope_id of value.auth_scope_ids) { const key = JSON.stringify({ browser, viewport, locale, auth_scope_id }); batches.push({ batch_id: "BAT-" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 16), browser, viewport, locale, auth_scope_id }); } return batches; }
function browserType(name: BrowserName): BrowserType { return name === "firefox" ? firefox : name === "webkit" ? webkit : chromium; }
function executionId(caseId: string, batch: string): string { return "EXE-" + crypto.createHash("sha256").update(caseId + "|" + batch).digest("hex").slice(0, 16); }
function makeResult({ item, batch, status, attempts = [], path = [], evidence_refs = [], error, classification, failure_signal, redaction_status }: { item: TestCase; batch: MatrixBatch; status: ExecutionResult["status"]; attempts?: Record<string, unknown>[]; path?: ExecutionPathStep[]; evidence_refs?: ArtifactRef[]; error?: string; classification?: ExecutionResult["classification"]; failure_signal?: FailureSignal; redaction_status?: ExecutionResult["redaction_status"] }): ExecutionResult { return { execution_id: executionId(item.case_id, batch.batch_id), case_id: item.case_id, batch_id: batch.batch_id, browser: batch.browser, viewport: batch.viewport, locale: batch.locale, auth_scope_id: batch.auth_scope_id, status, attempts, path, evidence_refs, at: new Date().toISOString(), ...(error ? { error } : {}), ...(classification ? { classification } : {}), ...(failure_signal ? { failure_signal } : {}), ...(redaction_status ? { redaction_status } : {}) }; }
function persistResult(storage: RunStorage, runId: string, result: ExecutionResult, evidence: Record<string, unknown>[]): void { storage.writeJson(runId, "checkpoints/" + result.execution_id + ".json", { execution_id: result.execution_id, case_id: result.case_id, status: result.status, attempt: result.attempts.length, path: result.path, at: result.at }); evidence.push({ execution_id: result.execution_id, items: result.evidence_refs, redacted: result.redaction_status !== "INCOMPLETE", redaction_status: result.redaction_status || "COMPLETE" }); }
function fromNormalizedPlan(plan: TestPlan, authority: PlanValidationContext["authority"]): TestPlan { const copy = JSON.parse(JSON.stringify(plan)) as TestPlan; assertValidPlan(copy, { authority }); return normalizePlan(copy, { authority }); }
function locate(page: Page, locator: LocatorRef) { if (locator.by === "role") return page.getByRole(locator.role as any, locator.name === undefined ? {} : { name: locator.name, exact: locator.exact }); if (locator.by === "label") return page.getByLabel(locator.text); if (locator.by === "test_id") return page.getByTestId(locator.value); if (locator.by === "text") return page.getByText(locator.text, { exact: locator.exact }); if (locator.by === "id") return page.locator("#" + locator.value); return page.locator(locator.value); }
const MAX_API_REDIRECTS = 5;
/**
 * Maximum payload accepted after Playwright's API transport has completed.
 * This is an assertion/evidence boundary, not a streaming transport memory cap.
 */
export const MAX_ACCEPTED_API_RESPONSE_BYTES = 1_048_576;
const SENSITIVE_REDIRECT_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
async function apiRequest(context: BrowserContext, url: string, step: Extract<TestStep, { action: "api_request" }>, network: BrowserNetworkGuard, deadline?: number): Promise<APIResponse> {
  let currentUrl = url;
  let method = step.method;
  let data: unknown = step.body;
  let headers = step.headers;
  for (let redirect = 0; redirect <= MAX_API_REDIRECTS; redirect += 1) {
    assertDeadline(deadline);
    await network.assertAllowedAsync(currentUrl);
    const response = await context.request.fetch(currentUrl, { method, headers, data, maxRedirects: 0, ...(deadline ? { timeout: remainingMs(deadline) } : {}) });
    if (response.status() < 300 || response.status() >= 400) return response;
    const location = response.headers().location;
    if (!location) throw Object.assign(new Error("redirect response has no Location header"), { code: "API_REDIRECT_INVALID" });
    if (redirect === MAX_API_REDIRECTS) throw Object.assign(new Error("API redirect limit exceeded"), { code: "API_REDIRECT_LIMIT" });
    const nextUrl = new URL(location, currentUrl).toString();
    if (new URL(nextUrl).origin !== new URL(currentUrl).origin) headers = stripSensitiveRedirectHeaders(headers);
    currentUrl = nextUrl;
    await network.assertAllowedAsync(currentUrl);
    if (response.status() === 303 || ((response.status() === 301 || response.status() === 302) && method === "POST")) { method = "GET"; data = undefined; }
  }
  throw Object.assign(new Error("API redirect limit exceeded"), { code: "API_REDIRECT_LIMIT" });
}
function stripSensitiveRedirectHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const filtered = Object.fromEntries(Object.entries(headers).filter(([name]) => !SENSITIVE_REDIRECT_HEADERS.has(name.toLowerCase())));
  return Object.keys(filtered).length ? filtered : undefined;
}
async function responseValue(response: APIResponse): Promise<Record<string, unknown>> {
  const headers = response.headers();
  const bytes = await response.body();
  if (bytes.byteLength > MAX_ACCEPTED_API_RESPONSE_BYTES) throw Object.assign(new Error(`API response exceeds ${MAX_ACCEPTED_API_RESPONSE_BYTES} accepted-payload limit`), { code: "API_RESPONSE_TOO_LARGE" });
  const text = bytes.toString("utf8");
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* text body */ }
  return { status: response.status(), ok: response.ok(), url: response.url(), headers, body };
}
function getSource(scopes: Record<string, unknown>, source: unknown): Record<string, any> { const value = source && typeof source === "object" ? source : typeof source === "string" && source.startsWith("${") ? resolveInterpolation(source, scopes) : typeof source === "string" && source.startsWith("$") ? lookup(scopes.responses, source.slice(1)) : typeof source === "string" && source.startsWith("responses.") ? lookup(scopes.responses, source.slice("responses.".length)) : lookup(scopes.responses, String(source)); if (!value || typeof value !== "object") throw Object.assign(new Error("response source is undefined: " + String(source)), { code: "PLAN_VARIABLE_UNDEFINED" }); return value as Record<string, any>; }
function lookup(scope: unknown, expression: string): unknown { let value = scope; for (const part of expression.replace(/^\$\{?/, "").replace(/\}?$/, "").split(".").filter(Boolean)) { if (!value || typeof value !== "object" || !(part in (value as Record<string, unknown>))) throw Object.assign(new Error("undefined variable: " + expression), { code: "PLAN_VARIABLE_UNDEFINED" }); value = (value as Record<string, unknown>)[part]; } return value; }
function jsonPath(value: unknown, expression: string): unknown { return expression.split(".").filter(Boolean).reduce<unknown>((current, part) => { const match = part.match(/^(.+)\[(\d+)\]$/); if (match) return Array.isArray(current) ? current[Number(match[2])] : undefined; return current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined; }, value); }
function semanticValue(operand: SemanticOperand, scopes: Record<string, unknown>): unknown {
  if ("literal" in operand) return operand.literal;
  if ("sum" in operand) return operand.sum.reduce((total, item) => total + Number(semanticValue(item, scopes)), 0);
  const source = getSource(scopes, operand.source);
  const value = operand.path?.startsWith("$response.") ? jsonPath(source, operand.path.slice("$response.".length)) : operand.path ? jsonPath(source.body, operand.path.replace(/^body\./, "")) : source.body;
  if (operand.aggregate === "length") return Array.isArray(value) || typeof value === "string" ? value.length : undefined;
  if (operand.aggregate === "sum") return Array.isArray(value) ? value.reduce((total, item) => total + Number(item), 0) : undefined;
  return value;
}
function relationMatches(left: unknown, operator: string, right: unknown): boolean { if (operator === "equals") return stableValue(left) === stableValue(right); if (operator === "not_equals") return stableValue(left) !== stableValue(right); if (operator === "greater_than") return Number(left) > Number(right); if (operator === "greater_or_equal") return Number(left) >= Number(right); if (operator === "less_than") return Number(left) < Number(right); return Number(left) <= Number(right); }
function collectionMatches(item: unknown, predicate: { path: string; operator: string; value?: unknown }): boolean { const actual = predicate.path ? jsonPath(item, predicate.path) : item; if (predicate.operator === "exists") return actual !== undefined; if (predicate.operator === "equals") return stableValue(actual) === stableValue(predicate.value); return String(actual ?? "").includes(String(predicate.value ?? "")); }
function stableValue(value: unknown): string { return JSON.stringify(value, Object.keys((value && typeof value === "object" && !Array.isArray(value)) ? value as object : {}).sort()); }
const JSON_SCHEMA_VALIDATOR = new Ajv({ allErrors: true, strict: false });
function validateJsonSchema(value: unknown, schema: unknown): void {
  let validate: ReturnType<typeof JSON_SCHEMA_VALIDATOR.compile>;
  try { validate = JSON_SCHEMA_VALIDATOR.compile(schema as object); }
  catch (error) { throw Object.assign(new Error("invalid JSON Schema: " + errorMessage(error)), { code: "PLAN_SCHEMA_INVALID" }); }
  if (!validate(value)) throw Object.assign(new Error("expect_json_schema failed: " + JSON_SCHEMA_VALIDATOR.errorsText(validate.errors)), { code: "JSON_SCHEMA_ASSERTION_FAILED" });
}
function classifyFailure(error: unknown, action?: string, phase?: "setup" | "test" | "cleanup" | string, generatedPlan = false): Failure {
  const message = redact(errorMessage(error));
  const code = (error as { code?: string })?.code || "UNKNOWN_FAILURE";
  const normalizedPhase: FailureSignal["phase"] = phase === "setup" || phase === "test" || phase === "cleanup" ? phase : "unknown";
  const details = error as { expected?: unknown; actual?: unknown };
  const contract = ["PLAN_VARIABLE_UNDEFINED", "PLAN_STEP_UNSUPPORTED", "PLAN_SCHEMA_INVALID", "CASE_TIMEOUT"].includes(code) || /invalid TestPlan/i.test(message);
  const network = code === "SAFETY_POLICY_VIOLATION" || /net::|network|blockedbyclient|ERR_|target closed|browser.*closed/i.test(message);
  const timeout = /timeout.*exceeded|timed out/i.test(message);
  const assertion = code.startsWith("ASSERT_") || code === "API_STATUS_UNACCEPTABLE" || code === "JSON_SCHEMA_ASSERTION_FAILED" || /^expect_/i.test(action || "") || /expect_|status failed|header failed|json failed|console error/i.test(message);
  const failure_signal: FailureSignal = { code, kind: network ? "network" : timeout ? "timeout" : contract ? "contract" : assertion ? "assertion" : code.includes("POLICY") ? "policy" : "unknown", phase: normalizedPhase, ...(action ? { action } : {}), ...(Object.hasOwn(details, "expected") ? { expected: details.expected } : {}), ...(Object.hasOwn(details, "actual") ? { actual: details.actual } : {}) };
  if (network) return { error: message, classification: "INFRA_DEFECT", failure_signal };
  if (assertion && normalizedPhase === "test" && !generatedPlan) return { error: message, classification: "PRODUCT_DEFECT", failure_signal };
  return { error: message, classification: generatedPlan ? "PLAN_DEFECT" : "TEST_DEFECT", failure_signal };
}
function isFailure(error: unknown): error is Failure { return Boolean(error && typeof error === "object" && typeof (error as Failure).error === "string" && typeof (error as Failure).classification === "string"); }
function asFailure(error: unknown, phase?: string, generatedPlan = false): Failure { return classifyFailure(error, undefined, phase, generatedPlan); }
function failureError(message: string, code: string, expected: unknown, actual: unknown): Error { return Object.assign(new Error(message), { code, expected, actual }); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function redact(value: string): string { return value.replace(/([?&](?:token|secret|password|authorization|cookie)=)[^&\s]+/gi, "$1[REDACTED]").replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]").replace(/(password|secret|token)\s*[:=]\s*[^,\s]+/gi, "$1=[REDACTED]"); }
function redactText(value: string): string { return redact(value).slice(0, 2_000); }
function selectCases(plan: TestPlan, tier: EffectiveTier): TestCase[] { if (plan.origin.type === "migrated") return plan.cases; const limit = tierRank(tier); return plan.cases.filter((item) => tierRank(item.effective_tier) <= limit); }
function caseHasMutatingStep(item: TestCase): boolean { const mutatingActions = new Set(["fill", "click", "select", "check", "uncheck", "press"]); return [...(item.setup || []), ...item.steps, ...(item.cleanup || [])].some((step) => step.action === "api_request" ? ["POST", "PUT", "PATCH", "DELETE"].includes(step.method) : mutatingActions.has(step.action)); }
function tierRank(tier: EffectiveTier): number { return tier === "smoke" ? 1 : tier === "fast" ? 2 : 3; }
function remainingMs(deadline?: number): number { return deadline === undefined ? Number.MAX_SAFE_INTEGER : Math.max(1, deadline - Date.now()); }
function assertDeadline(deadline?: number): void { if (deadline !== undefined && Date.now() >= deadline) throw Object.assign(new Error("case execution timeout exceeded"), { code: "CASE_TIMEOUT" }); }
