# M9–M10 Generated Test Plan Migration Plan

Status: M9.5 Structured Discovery complete
Date: 2026-08-07

This document is the repository-facing execution plan for the generated test
plan redesign described in `m9-m10改进方案/`. It deliberately starts with a
compatibility freeze; M9.0 does not switch the production execution path.

## M9.0 acceptance boundary

The baseline records:

- the M0–M8 acceptance chain and the frozen MCP 2.1 tool/schema bundle;
- the phase order `TARGET_READY` through `GATED`;
- the three Fixture cases and `pass`, `fail`, and `incomplete` outcomes;
- `execution-results.json`, `completion-audit.json`, `report.md`, evidence
  handles, and the fast matrix projection;
- the default trusted engine modes: `fixture` + `legacy`.

Run:

```text
npm run verify:m9:baseline
```

The command first runs `verify:v2.1`, then executes
`tools/verify-m9-baseline.mjs`. The normalized expected shape is kept in
`fixtures/baselines/m9.0-baseline.json`; volatile run IDs, timestamps, ports,
and digests are intentionally excluded.

## M9 delivery order

| Milestone | Boundary | Exit evidence |
|---|---|---|
| M9.0 | Freeze compatibility and flags | baseline verifier + Golden Snapshot |
| M9.1 | Declarative `@autopw/test-plan` contract | schema, validator, loader, fixture adapter — complete |
| M9.2 | Case-scoped evidence storage | safe case paths and Artifact Index — complete |
| M9.3 | Unified UI/API/Hybrid runner | variables, cleanup, trace, classification - complete |
| M9.4 | Legacy-12 parity | migrated plan with legacy requirements - complete |
| M9.5 | Structured Discovery | static/live facts with bounded budgets - complete |
| M9.6 | Requirement derivation | TestRequirement and coverage reconciliation |
| M9.7 | Planner/Compiler loop | deterministic candidate-only executable plans |
| M9.8 | Coverage-governed audit | requirement-aware Audit, Gate, Report |
| M9.9 | External integration | trusted Target Provider, Plan Mode, thin CLI |
| M10 | Release hardening | dual-run, security/performance/fault gates, default switch |

## Non-negotiable migration rules

- Preserve the current phase names and order until every dependent verifier is
  migrated.
- Keep the MCP 2.1 public request unchanged; external URL and plan source are
  Host/CLI concerns.
- Keep the default Core execution path Fixture-driven and the public engine
  flags fail-closed until the later Planner/Compiler loop is accepted. M9.4's
  migrated plan and M9.5's Discovery are independently executable acceptance
  paths and do not silently switch the default Core mode.
- Treat missing coverage as `incomplete`, never as a product defect.
- Keep untrusted observations and plans non-authoritative.
- Do not let Planner output bypass Candidate validation or security policy.

Detailed model and runner work belongs to M9.1 onward and is intentionally not
implemented by M9.0. M9.1 and M9.2 now provide the contract and storage
foundation; the formal Runner switch remains deferred to M9.3.
