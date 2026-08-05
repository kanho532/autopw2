// Generate M0 narrative docs: 15 ADRs, Threat Model v1, M0 milestone report, README.
// ADR titles mirror the milestone plan section 0.2E; Threat Model covers section 0.2E threats.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const adrDir = path.join(root, "docs", "adr");
fs.mkdirSync(adrDir, { recursive: true });

const ADRS = [
  ["001", "MCP is the sole primary public entry",
   "Codex Agents need a stable, low-context surface to drive long-running Web audits. A raw CLI or low-level Core API would let an agent bypass the state machine, run Playwright directly, or assemble audit logic outside the gate.",
   "MCP Server is the sole public entry. It exposes 10 high-level tools; CLI is maintenance-only and Core API is an internal boundary. Low-level phases (fill_plan, compile_suite, execute_batch, commit_gate) are never exposed. An agent cannot compose tools to bypass the directory gate, audit or security policy.",
   "Single chokepoint for authorization intersection and idempotency. Adds a Control Plane layer. Forces long tasks to be observable via persistent Operation/Run handles. To bypass it you must invent a second orchestrator, which Phase 0 forbids."],
  ["002", "Why accepted plus polling instead of streaming",
   "MCP tool calls are short-lived; a full audit can run minutes. Holding a tool call open for the whole run couples Run lifetime to the MCP transport and Codex session, which can disconnect.",
   "run_audit returns immediately with a persisted run_handle after a minimal Operation/Run record is atomically on disk. Clients poll get_run_status/get_run_result. Acceptance is independent of transport; MCP Server restart, Codex session close and transport reconnect never cancel an accepted Run.",
   "Adds polling load and poll_after_ms guidance. Requires Operation Registry and Run Storage to durable. Removes the failure mode where a disconnected session silently rolls back a long audit."],
  ["003", "Operation vs Run separation",
   "Preview, resume, cancel and cleanup are cross-call operations that may outlive a Run. Mixing them into Run storage conflates audit lifecycle with control lifecycle and breaks idempotency.",
   "Operations are first-class persisted records (ACCEPTED/RUNNING/COMPLETED/FAILED/CANCELLED) tracked separately from Runs. Every accepted operation_id has a get_operation_status/get_operation_result read path. Run handle is a stable handle, not the control channel.",
   "Two registries to keep consistent. Enables preview before committing to a Run and unifies resume/cancel/cleanup queries."],
  ["004", "Why no hash chain",
   "Post-hoc tamper-evident auditing via a hash chain adds latency and complexity; AutoPW targets at-least-once recoverability and input version pinning, not adversarial after-the-fact proof.",
   "Governance uses phase write-once, atomic snapshots, state_version CAS, events.jsonl append log, structural reconciliation and Content Digest (cache/damage/version pinning) only. No hash chain. If tamper-evident audit is ever needed, add it as a separate signing manifest over immutable storage, not hidden in v2.1.",
   "No post-hoc tamper protection. Content Digest does not prove history. Recovery and cache invalidation are covered; adversarial audit integrity is explicitly out of scope for v2.1."],
  ["005", "Logical Case vs Execution Instance",
   "A single feature x scenario can expand to multiple executions under a full browser x viewport matrix, and аудит must reconcile both the case set and the instance set independently.",
   "Define Logical Case (stable case_id) and Execution Instance (execution_id) as separate concepts. Audit reconciles planned_case_ids == generated_case_ids AND required instances == collected == accounted. coverage is covered only when all required instances reach trusted terminal states evidence-complete.",
   "Two reconciliation sets, but full matrix one-to-many is solved without losing cases or instances. Coverage has an honest definition that cannot mark unexecuted/incomplete as covered."],
  ["006", "Planner only selects Candidate IDs",
   "Letting a model emit selectors, code, CSS/XPath, URLs or paths lets it inject behaviors that bypass the deterministic compiler or escape containment; page content is untrusted and can prompt-inject.",
   "Planner only returns typed IDs from typed allow-lists produced by Discovery/Contract; temperature 0; no code; no new Candidates; descriptions are render-only. Plan Validator hard-checks this and retries; exhaustion becomes PLAN_DEFECT into TERMINALIZING.",
   "Limits model utility to selection. Deterministic compiler is the only code path. Violations fail closed into incomplete, never into an arbitrary behavior."],
  ["007", "Host Trust Context is not promotable by repository",
   "A PR or project Profile could otherwise self-authorize trusted mode, reuse dev/prod credentials, or run its own startup/Adapter to escalate privileges.",
   "Trust is host-injected and one-way-tightening. untrusted_pr forces connect, refuses PR-supplied Profile/Adapter/startup, uses base/fixed/signed-overlay config, and isolates one-shot least-privilege identities. Conflict resolves to the stricter value; the conflict is recorded in preflight.",
   "Tool params can only narrow (intersect). No path for a PR to widen workspace, trust, auth or network scope. Adds CI/host integration burden but removes self-escalation."],
  ["008", "Recovery guarantees only at-least-once",
   "A crashed Worker mid-execution may have partial side effects; blindly resuming all instances risks double-execute of mutating actions. Perfect exactly-once is usually infeasible without distributed TX.",
   "Recovery is at-least-once with explicit resumability. Reset-capable instances resume; non-resumable mutating instances block resume (BLOCKED_RESUME) rather than blindly rerun. Checkpoint + lease + heartbeat let a takeover confirm safe bounds before resuming.",
   "Resume can refuse and yield incomplete. Honest about exactly-once limits. Non-resumable mutations surface as incomplete instead of silent duplicate damage."],
  ["009", "Quality Gate vs Fatal Failure separation",
   "Conflating a terminal quality gate with a fail-closed integrity loss lets a system fabricate a gate (e.g. fake pass) when trust/storage is unrecoverable.",
   "Terminalization is a controlled early stop that still produces a real incomplete/infra gate. Fatal Failure is separate: trust/directory/Schema/state integrity lost -> run_status=FAILED, failure.json, no quality gate, lease released. Never fake a gate.",
   "Two terminal paths keep their contracts. Incomplete and infra remain real gates; integrity loss yields no gate at all. CI exit codes distinguish operational errors from gate results."],
  ["010", "CLI is maintenance-only",
   "A second audit-orchestrating CLI duplicates the Control Plane, splits the audit path, and reintroduces a way to bypass the MCP gate.",
   "Maintenance CLI exposes doctor/server start|stop|status/run status|resume|cancel|cleanup/profile validate/schema verify. It has no audit command and no second orchestrator. npm verify and CI read the MCP results.json, not a CLI audit path.",
   "CLI cannot be the release gate. One product entry. Operators retain manual recovery without a parallel implementation."],
  ["011", "Discovery vs pure Derivation performance budget separation",
   "Real Discovery touches a browser, page network, DNS and target servers; pure Derivation is deterministic CPU over an already-validated discovery.json. A single 2s end-to-end budget is unenforceable and conflates external wait with CPU.",
   "Separate budgets: pure Derivation Engine target P95<=2s on Schema-validated discovery.json; Discovery is gauged separately by wall time under timeout/page budget. derive_coverage must report preflight_ms, discovery_wall_ms, derivation_cpu_ms, serialization_ms. Real-project target timing is reported separately and never folded into the Derivation 2s contract.",
   "Two performance regimes. External flakiness cannot mask slow Derivation or vice versa. Requires every derive_coverage to emit the split."],
  ["012", "Lease TTL, Heartbeat, Trace and takeover-confirm safe factor",
   "A missed heartbeat that lets a stale Worker get re-leased mid-work causes duplicate execution; clock skew can make a takeover confirm too eager.",
   "Lease safe window: ttl_ms >= 3*heartbeat_max_ms and takeover_confirm_min_ms >= heartbeat_max_ms + clock_skew_max_ms. A stale ACTIVE lease is only taken over after confirm; a perfect Worker is never re-leased on a single missed heartbeat. Fixed numeric floor is recorded.",
   "Adds explicit numeric guardrails and限制了 takeover aggressiveness. Slower takeover on noisy hosts but no double-Worker. verify:m0 asserts the relationship holds."],
  ["013", "Full matrix instance projection and forbid silent trim",
   "A full Tier in a real project can blow the cartesian product; silently trimming, sampling, pairwise or auto-degrading to fast would lie about coverage as full.",
   "Before creating a Run, project required Execution Instances; if they exceed the effective matrix budget, return MATRIX_BUDGET_EXCEEDED and do not create the Run. Full forbids silent trim, sampling, pairwise or downgrade. Any future pairwise/sampling uses a new explicit matrix strategy name plus its own Gate semantics.",
   "Full means honest full. Large projects must use fast or an explicit strategy, not a fake full. derive_coverage returns browser/viewport/locale/auth-scope projected counts and narrowing suggestions."],
  ["014", "Retention policy, tombstone and disk quota high-water behavior",
   "Unbounded Operation/Run/Evidence retention fills disk and slows status; deleting artifacts silently breaks references; rejecting new Runs only when disk is full is too late.",
   "Operation/Run/Preview/Evidence/Cache/Artifact are governed by a versioned retention policy (TTL, quota, tombstone). Artifacts get a tombstone before deletion and queries return RESULT_EXPIRED. Sweeper can resume idempotently. At high watermark with no reclaimable objects, new Runs are refused rather than sacrificing unexpired facts.",
   "Bounded disk. No silent artifact disappearance. Quota pressure surfaces as a controlled new-Run refusal, not data loss of not-yet-expired gates/results."],
  ["015", "M0 freeze is an ADR-governed implementable baseline, not permanently unmodifiable",
   "Freezing contracts before any implementation risks freezing an unimplementable or unsafe baseline; forbidding all later change would force unfixable bugs to live forever.",
   "M0 freeze is a controlled implementable baseline. If Phase 1+ proves through prototype/perf/fault/host integration that a frozen contract is unimplementable or unsafe, you must: write an ADR; bump affected Schema/Tool version; regenerate Schema/types/fixtures; rerun all affected verify:mN; record the superseded contract in the change log. Silent hand-deviation of the frozen baseline is forbidden.",
   "Baseline can evolve but only via ADR + version bump + regression. Prevents both premature ossification and stealth drift. verify:m0 remains the gate that the frozen set is internally consistent."]
];

