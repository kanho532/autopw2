// Fixture definitions. Positive instances MUST validate against their schema;
// negative instances MUST fail (verify:m0 enforces both directions). Tool
// fixtures come from tool contracts' examples, so this module only covers the
// persistent schemas plus host-context and transition fixtures.
const OP = "op_0123456789abcdefghij";
const RUN = "run_0123456789abcdefghij";
const NOW = "2026-08-05T08:00:00Z";

export const PERSISTENT_FIXTURES = {
  "mcp-error-envelope": {
    positive: [{ kind: "error", schema_version: "2.1", error: { code: "UNAUTHORIZED_WORKSPACE", message: "workspace not authorized" }, retryable: false, poll_after_ms: 0 }],
    negative: [{ kind: "ok", schema_version: "2.1", error: { code: "X", message: "y" } }, { kind: "error", schema_version: "2.1", error: { message: "no code" } }]
  },
  "mcp-tool-common-request": {
    positive: [{ schema_version: "2.1", client_request_id: "cr_abc-123", workspace_id: "ws_demo" }],
    negative: [{ schema_version: "2.1", client_request_id: "", workspace_id: "ws_demo" }]
  },
  "mcp-operation": {
    positive: [{ operation_id: OP, tool: "run_audit", status: "RUNNING", workspace_id: "ws_demo", client_request_id: "cr_abc-123", kind: "run", created_at: NOW, updated_at: NOW, run_id: RUN }],
    negative: [{ operation_id: "bad", tool: "run_audit", status: "RUNNING", workspace_id: "ws_demo", created_at: NOW, updated_at: NOW }]
  },
  "mcp-run-handle": {
    positive: [{ run_id: RUN, handle_token: "tok_" + "a".repeat(32), workspace_id: "ws_demo", created_at: NOW }],
    negative: [{ run_id: "run_short", handle_token: "tok_" + "a".repeat(32), workspace_id: "ws_demo" }]
  },
  "mcp-status-view": {
    positive: [{ kind: "ok", schema_version: "2.1", run_id: RUN, phase: "RUNNING", run_status: "ACTIVE", next_action: "poll get_run_status", poll_after_ms: 5000 }],
    negative: [{ kind: "ok", schema_version: "2.1", run_id: RUN, phase: "NOT_A_PHASE", run_status: "ACTIVE", next_action: "x", poll_after_ms: 1 }]
  },
  "mcp-result-view": {
    positive: [{ kind: "ok", schema_version: "2.1", run_id: RUN, phase: "GATED", gate: "fail", audit_status: "COMPLETE", results_ref: { handle: "art_r1", kind: "results.json" } }],
    negative: [{ kind: "ok", schema_version: "2.1", run_id: RUN, phase: "RUNNING", gate: "pass", audit_status: "COMPLETE", results_ref: { handle: "x", kind: "y" } }]
  },
  "profile": {
    positive: [{ schema_version: "2.1", gate: { strategy: "product", min_p0_coverage_pct: 100 }, base_tier: "fast", lifecycle: "connect" }],
    negative: [{ schema_version: "2.1", gate: { strategy: "bogus" }, base_tier: "fast", lifecycle: "connect" }]
  },
  "coverage-policy": {
    positive: [{ schema_version: "2.1", mandatory_capabilities: [{ id: "authentication", priority: "P0", scope_mode: "always", feature_ids: ["login"], on_missing: "incomplete" }] }],
    negative: [{ schema_version: "2.1", mandatory_capabilities: [{ id: "x", priority: "P9", scope_mode: "always", feature_ids: ["y"], on_missing: "incomplete" }] }]
  },
  "route-map": {
    positive: [{ schema_version: "2.1", ignore_globs: ["docs/**"], mappings: [{ file_glob: "src/pages/**", routes: ["/search"], features: ["search"], propagate: false }] }],
    negative: [{ schema_version: "2.1", mappings: [{ file_glob: "src/**" }] }]
  },
  "scenario-contract": {
    positive: [{ schema_version: "2.1", features: { search: { reset_strategy: { kind: "seed_adapter", idempotent: true } } } }],
    negative: [{ schema_version: "2.1" }]
  },
  "normalized-request": {
    positive: [{ schema_version: "2.1", profile_digest: "d1", tier: "fast", mode: "connect" }],
    negative: [{ schema_version: "2.1", tier: "ultra", mode: "connect" }]
  },
  "host-context-snapshot": {
    positive: [{ workspace_id: "ws_demo", workspace_realpath: "D:/projects/demo", trust_mode: "trusted", caller: "codex", max_execution_instances_per_run: 100 }],
    negative: [{ workspace_id: "ws_demo", workspace_realpath: "D:/projects/demo", trust_mode: "elevated", caller: "codex" }]
  },
  "input-versions": {
    positive: [{ schema_version: "2.1", profile_digest: "d1", engine_version: "2.1.0-rc5" }],
    negative: [{ schema_version: "2.1", profile_digest: "d1", engine_version: "2.1.0-rc5", extra_disallowed: true }]
  },
  "run-state": {
    positive: [{ run_id: RUN, state_version: 1, phase: "RUNNING", run_status: "ACTIVE", owner: "worker-1", lease: { ttl_ms: 60000, heartbeat_ms: 5000, acquired_at: NOW } }],
    negative: [{ run_id: RUN, state_version: 1, phase: "GARBAGE", run_status: "ACTIVE", owner: "w" }]
  },
  "operation-record": {
    positive: [{ operation_id: OP, tool: "run_audit", client_request_id: "cr_abc-123", workspace_id: "ws_demo", status: "ACCEPTED", kind: "run", created_at: NOW, expires_at: NOW }],
    negative: [{ operation_id: "bad", tool: "x", client_request_id: "c", workspace_id: "ws", status: "ACCEPTED", kind: "run" }]
  },
  "retention-policy": {
    positive: [{ schema_version: "2.1", operation_ttl_ms: 86400000, run_ttl_ms: 604800000, evidence_ttl_ms: 2592000000, high_watermark: 100000, low_watermark: 10000, tombstone_queryable: true }],
    negative: [{ schema_version: "2.1", operation_ttl_ms: 86400000, run_ttl_ms: 604800000, evidence_ttl_ms: 100 }]
  },
  "artifact-tombstone": {
    positive: [{ handle: "art_e1", kind: "evidence.png", deleted_at: NOW, expires_at: NOW }],
    negative: [{ handle: "art_e1", kind: "evidence.png", deleted_at: NOW }]
  },
  "target-result": {
    positive: [{ result: "CONNECTED", health: "200 ok", at: NOW }],
    negative: [{ result: "BOOTED", health: "x", at: NOW }]
  },
  "seed-result": {
    positive: [{ result: "SKIPPED", reset_capable: false, idempotent: true, at: NOW }],
    negative: [{ result: "APPLIED", reset_capable: true, idempotent: true }]
  },
  "discovery": {
    positive: [{ schema_version: "2.1", observations: [], candidates: [], scenario_observations: [{ feature_id: "search", scenario: "normal", observed: true, blocker: false }] }],
    negative: [{ schema_version: "2.1", observations: [], candidates: [], scenario_observations: [{ feature_id: "search", scenario: "madeup", observed: true }] }]
  },
  "derivation": {
    positive: [{ schema_version: "2.1", skeleton: [{ case_id: "case_search_normal", feature_id: "search", scenario: "normal", effective_tier: "smoke", matrix_cell: "search:smoke:chromium", blocked: false }], matrix: [], p0_required_total: 1, p0_coverage_pct: null }],
    negative: [{ schema_version: "2.1", skeleton: [{ case_id: "x", feature_id: "y", scenario: "madeup", effective_tier: "smoke" }] }]
  },
  "planner-input": {
    positive: [{ schemaVersion: "2.1", skeletons: [], candidates: {}, contractRefs: [], untrustedObservations: [{ observationId: "o1", untrusted: true, kind: "text", value: "page label" }] }],
    negative: [{ schemaVersion: "2.1", skeletons: [], candidates: {}, contractRefs: [], untrustedObservations: [{ observationId: "o1", untrusted: false, kind: "text", value: "x" }] }]
  },
  "planner-output": {
    positive: [{ caseSelections: [{ caseId: "case_search_normal", actionSelections: [{ actionTemplateId: "act_open_search" }], expectationIds: ["exp_results_visible"] }] }],
    negative: [{ caseSelections: [{ caseId: "x" }] }]
  },
  "plan-template": {
    positive: [{ cache_key: "ck1", selections_digest: "sd1", planner_provider_id: "fixture", model_id: "fixture-model" }],
    negative: [{ cache_key: "ck1" }]
  },
  "plan": {
    positive: [{ schema_version: "2.1", cases: [{ case_id: "case_search_normal", feature_id: "search", scenario: "normal", effective_tier: "fast", steps: [] }], frozen_at: NOW }],
    negative: [{ schema_version: "2.1", cases: [], frozen_at: "not-a-time" }]
  },
  "mapping-audit": {
    positive: [{ planned_case_ids: ["case_search_normal"], generated_case_ids: ["case_search_normal"], match: "COMPLETE" }],
    negative: [{ planned_case_ids: ["a"], generated_case_ids: ["b"], match: "BOGUS" }]
  },
  "execution-manifest": {
    positive: [{ batches: [{ batch_id: "BAT-0123456789abcdef", tier: "fast", browser: "chromium", locale: "en-US", auth_scope_id: "as_demo" }], instances: [{ execution_id: "EXE-0123456789abcdef", case_id: "case_search_normal", batch_id: "BAT-0123456789abcdef", status: "NOT_RUN" }] }],
    negative: [{ batches: [] }]
  },
  "execution-result": {
    positive: [{ execution_id: "EXE-0123456789abcdef", case_id: "case_search_normal", status: "PASSED", attempts: [], evidence_refs: ["link"], at: NOW }],
    negative: [{ execution_id: "bad", case_id: "x", status: "UNKNOWN" }]
  },
  "event": {
    positive: [{ seq: 1, kind: "PHASE_COMMITTED", phase: "RUNNING", at: NOW, detail: {} }],
    negative: [{ seq: 0, kind: "x", at: NOW }]
  },
  "checkpoint": {
    positive: [{ execution_id: "EXE-0123456789abcdef", case_id: "case_search_normal", status: "RUNNING", attempt: 1, at: NOW }],
    negative: [{ execution_id: "bad", case_id: "x", status: "RUNNING" }]
  },
  "evidence-manifest": {
    positive: [{ execution_id: "EXE-0123456789abcdef", items: [{ handle: "art_shot1", kind: "screenshot" }], redacted: true }],
    negative: [{ execution_id: "bad", items: [] }]
  },
  "issues": {
    positive: [{ schema_version: "2.1", issues: [{ id: "iss_1", classification: "PRODUCT_DEFECT", confidence: "HIGH", execution_id: "EXE-0123456789abcdef", evidence_refs: ["art_shot1"] }] }],
    negative: [{ schema_version: "2.1", issues: [{ id: "iss_1", classification: "BOGUS", confidence: "HIGH" }] }]
  },
  "terminalization": {
    positive: [{ reason: "PLAN_DEFECT", trigger_phase: "PLAN_FILLED", existing_artifacts: [], outstanding_scope: ["case_search_normal"], expected_gate: "incomplete" }],
    negative: [{ reason: "PLAN_DEFECT", trigger_phase: "PLAN_FILLED" }]
  },
  "finalization-result": {
    positive: [{ browsers_closed: true, agents_released: true, manage_target_closed: true, temp_secrets_cleared: true, gate_critical_ok: true }],
    negative: [{ browsers_closed: true }]
  },
  "completion-audit": {
    positive: [{ audit_status: "COMPLETE", case_reconciliation: "COMPLETE", instance_reconciliation: "COMPLETE", evidence_complete: true }],
    negative: [{ audit_status: "BOGUS", case_reconciliation: "MISMATCH", instance_reconciliation: "COMPLETE", evidence_complete: true }]
  },
  "gate-draft": {
    positive: [{ gate: "fail", audit_status: "COMPLETE", p0_coverage_pct: 100, summary: { product_defects: 2 } }],
    negative: [{ gate: "warn", audit_status: "COMPLETE" }]
  },
  "results": {
    positive: [{ schema_version: "2.1", run_id: RUN, gate: "fail", audit_status: "COMPLETE", exit_code: 1, results_ref: { handle: "art_r1", kind: "results.json" } }],
    negative: [{ schema_version: "2.1", run_id: RUN, gate: "warn", audit_status: "INCOMPLETE", exit_code: 0, results_ref: { handle: "x", kind: "y" } }]
  },
  "failure": {
    positive: [{ schema_version: "2.1", run_id: RUN, fatal_class: "STORAGE_INTEGRITY", error: { code: "DISK_WRITE_FAILED" }, at: NOW }],
    negative: [{ schema_version: "2.1", run_id: RUN, fatal_class: "BOGUS", error: {}, at: NOW }]
  },
  "cleanup-result": {
    positive: [{ run_id: RUN, cleaned: ["seed_data"], idempotent: true, at: NOW, kind: "ok" }],
    negative: [{ run_id: "bad", cleaned: [], idempotent: true, at: NOW }]
  }
};

