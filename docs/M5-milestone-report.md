# Milestone M5: Durable Operations

Status: complete for the local durable fixture worker. Acceptance command: `npm run verify:m5`.

M5 persists `run_state.json` with a monotonic state version, worker owner, heartbeat, expiry, stale-confirmation count, resume attempts and Lease policy. The policy enforces safety factor ≥4, TTL ≥ heartbeat × factor and takeover grace ≥ heartbeat ×2. Stale takeover requires the complete TTL/grace/clock-skew window, consecutive confirmations, a liveness check and atomic file CAS; terminal Runs release their Lease. CAS lock files carry owner metadata and expired locks from crashed processes are reclaimed safely.

The worker persists phase transitions and checkpoints atomically through RunStorage, preserves accepted Runs across registry reload, supports resume bookkeeping, classifies Planner defects as trusted incomplete terminalization, distinguishes infrastructure failure from fatal state corruption, and keeps cancellation on the finalization/audit/report path. Cleanup removes seed material when present, is idempotent, and does not rewrite results or gates. Console/request evidence is redacted before persistence.

`verify:m5` covers lease invariants, grace and liveness behavior, stale Run recovery through MCP after Worker restart, single-winner CAS competition, orphan-lock recovery, durable run state, released terminal leases, checkpoints/evidence, cleanup idempotence, gate preservation, max-resume terminalization, 100 deterministic crash injections and cancellation as incomplete rather than pass (20 checks).

The current worker is the deterministic local fixture implementation. Cross-machine process supervision and production browser adapters remain outside this milestone’s explicit fixture scope and are not claimed by this report.