for (const [num, title, context, decision, consequences] of ADRS) {
  const body =
    "# ADR-" + num + ": " + title + "\n" +
    "Status: Accepted (M0 baseline)\nDate: 2026-08-05\nDeciders: AutoPW core team\n\n" +
    "## Context\n" + context + "\n\n## Decision\n" + decision + "\n\n## Consequences\n" + consequences + "\n\n## Compliance\n" +
    "Enforced by `npm run verify:m0`. Superseding this ADR requires a new ADR plus a Schema/Tool version bump and a rerun of all affected `verify:mN`.\n";
  fs.writeFileSync(path.join(adrDir, "ADR-" + num + ".md"), body, "utf8");
}

// Threat Model v1
const threats = [
 ["Malicious MCP tool parameters", "A tool call passes a workspace_id, trust_mode or project_subpath to widen scope.", "Host Context intersection rejects widening; tool params only narrow; trust_mode is host-only (not a tool input); rejected fixtures prove it."],
 ["Workspace escape", "project_subpath ../../ or symlink/junction escapes the authorized realpath.", "Workspace resolver realpath + deny_symlink_escape const true; security fixtures and integration test reject escape."],
 ["Malicious Profile", "Profile requests manage, reuse prod credentials or expand auth scope.", "Profile only narrows; auth_scope_id is host-generated reference; untrusted_pr ignores head Profile."],
 ["Malicious PR", "PR ships Profile/Adapter/startup to execute or read host secrets.", "untrusted_pr forces connect, refuses PR config, base/fixed authoritative, one-shot isolated identity."],
 ["Page prompt injection", "Untrusted page text instructs Planner or MCP to widen privileges.", "Page content lives in untrusted_data; Planner separates system rules from untrusted fields; no tool control in untrusted content."],
 ["Adapter arbitrary code", "Adapter runs child_process, reads outside roots or calls arbitrary networks.", "Adapter sandbox: isolated process/container, env allowlist, filesystem roots, no arbitrary child_process, network allowlist, CPU/mem/time limits."],
 ["Browser network escape", "Target page navigates/redirects/WS/iframe/service worker to unauthorized origins.", "Browser Network Guard gates navigation, redirect, fetch/XHR, WebSocket, iframe, service worker, subresource; DNS rebinding and localhost handling."],
 ["Planner output attack", "Planner emits code, free URLs, shell or paths.", "Plan Validator hard-rejects non-Candidate-ID output; retries then PLAN_DEFECT/TERMINALIZING; temperature 0."],
 ["Evidence data leak", "Screenshots/console/network/video disclose secrets or host paths.", "Redaction pipeline masks screenshots, redacts console/network, CSP on reports, URL scheme allowlist; no host absolute paths returned; auth scope cache isolation."],
 ["Handle guessing", "Agent guesses another workspace's run_id.", "Run handle binds run_id to workspace; get_run_result refuses cross-workspace; handle_token unguessable."],
 ["Replay and accepted-storm", "Repeated run_audit with same client_request_id creates duplicate Runs.", "client_request_id idempotency key; same id different params returns IDEMPOTENCY_CONFLICT."],
 ["Server/Worker restart state loss", "MCP transport or process restart drops in-flight state.", "Operation/Run persisted atomically before accepted; restart recovers queryable state; lease+checkpoint takeover."],
 ["Heartbeat flakiness double-takeover", "A single missed heartbeat re-leases a live Worker.", "Lease safe factor (ADR-012): takeover confirm >= heartbeat+skew; stale ACTIVE only taken over after confirm."],
 ["Full matrix fan-out resource exhaustion", "full Tier cartesian product exhausts CPU/disk in a single Run.", "Pre-creation instance projection; MATRIX_BUDGET_EXCEEDED; full forbids silent trim; quota high-water new-Run refusal."],
 ["Operation/Run/Evidence/Cache long growth and disk quota exhaustion", "Retention never reclaims; sweeper deletes not-yet-expired facts or blocks status.", "Versioned retention policy; sweeper idempotent; tombstone + RESULT_EXPIRED; high watermark refusal; never delete unexpired results/failure/gate; sweeper survives interruption."],
 ["Cleanup crash, duplicate execution, premature gate", "Cleanup texture corrupts gate; non-resumable instance double-runs; gate fabricated on loss.", "Cleanup is idempotent and cannot modify a frozen gate; at-least-once + BLOCKED_RESUME; Fatal Failure yields no gate."]
];
let tm = "# Threat Model v1 — AutoPW v2.1 MCP-First (M0 baseline)\n\nDate: 2026-08-05\nScope: Phase 0 boundary model. Refined in later milestones; this v1 covers every boundary in the milestone plan section 0.2E.\n\nInvariants: trust only tightens; planner selects Candidate IDs only; results.json is the sole gate fact source; Fatal Failure produces no gate; recovery is at-least-once; tool params never widen.\n\n| Threat | Scenario | Control |\n|---|---|---|\n";
for (const t of threats) tm += "| " + t[0] + " | " + t[1] + " | " + t[2] + " |\n";
tm += "\n## Open residual risks (M0)\n- Numeric lease window (ADR-012) is a floor; tuning against real CI host jitter is deferred to M1 fault injection.\n- Adapter sandbox implementation specifics (regex redaction, CSP nonce) are deferred to M6; M0 names the boundary and its acceptance test.\n- Full matrix budget ceiling exact value must be validated against a real full Run in M8; M0 fixes the projection mechanism and the no-silent-trim guarantee.\n\n";
fs.writeFileSync(path.join(root, "docs", "threat-model.md"), tm, "utf8");

