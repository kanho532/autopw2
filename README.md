# AutoPW v2.1 (MCP-First)

AutoPW is a Profile-driven Web quality audit engine delivered as a Codex local MCP plugin. The MCP Server is the sole primary public entry; the maintenance CLI and internal Core API are not the audit path.

The repository has completed **M9.0 Baseline Frozen**, **M9.1 Declarative Plan Contract**, and **M9.2 Case-scoped Evidence Storage**. The generated-plan migration is still in compatibility mode: the default Core engines are `plan_engine=fixture` and `discovery_engine=legacy`. M9.3–M9.9 and M10 switch these only after their own acceptance gates.

This repository has completed **M8 (release hardening)**. M0 freezes the public contracts; M1 provides the durable MCP Control Plane; M2 runs a deterministic Chromium audit through MCP; M3 adds bounded Discovery, Diff/Derivation, CDD Preview and honest full-matrix projections; M4 adds candidate-only Planner integration and template caching; M5 adds persisted Lease/heartbeat state, safe recovery, cancellation and idempotent cleanup; M6 adds host-owned trust resolution, untrusted-PR restrictions, path/origin/adapter boundaries, production read-only enforcement and evidence/report redaction; M7 adds agent workflow observability and maintenance tooling; M8 adds multi-browser execution, release compatibility, performance, fault, retention and bounded soak gates.

## Development language

M9.4 Legacy-12 Parity and M9.5 Structured Discovery are complete. The default
Core modes remain `plan_engine=fixture` and `discovery_engine=legacy` until the
later Planner/Compiler closed loop is accepted.

The primary implementation language is **TypeScript** (`.ts`) with strict type checking. JavaScript modules are limited to generators and verification harnesses; new runtime code belongs in the TypeScript packages and is consumed through the build output.

## Run the acceptance gates
```bash
npm install
npm run verify:m0
npm run verify:m1
npm run verify:m2
npm run verify:m3
npm run verify:m4
npm run verify:m5
npm run verify:m6
npm run verify:m7
npm run verify:v2.1
npm run verify:m9:baseline
npm run verify:m9:plan-contract
npm run verify:m9:storage
npm run verify:m9:runner
npm run verify:m9:legacy-12
npm run verify:m9:structured-discovery
```
`verify:m6` includes the M1–M6 acceptance gates. M2–M6 install and use the pinned Playwright Chromium fixture where the vertical slice requires it.
`verify:m9:baseline` reruns the M0–M8 chain and checks the normalized M9.0 Golden Snapshot.

## Layout
- `apps/todo-fixture-target` - stable repository-owned Todo target for M9.4/M9.5
- `fixtures/legacy-todo` - migrated twelve-case TestPlan and Requirement map
- `packages/test-plan` — Declarative TestPlan model, schema, validator, loader, merge/digest and Fixture compatibility adapter
- `packages/schemas` — Draft 2020-12 JSON Schema bundle (single-source enums + limits + common $defs + 39 persistents)
- `packages/mcp-contracts` — 10 MCP tool contracts, Host Context contract, generated TypeScript types
- `packages/maintenance-cli` — maintenance-only CLI command manifest
- `apps/mcp-host-harness` — MCP Host Harness shell (loads contract inventory)
- `fixtures` — positive/negative persistents, host-contexts, run-state transitions, and M9 Golden Snapshots
- `tools` — generators (`gen-m0.mjs`, `gen-types.mjs`, `gen-docs.mjs`) and milestone verifiers
- `docs` — ADRs, Threat Models, milestone reports, and the M9 generated-plan migration plan
- See `AUTOPW_V2_1_MCP_FIRST_SPECIFICATION_RC5.md` (authoritative spec) and `AUTOPW_V2_1_MCP_FIRST_IMPLEMENTATION_MILESTONE_PLAN_RC5.md`.

## Regenerate artifacts
```bash
node tools/gen-m0.mjs    # schemas, tool contracts, fixtures, manifests
node tools/gen-types.mjs # TypeScript enum/union types
node tools/gen-docs.mjs  # ADRs, Threat Model, M0 report, README
```

## Authoritative source
The specification is frozen once M0 passes. Any deviation from the frozen contracts is a defect and must be resolved by editing the spec/schemas and bumping versions under an ADR, never by hand-patching an implementation.
