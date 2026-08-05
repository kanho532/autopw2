// AutoPW v2.1 MCP-First — canonical enum definitions.
// Single source of truth shared by JSON Schemas, generated TypeScript types and
// the documentation/docs:check verifier. Never duplicate these literals; always
// import from here so the "same enum across docs, schema and types" invariant
// (verify:m0 check #4) is mechanically enforced rather than hand-checked.

/** Run phases — fixed, ordered normal path with TERMINALIZING side branch. */
export const RUN_PHASE = Object.freeze([
  "CREATED", "TARGET_READY", "SEED_RESOLVED", "DISCOVERED", "COVERAGE_DERIVED",
  "PLAN_FILLED", "PLAN_FROZEN", "SUITE_GENERATED", "SUITE_FROZEN", "RUNNING",
  "EXECUTION_FINISHED", "RUNTIME_FINALIZED", "TERMINALIZING", "AUDITED",
  "REPORTED", "GATED"
]);

/** Normal path only (TERMINALIZING is a controlled side branch, not a normal step). */
export const RUN_PHASE_NORMAL = Object.freeze([
  "CREATED", "TARGET_READY", "SEED_RESOLVED", "DISCOVERED", "COVERAGE_DERIVED",
  "PLAN_FILLED", "PLAN_FROZEN", "SUITE_GENERATED", "SUITE_FROZEN", "RUNNING",
  "EXECUTION_FINISHED", "RUNTIME_FINALIZED", "AUDITED", "REPORTED", "GATED"
]);

/** Run status — orthogonal to Phase. */
export const RUN_STATUS = Object.freeze(["ACTIVE", "INTERRUPTED", "FAILED", "COMPLETED"]);

/** Audit status — produced by structural audit, not a Phase. */
export const AUDIT_STATUS = Object.freeze(["COMPLETE", "INCOMPLETE"]);

/** MCP Operation status for preview/resume/cancel/cleanup operations. */
export const OPERATION_STATUS = Object.freeze([
  "ACCEPTED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"
]);

/** Quality gate — fixed priority: incomplete > infra > fail > unstable > pass. */
export const GATE = Object.freeze(["incomplete", "infra", "fail", "unstable", "pass"]);
/** Gate evaluation order, highest precedence first. */
export const GATE_PRIORITY = Object.freeze(["incomplete", "infra", "fail", "unstable", "pass"]);

/** Base tier requested by the user. Effective tier is computed per feature. */
export const BASE_TIER = Object.freeze(["smoke", "fast", "full"]);

/** Scenario family. */
export const SCENARIO = Object.freeze([
  "normal", "required_field", "invalid_input", "boundary",
  "empty_state", "service_error", "network_failure"
]);

/** Execution instance status (a.k.a CaseStatus). */
export const EXECUTION_STATUS = Object.freeze([
  "NOT_RUN", "RUNNING", "PASSED", "FAILED", "FLAKY",
  "INTERRUPTED", "BLOCKED_RESUME", "INFRA_BLOCKED"
]);
/** Trusted terminal execution states (evidence-complete). */
export const EXECUTION_TERMINAL = Object.freeze(["PASSED", "FAILED", "FLAKY"]);

/** Coverage priority. */
export const PRIORITY = Object.freeze(["P0", "P1", "P2"]);

/** Issue classification. */
export const ISSUE_CLASSIFICATION = Object.freeze([
  "PRODUCT_DEFECT", "TEST_DEFECT", "PLAN_DEFECT", "INFRA_DEFECT", "FLAKY"
]);

/** Classification confidence. LOW forces audit_status=INCOMPLETE. */
export const CLASSIFICATION_CONFIDENCE = Object.freeze(["HIGH", "MEDIUM", "LOW"]);

/** Host Trust Context modes. untrusted_pr forces connect, refuses PR config. */
export const TRUST_MODE = Object.freeze(["trusted", "untrusted_pr"]);

/** Target lifecycle mode. */
export const LIFECYCLE_MODE = Object.freeze(["connect", "manage"]);

/** Gate strategy (flaky handling). product=unstable, strict=fail. */
export const GATE_STRATEGY = Object.freeze(["product", "strict"]);

/** Terminalization reason — controlled early-stop branches to a Gate. */
export const TERMINALIZATION_REASON = Object.freeze([
  "PLAN_DEFECT", "SEED_EXHAUSTED", "TEST_DEFECT_UNSAFE",
  "INFRA_BLOCKED_GLOBAL", "BUDGET_EXCEEDED", "CANCEL_REQUESTED"
]);

/** Fatal failure classifications — fail-closed, no quality Gate, failure.json only. */
export const FATAL_FAILURE_CLASS = Object.freeze([
  "STORAGE_INTEGRITY", "SCHEMA_BUNDLE_INVALID", "TRUST_BOUNDARY_BROKEN",
  "DIRECTORY_ANCHOR_LOST", "STATE_CORRUPTED"
]);

/** Tool result union discriminator. ok carries success/accepted; error carries Error Envelope. */
export const TOOL_RESULT_KIND = Object.freeze(["ok", "error"]);

/**
 * Maps an enum (schema) value to its array. Central registry so verifiers and
 * generators iterate a single namespaced map instead of hand-syncing literals.
 */
export const ENUMS = Object.freeze({
  runPhase: RUN_PHASE,
  runPhaseNormal: RUN_PHASE_NORMAL,
  runStatus: RUN_STATUS,
  auditStatus: AUDIT_STATUS,
  operationStatus: OPERATION_STATUS,
  gate: GATE,
  gatePriority: GATE_PRIORITY,
  baseTier: BASE_TIER,
  scenario: SCENARIO,
  executionStatus: EXECUTION_STATUS,
  executionTerminal: EXECUTION_TERMINAL,
  priority: PRIORITY,
  issueClassification: ISSUE_CLASSIFICATION,
  classificationConfidence: CLASSIFICATION_CONFIDENCE,
  trustMode: TRUST_MODE,
  lifecycleMode: LIFECYCLE_MODE,
  gateStrategy: GATE_STRATEGY,
  terminalizationReason: TERMINALIZATION_REASON,
  fatalFailureClass: FATAL_FAILURE_CLASS,
  toolResultKind: TOOL_RESULT_KIND
});

/** Ordered list of enum names used by the docs consistency checker. */
export const ENUM_KEYS = Object.freeze(Object.keys(ENUMS));
