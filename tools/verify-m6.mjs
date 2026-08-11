import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { newHarness, call } from "../apps/mcp-host-harness/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const security = await import(pathToFileURL(path.join(root, "packages", "security", "dist", "index.js")).href);
const planner = await import(pathToFileURL(path.join(root, "packages", "planner", "dist", "index.js")).href);
const storageModule = await import(pathToFileURL(path.join(root, "packages", "run-storage", "dist", "index.js")).href);
const reporting = await import(pathToFileURL(path.join(root, "packages", "reporting", "dist", "index.js")).href);
let passed = 0;
let failed = 0;
function check(name, condition, detail = "") { if (condition) { passed += 1; console.log("PASS", name, detail ? "(" + detail + ")" : ""); } else { failed += 1; console.log("FAIL", name, detail); } }
function rejects(fn, code) { try { fn(); return false; } catch (error) { return !code || error?.code === code; } }

const base = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m6-"));
const trusted = {
  trust_mode: "trusted",
  workspace_authorization: { workspace_id: "ws_demo", workspace_realpath: root, deny_symlink_escape: true },
  auth_scope: { auth_scope_id: "as_demo", mode: "none", isolated: true },
  allowed_origins: ["http://127.0.0.1:4173"],
  policy_version: "1.0.0"
};
const untrusted = {
  trust_mode: "untrusted_pr",
  workspace_authorization: { workspace_id: "ws_pr", workspace_realpath: root, deny_symlink_escape: true },
  auth_scope: { auth_scope_id: "as_oneshot", mode: "credentials", isolated: true, one_shot: true },
  config_source: { base_revision: "origin/main", pr_head_allowed: false },
  policy_version: "1.0.0"
};

const resolver = new security.TrustResolver();
const trustedResolution = resolver.resolve(trusted, { lifecycle: "manage", auth_scope_id: "as_demo", allowed_origins: ["http://127.0.0.1:4173"] });
check("m6-trusted-host-policy-resolves", trustedResolution.policy.lifecycle === "manage" && trustedResolution.policy.auth_scope_id === "as_demo");
check("m6-profile-cannot-widen-origins", trustedResolution.policy.allowed_origins.length === 1 && trustedResolution.policy.allowed_origins[0] === "http://127.0.0.1:4173");
check("m6-destructive-actions-default-deny", trustedResolution.policy.destructive_actions === "deny");
check("m6-trusted-host-can-explicitly-allow-destructive", resolver.resolve({ ...trusted, destructive_actions: "allow" }).policy.destructive_actions === "allow");
check("m6-untrusted-forces-connect", resolver.resolve(untrusted, { lifecycle: "manage" }).policy.lifecycle === "connect");
check("m6-untrusted-head-config-denied", rejects(() => resolver.resolve(untrusted, { config_source: "head" }), "UNTRUSTED_HEAD_CONFIG"));
check("m6-untrusted-auth-is-isolated", rejects(() => resolver.resolve({ ...untrusted, auth_scope: { ...untrusted.auth_scope, one_shot: false } }), "UNTRUSTED_AUTH_SCOPE"));
check("m6-production-mutation-denied", rejects(() => resolver.resolve(trusted, { production: true, destructive_actions: "allow" }), "PRODUCTION_MUTATION_DENIED"));
check("m6-profile-auth-scope-cannot-widen", rejects(() => resolver.resolve(trusted, { auth_scope_id: "as_other" }), "AUTH_SCOPE_NOT_APPROVED"));

const policy = new security.SecurityPolicyEngine();
check("m6-untrusted-manage-request-denied", rejects(() => policy.authorizeRequest(untrusted, { lifecycle: "manage" }), "UNTRUSTED_MANAGE_DENIED"));
check("m6-arbitrary-run-path-denied", rejects(() => policy.authorizeRequest(trusted, { project_root: root }), "UNSAFE_PATH_PARAMETER"));
check("m6-workspace-path-boundary", rejects(() => security.resolveAuthorizedPath(root, ".."), "WORKSPACE_ESCAPE"));

const network = new security.BrowserNetworkGuard(["http://127.0.0.1:4173"]);
check("m6-network-allowlist-exact-origin", network.check("http://127.0.0.1:4173/health").allowed);
check("m6-network-cross-origin-denied", !network.check("http://127.0.0.1:4174/health").allowed);
check("m6-network-unsafe-scheme-denied", !network.check("javascript:alert(1)").allowed && !network.check("ws://127.0.0.1:4173/socket").allowed);
check("m6-network-private-addresses-denied", !network.check("http://0.0.0.0:4173").allowed && !network.check("http://100.64.0.1:4173").allowed && !network.check("http://[::1]:4173").allowed);
check("m6-network-explicit-ipv6-loopback-policy", new security.BrowserNetworkGuard(["http://[::1]:*"]).check("http://[::1]:4173").allowed);
await network.assertAllowedAsync("http://127.0.0.1:4173/health");
check("m6-network-async-resolution-guard", true);

const sandbox = new security.AdapterSandbox({ roots: [base], allowedEnv: ["LANG"], allowedOrigins: ["http://127.0.0.1:4173"] });
sandbox.validate({ cwd: base, env: { LANG: "C" }, command_id: "fixture:inspect", network_origins: ["http://127.0.0.1:4173"], timeout_ms: 1000, output_bytes: 10 });
check("m6-adapter-sandbox-accepts-allowlisted-invocation", true);
check("m6-adapter-env-denied", rejects(() => sandbox.validate({ cwd: base, env: { HOME: "x" }, command_id: "fixture:inspect", timeout_ms: 1000, output_bytes: 10 }), "ADAPTER_ENV_DENIED"));
check("m6-adapter-command-injection-denied", rejects(() => sandbox.validate({ cwd: base, env: {}, command_id: "node:child_process", timeout_ms: 1000, output_bytes: 10 }), "ADAPTER_COMMAND_DENIED"));