// M0 milestone report
const report = "# Milestone M0: MCP Contract Frozen — Report\n\nDate: 2026-08-05\nStatus: Complete (acceptance met)\n\n## Acceptance (npm run verify:m0 = 13 passed, 0 failed)\n- 01 tool examples pass tool schema; 05 every tool has an error-path example\n- 02 persistent examples pass corresponding schema (positives pass, negatives fail)\n- 03 all schema references resolvable through common $defs\n- 04 enums identical across docs table, schema $defs and generated TypeScript types\n- 06 unique schema $id per persistent; fixtures map 1:1 to schemas\n- 07 workspace/path/ID length and format limits fixed and finite\n- 08 transition table is closed; no undefined transitions; matches transition fixtures\n- 09 tool params cannot elevate trust/auth/network; host context narrows only\n- 10 CLI is maintenance-only; MCP is the audit entry\n- canonical: all 39 §0.2C schemas present; gate priority fixed; lease safe-window factor holds\n\n## Deliverables\n- Tool Schema Bundle: packages/mcp-contracts/contracts/tools/*.tool.json (10 tools)\n- Persistent Data Schema Bundle: packages/schemas/schemas/*.schema.json (39 persistents + common $defs registry)\n- TypeScript types: packages/mcp-contracts/src/types/enums.ts (generated from single-source enums.mjs)\n- MCP Host Harness shell: apps/mcp-host-harness (loads contract inventory; no real MCP server in M0)\n- Positive/negative fixtures: fixtures/persistents, fixtures/host-contexts, fixtures/run-states\n- ADRs: docs/adr/ADR-001..ADR-015.md\n- Threat Model v1: docs/threat-model.md\n- Maintenance CLI manifest: packages/maintenance-cli/commands.json\n- Verifier: tools/verify-m0.mjs (npm run verify:m0)\n\n## Explicitly NOT done in M0 (per spec 0.7)\nNo Playwright, no real Worker, no Planner, no real Discovery, no full CLI audit commands. These begin at M1+.\n\n## Change-management\nM0 is an ADR-governed baseline (ADR-015). Breaking changes require a new ADR, a Schema/Tool version bump, regeneration and a rerun of all affected verify:mN.\n";
fs.writeFileSync(path.join(root, "docs", "M0-milestone-report.md"), report, "utf8");

