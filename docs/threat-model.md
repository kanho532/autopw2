# Threat Model v1 — AutoPW v2.1 MCP-First (M0 baseline)

Date: 2026-08-05
Scope: Phase 0 boundary model. Refined in later milestones; this v1 covers every boundary in the milestone plan section 0.2E.

Invariants: trust only tightens; planner selects Candidate IDs only; results.json is the sole gate fact source; Fatal Failure produces no gate; recovery is at-least-once; tool params never widen.

| Threat | Scenario | Control |
|---|---|---|
| Malicious MCP tool parameters | A tool call passes a workspace_id, trust_mode or project_subpath to widen scope. | Host Context intersection rejects widening; tool params only narrow; trust_mode is host-only (not a tool input); rejected fixtures prove it. |
| Workspace escape | project_subpath ../../ or symlink/junction escapes the authorized realpath. | Workspace resolver realpath + deny_symlink_escape const true; security fixtures and integration test reject escape. |
| Malicious Profile | Profile requests manage, reuse prod credentials or expand auth scope. | Profile only narrows; auth_scope_id is host-generated reference; untrusted_pr ignores head Profile. |
| Malicious PR | PR ships Profile/Adapter/startup to execute or read host secrets. | untrusted_pr forces connect, refuses PR config, base/fixed authoritative, one-shot isolated identity. |
| Page prompt injection | Untrusted page text instructs Planner or MCP to widen privileges. | Page content lives in untrusted_data; Planner separates system rules from untrusted fields; no tool control in untrusted content. |
| Adapter arbitrary code | Adapter runs child_process, reads outside roots or calls arbitrary networks. | Adapter sandbox: isolated process/container, env allowlist, filesystem roots, no arbitrary child_process, network allowlist, CPU/mem/time limits. |
| Browser network escape | Target page navigates/redirects/WS/iframe/service worker to unauthorized origins. | Browser Network Guard gates navigation, redirect, fetch/XHR, WebSocket, iframe, service worker, subresource; DNS rebinding and localhost handling. |
| Planner output attack | Planner emits code, free URLs, shell or paths. | Plan Validator hard-rejects non-Candidate-ID output; retries then PLAN_DEFECT/TERMINALIZING; temperature 0. |
| Evidence data leak | Screenshots/console/network/video disclose secrets or host paths. | Redaction pipeline masks screenshots, redacts console/network, CSP on reports, URL scheme allowlist; no host absolute paths returned; auth scope cache isolation. |
| Handle guessing | Agent guesses another workspace's run_id. | Run handle binds run_id to workspace; get_run_result refuses cross-workspace; handle_token unguessable. |
| Replay and accepted-storm | Repeated run_audit with same client_request_id creates duplicate Runs. | client_request_id idempotency key; same id different params returns IDEMPOTENCY_CONFLICT. |
| Server/Worker restart state loss | MCP transport or process restart drops in-flight state. | Operation/Run persisted atomically before accepted; restart recovers queryable state; lease+checkpoint takeover. |
| Heartbeat flakiness double-takeover | A single missed heartbeat re-leases a live Worker. | Lease safe factor (ADR-012): takeover confirm >= heartbeat+skew; stale ACTIVE only taken over after confirm. |
| Full matrix fan-out resource exhaustion | full Tier cartesian product exhausts CPU/disk in a single Run. | Pre-creation instance projection; MATRIX_BUDGET_EXCEEDED; full forbids silent trim; quota high-water new-Run refusal. |
| Operation/Run/Evidence/Cache long growth and disk quota exhaustion | Retention never reclaims; sweeper deletes not-yet-expired facts or blocks status. | Versioned retention policy; sweeper idempotent; tombstone + RESULT_EXPIRED; high watermark refusal; never delete unexpired results/failure/gate; sweeper survives interruption. |
| Cleanup crash, duplicate execution, premature gate | Cleanup texture corrupts gate; non-resumable instance double-runs; gate fabricated on loss. | Cleanup is idempotent and cannot modify a frozen gate; at-least-once + BLOCKED_RESUME; Fatal Failure yields no gate. |

## Open residual risks (M0)
- Numeric lease window (ADR-012) is a floor; tuning against real CI host jitter is deferred to M1 fault injection.
- Adapter sandbox implementation specifics (regex redaction, CSP nonce) are deferred to M6; M0 names the boundary and its acceptance test.
- Full matrix budget ceiling exact value must be validated against a real full Run in M8; M0 fixes the projection mechanism and the no-silent-trim guarantee.