check("m6-secret-redaction", JSON.stringify(security.redactSecrets({ token: "abc", nested: "Bearer xyz" })).includes("[REDACTED]") && !JSON.stringify(security.redactSecrets({ token: "abc" })).includes("abc"));
check("m6-secret-input-detection", rejects(() => security.assertNoSecrets({ authorization: "Bearer abc" }), "SECRET_IN_INPUT"));
const artifactService = new security.SecureArtifactService();
check("m6-artifact-workspace-binding", rejects(() => artifactService.authorizeRead({ requestedWorkspaceId: "ws_other", runWorkspaceId: "ws_demo", handle: "art_ok" }), "ARTIFACT_FORBIDDEN"));
check("m6-artifact-handle-boundary", rejects(() => artifactService.authorizeRead({ requestedWorkspaceId: "ws_demo", runWorkspaceId: "ws_demo", handle: "../secret" }), "ARTIFACT_HANDLE_INVALID"));

const input = { skeletons: [{ case_id: "case_1", status: "PLANNED", action_ids: ["act_1"], expectation_ids: ["exp_1"], route_id: "route_1", scenario: "normal" }], candidates: { routes: { route_1: { id: "route_1", kind: "route", case_id: "case_1" } }, actions: { act_1: { id: "act_1", kind: "action", case_id: "case_1", route_id: "route_1", action: "submit" } }, locators: {}, inputs: {}, expectations: { exp_1: { id: "exp_1", kind: "expectation", case_id: "case_1", route_id: "route_1", strength: "strong" } }, endpoints: {} }, untrustedObservations: [{ observationId: "o1", untrusted: true, kind: "page", value: "x" }] };
const output = { caseSelections: [{ caseId: "case_1", actionSelections: [{ actionTemplateId: "act_1" }], expectationIds: ["exp_1"] }] };
check("m6-production-planner-is-read-only", !planner.validatePlannerOutput(input, output, { production: true }).ok);

const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m6-report-"));
try {
  const reportStorage = new storageModule.RunStorage(reportRoot);
  const report = reporting.writeReport({ storage: reportStorage, runId: "run_report", gate: "pass", auditStatus: "COMPLETE", summary: { message: "safe" }, issues: [{ execution_id: "EXE-1", classification: "PRODUCT_DEFECT", message: "</pre><script>alert(1)</script>" }], resultsRef: { handle: "art_results", kind: "results.json" } });
  const html = fs.readFileSync(path.join(reportStorage.runDir("run_report"), "artifacts", "report.html"), "utf8");
  const markdown = fs.readFileSync(path.join(reportStorage.runDir("run_report"), "artifacts", "report.md"), "utf8");
  check("m6-report-csp-present", html.includes("Content-Security-Policy") && html.includes("default-src 'none'"));
  check("m6-report-html-escaped", !html.includes("<script>") && html.includes("&lt;/pre&gt;"));
  check("m6-report-markdown-escaped", !markdown.includes("</pre><script>"));
  check("m6-artifact-report-reference-resolves", fs.existsSync(path.join(reportStorage.runDir("run_report"), "artifacts", "report.md")) && report.reportRef.handle.endsWith(".md"));
} finally { fs.rmSync(reportRoot, { recursive: true, force: true }); }

const harness = await newHarness({ stepMs: 4 });
try {
  const request = { schema_version: "2.1", client_request_id: "m6-trust-snapshot", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast" };
  const accepted = await call(harness.server, "run_audit", request);
  check("m6-trusted-run-accepted", accepted.kind === "accepted");
  let status;
  for (let i = 0; i < 200; i += 1) { status = await call(harness.server, "get_run_status", { schema_version: "2.1", workspace_id: "ws_demo", run_id: accepted.run_handle }); if (status.phase === "GATED" || status.run_status === "FAILED") break; await new Promise((resolve) => setTimeout(resolve, 25)); }
  const context = JSON.parse(fs.readFileSync(path.join(harness.dataRoot, "runs", accepted.run_handle, "host-context.json"), "utf8"));
  check("m6-trust-snapshot-persisted", context.trust_mode === "trusted" && context.workspace_root === "<authorized>" && !JSON.stringify(context).includes(root));
  const evidenceManifest = JSON.parse(fs.readFileSync(path.join(harness.dataRoot, "runs", accepted.run_handle, "evidence-manifest.json"), "utf8"));
  check("m6-evidence-redaction-status-explicit", evidenceManifest.redacted === true && evidenceManifest.redaction_status === "COMPLETE");
  const discovery = JSON.parse(fs.readFileSync(path.join(harness.dataRoot, "runs", accepted.run_handle, "discovery.json"), "utf8"));
  check("m6-execution-uses-resolved-origin-policy", discovery.network.allowed_origins.includes("http://127.0.0.1:*") && status.phase === "GATED");
  const prManage = await call(harness.server, "run_audit", { ...request, client_request_id: "m6-pr-manage", workspace_id: "ws_pr", lifecycle: "manage", project_subpath: "." });
  check("m6-mcp-untrusted-pr-manage-denied", prManage.kind === "error" && prManage.error.code === "UNTRUSTED_MANAGE_DENIED");
  const secret = await call(harness.server, "run_audit", { ...request, client_request_id: "m6-secret-input", profile_path: "token=plaintext" });
  check("m6-mcp-secret-input-rejected", secret.kind === "error" && secret.error.code === "SECRET_IN_INPUT");
} finally { await harness.cleanup(); }

fs.rmSync(base, { recursive: true, force: true });
console.log(`\nM6 verify: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