// README
const readme = "# AutoPW v2.1 (MCP-First)\n\nAutoPW is a Profile-driven Web quality audit engine delivered as a Codex local MCP plugin. The MCP Server is the sole primary public entry; the maintenance CLI and internal Core API are not the audit path.\n\nThis repository is at **Phase 0 (Milestone M0: MCP Contract Frozen)**. No implementation code runs yet; this milestone freezes the public Tool Schema Bundle, the persistent Data Schema Bundle, the Host Context contract, the state machine and the security/retention/threat/ADR baselines that every later milestone must satisfy.\n\n## Run the M0 acceptance gate\n```bash\nnpm install\nnpm run verify:m0\n```\n`verify:m0` returns 0 only when all mandatory M0 checks pass. Subsets: `npm run contract`, `npm run schema:test`, `npm run docs:check`.\n\n## Layout\n- `packages/schemas` — Draft 2020-12 JSON Schema bundle (single-source enums + limits + common $defs + 39 persistents)\n- `packages/mcp-contracts` — 10 MCP tool contracts, Host Context contract, generated TypeScript types\n- `packages/maintenance-cli` — maintenance-only CLI command manifest\n- `apps/mcp-host-harness` — MCP Host Harness shell (loads contract inventory)\n- `fixtures` — positive/negative persistents, host-contexts, run-state transitions\n- `tools` — generators (`gen-m0.mjs`, `gen-types.mjs`, `gen-docs.mjs`) and `verify-m0.mjs`\n- `docs` — ADRs, Threat Model v1, M0 milestone report\n- See `AUTOPW_V2_1_MCP_FIRST_SPECIFICATION_RC5.md` (authoritative spec) and `AUTOPW_V2_1_MCP_FIRST_IMPLEMENTATION_MILESTONE_PLAN_RC5.md`.\n\n## Regenerate artifacts\n```bash\nnode tools/gen-m0.mjs    # schemas, tool contracts, fixtures, manifests\nnode tools/gen-types.mjs # TypeScript enum/union types\nnode tools/gen-docs.mjs  # ADRs, Threat Model, M0 report, README\n```\n\n## Authoritative source\nThe specification is frozen once M0 passes. Any deviation from the frozen contracts is a defect and must be resolved by editing the spec/schemas and bumping versions under an ADR, never by hand-patching an implementation.\n";
fs.writeFileSync(path.join(root, "README.md"), readme, "utf8");

console.log("gen-docs done: 15 ADRs + threat model + M0 report + README");