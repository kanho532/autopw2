// Fixed state machine: phases, explicit transition table, run/run-state contracts
// and the gate priority + P0 coverage formula. Single-sourced enums come from
// enums.mjs; verify:m0 check #8 walks this table to ensure no undefined transition.
import { RUN_PHASE, RUN_PHASE_NORMAL, GATE_PRIORITY, AUDIT_STATUS } from "./enums.mjs";

export const NORMAL_PATH = Object.freeze([...RUN_PHASE_NORMAL]);

// Explicit transition table from spec section 7.2. type:
//   "normal"  - forward step on the normal path
//   "branch"  - controlled side branch into TERMINALIZING
// "normal" transitions to the next committed phase; every phase from CREATED
// through EXECUTION_FINISHED may branch to TERMINALIZING; after that the path is
// linear and branches are forbidden (RUN_PHASE_INVALID).
export const TRANSITIONS = Object.freeze([
  { from: "CREATED", to: "TARGET_READY", type: "normal" },
  { from: "CREATED", to: "TERMINALIZING", type: "branch" },
  { from: "TARGET_READY", to: "SEED_RESOLVED", type: "normal" },
  { from: "TARGET_READY", to: "TERMINALIZING", type: "branch" },
  { from: "SEED_RESOLVED", to: "DISCOVERED", type: "normal" },
  { from: "SEED_RESOLVED", to: "TERMINALIZING", type: "branch" },
  { from: "DISCOVERED", to: "COVERAGE_DERIVED", type: "normal" },
  { from: "DISCOVERED", to: "TERMINALIZING", type: "branch" },
  { from: "COVERAGE_DERIVED", to: "PLAN_FILLED", type: "normal" },
  { from: "COVERAGE_DERIVED", to: "TERMINALIZING", type: "branch" },
  { from: "PLAN_FILLED", to: "PLAN_FROZEN", type: "normal" },
  { from: "PLAN_FILLED", to: "TERMINALIZING", type: "branch" },
  { from: "PLAN_FROZEN", to: "SUITE_GENERATED", type: "normal" },
  { from: "PLAN_FROZEN", to: "TERMINALIZING", type: "branch" },
  { from: "SUITE_GENERATED", to: "SUITE_FROZEN", type: "normal" },
  { from: "SUITE_GENERATED", to: "TERMINALIZING", type: "branch" },
  { from: "SUITE_FROZEN", to: "RUNNING", type: "normal" },
  { from: "SUITE_FROZEN", to: "TERMINALIZING", type: "branch" },
  { from: "RUNNING", to: "EXECUTION_FINISHED", type: "normal" },
  { from: "RUNNING", to: "TERMINALIZING", type: "branch" },
  { from: "EXECUTION_FINISHED", to: "RUNTIME_FINALIZED", type: "normal" },
  { from: "EXECUTION_FINISHED", to: "TERMINALIZING", type: "branch" },
  { from: "TERMINALIZING", to: "RUNTIME_FINALIZED", type: "normal" },
  { from: "RUNTIME_FINALIZED", to: "AUDITED", type: "normal" },
  { from: "AUDITED", to: "REPORTED", type: "normal" },
  { from: "REPORTED", to: "GATED", type: "normal" }
]);

// Phases after which branching into TERMINALIZING is allowed.
export const BRANCH_AFTER = Object.freeze([
  "CREATED","TARGET_READY","SEED_RESOLVED","DISCOVERED","COVERAGE_DERIVED",
  "PLAN_FILLED","PLAN_FROZEN","SUITE_GENERATED","SUITE_FROZEN","RUNNING","EXECUTION_FINISHED"
]);

// GATED is the terminal normal phase; no outbound transition.
export const TERMINAL_PHASE = "GATED";

// Fixed gate priority: incomplete > infra > fail > unstable > pass.
export const GATE_EVALUATION_ORDER = Object.freeze([...GATE_PRIORITY]);

// P0 coverage formula identifiers (normative statement; verify asserts presence).
export const P0_COVERAGE = Object.freeze({
  numerator: "covered_p0_planned_cells",
  denominator: "included_required_p0_planned_cells + included_required_p0_observed_blocked_cells",
  null_when_empty: true,
  any_p0_blocker_forces_incomplete: true
});

// Audit status is produced by structural audit, not a phase.
export const AUDIT_STATUS_VALUES = Object.freeze([...AUDIT_STATUS]);

// Reconciliation rule: two independent sets must both balance.
export const RECONCILIATION = Object.freeze({
  case_set: { name: "Logical Case set", rule: "planned_case_ids == generated_case_ids" },
  instance_set: { name: "Execution Instance set", rule: "required_instances == collected == accounted" }
});

// Lease safety window: verify:m0 asserts the safe-factor relationship holds.
export const LEASE_WINDOW = Object.freeze({
  ttl_ms_min: 30000,
  heartbeat_max_ms: 10000,
  clock_skew_max_ms: 5000,
  takeover_confirm_min_ms: 30000,
  safe_factor: "ttl_ms >= 3 * heartbeat_max_ms && takeover_confirm_min_ms >= heartbeat_max_ms + clock_skew_max_ms"
});
