# ADR-016: Generated Test Plan Pipeline Boundary

Status: Accepted (M9.0 baseline)
Date: 2026-08-07
Deciders: AutoPW core team

## Context

The M9–M10 redesign will move AutoPW from a Fixture-driven execution path to a
Discovery → Requirement → Planner → Compiler → Execution pipeline. M0–M8 and
the MCP 2.1 public contracts are already accepted and must remain executable
while that migration is staged.

## Decisions

1. TestPlan is declarative data, not a dynamic script. Generated plans must not
   contain arbitrary JavaScript, shell commands, imports, or child-process
   access.
2. Discovery produces facts and candidates; it never directly executes tests.
3. Planner output is candidate-only. A Planner may select trusted Candidate IDs,
   but may not invent URLs, CSS/XPath selectors, code, or business assertions.
4. External target URLs are injected by a trusted Host or trusted CLI. They are
   not added to the MCP 2.1 `run_audit` request.
5. A plan from an untrusted PR is candidate input only; it cannot become an
   authoritative Profile, policy, or executable configuration without trusted
   approval.
6. The MCP 2.1 contract remains unchanged in M9.0. In particular,
   `target_url` and `plan_path` are not added to the public request schema.
7. The existing Fixture engine remains the default compatibility mode until the
   declarative path is proven and M10 explicitly switches the default.

## Feature flags

The Core accepts only trusted installation/Host configuration for these internal
modes:

```ts
type PlanEngineMode = "fixture" | "declarative";
type DiscoveryEngineMode = "legacy" | "structured";
```

The M9.0 defaults are `plan_engine=fixture` and
`discovery_engine=legacy`. Target page content and MCP tool parameters cannot
set these modes.

## Compatibility and migration

M9.0 freezes the existing phase sequence, Fixture case IDs, result categories,
artifact kinds/handles, matrix projection, and M0–M8 acceptance chain. M9.1
through M9.9 add the declarative plan contract, case-scoped storage, unified
runner, legacy migration, structured Discovery, Requirements, closed-loop
Planner/Compiler, coverage governance, and external target integration behind
the frozen boundary. M10 owns default switching and release cleanup.

If a later milestone proves a frozen contract unsafe or unimplementable, it
must use a new ADR, version the affected contract, regenerate artifacts, and
rerun every affected acceptance gate. Silent deviation is forbidden.