export const HOST_CONTEXT_FIXTURES = {
  positive_trusted: { mcp_host_context: { workspace_authorization: { workspace_id: "ws_demo", workspace_realpath: "D:/projects/demo", deny_symlink_escape: true }, trust_mode: "trusted", auth_scope: { auth_scope_id: "as_demo", mode: "none", isolated: true }, caller: "codex", policy_version: "1.0.0" } },
  positive_untrusted_pr: { mcp_host_context: { workspace_authorization: { workspace_id: "ws_pr", workspace_realpath: "D:/projects/pr", deny_symlink_escape: true }, trust_mode: "untrusted_pr", auth_scope: { auth_scope_id: "as_one_shot", mode: "credentials", one_shot: true, isolated: true }, caller: "codex-ci", config_source: { base_revision: "origin/main", pr_head_allowed: false }, policy_version: "1.0.0" } },
  negative_agent_elevate: { mcp_host_context: { workspace_authorization: { workspace_id: "ws_demo", workspace_realpath: "D:/projects/demo", deny_symlink_escape: true }, trust_mode: "elevated", auth_scope: { auth_scope_id: "as_demo", mode: "none", isolated: true }, caller: "codex" } }
};

export const TRANSITION_FIXTURES = {
  valid: [
    ["CREATED", "TARGET_READY"], ["CREATED", "TERMINALIZING"], ["RUNNING", "EXECUTION_FINISHED"], ["RUNNING", "TERMINALIZING"], ["TERMINALIZING", "RUNTIME_FINALIZED"], ["REPORTED", "GATED"]
  ],
  invalid: [
    ["GATED", "RUNNING"], ["AUDITED", "TERMINALIZING"], ["REPORTED", "TERMINALIZING"], ["CREATED", "GATED"], ["FAILED", "GATED"]
  ]
};
