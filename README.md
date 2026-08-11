# AutoPW v2.1 (MCP-First)

AutoPW is a Profile-driven Web quality audit engine delivered as a Codex local MCP plugin. The MCP Server is the sole primary public entry; the maintenance CLI and internal Core API are not the audit path.

The repository has completed **M9.0–M9.9** and **M10 Release Hardening**. The default Core engines are now `plan_engine=declarative` and `discovery_engine=structured`. The Fixture/legacy pair remains available only as an explicit compatibility lane for one release cycle.

Earlier **M8 release hardening** established multi-browser execution, release compatibility, performance, fault, retention, and bounded soak gates. M10 extends that baseline with the generated-plan pipeline as the trusted default.

## Development language

M10 switches the trusted Core default to declarative planning and structured
discovery. Existing M0–M8 fixture acceptance continues through an explicit
legacy compatibility configuration in the host harness.

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
npm run verify:m9:requirements
npm run verify:m9:generated-plan
npm run verify:m9:coverage-gate
npm run verify:m9:external
npm run verify:m9
npm run verify:m10
npm run verify:v2.2
```
`verify:m6` includes the M1–M6 acceptance gates. M2–M6 install and use the pinned Playwright Chromium fixture where the vertical slice requires it.
`verify:m9:baseline` reruns the M0–M8 chain and checks the normalized M9.0 Golden Snapshot.

`verify:m9:coverage-gate` checks requirement reconciliation, evidence and cleanup
audits, coverage thresholds, gate ordering, and coverage/case-path reporting.
`verify:m9:external` exercises the thin external-target CLI in automatic,
`replace`, and `overlay` plan modes. The CLI accepts `--target`, `--url`,
`--plan`, `--plan-mode`, `--tier`, `--data-root`, and `--browser`; it writes
`latest.json` and run-scoped reports under the selected data root.
`verify:m10` checks the default declarative path, dual-run compatibility lane,
release metrics, deterministic identifiers, security boundaries, cache recovery,
and the API response-body limit. `verify:v2.2` is the complete v2.2 release
chain and intentionally includes the prior v2.1 and M9 gates.

## Layout
- `apps/todo-fixture-target` - stable repository-owned Todo target for M9.4/M9.5 and M9.9 external-target verification
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
