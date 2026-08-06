# AutoPW v2.1 (MCP-First)

AutoPW is a Profile-driven Web quality audit engine delivered as a Codex local MCP plugin. The MCP Server is the sole primary public entry; the maintenance CLI and internal Core API are not the audit path.

This repository has completed **M3 (Coverage Intelligence Ready)**. M0 freezes the public contracts; M1 provides the durable MCP Control Plane; M2 runs a deterministic Chromium audit through MCP; M3 adds bounded Discovery, Diff/Derivation, CDD Preview and honest full-matrix projections.

## Run the acceptance gates
```bash
npm install
npm run verify:m0
npm run verify:m1
npm run verify:m2
npm run verify:m3
```
`verify:m3` includes the M1, M2 and M3 acceptance gates. M2 installs and uses the pinned Playwright Chromium fixture.

## Layout
- `packages/schemas` — Draft 2020-12 JSON Schema bundle (single-source enums + limits + common $defs + 39 persistents)
- `packages/mcp-contracts` — 10 MCP tool contracts, Host Context contract, generated TypeScript types
- `packages/maintenance-cli` — maintenance-only CLI command manifest
- `apps/mcp-host-harness` — MCP Host Harness shell (loads contract inventory)
- `fixtures` — positive/negative persistents, host-contexts, run-state transitions
- `tools` — generators (`gen-m0.mjs`, `gen-types.mjs`, `gen-docs.mjs`) and `verify-m0.mjs`
- `docs` — ADRs, Threat Model v1, M0 milestone report
- See `AUTOPW_V2_1_MCP_FIRST_SPECIFICATION_RC5.md` (authoritative spec) and `AUTOPW_V2_1_MCP_FIRST_IMPLEMENTATION_MILESTONE_PLAN_RC5.md`.

## Regenerate artifacts
```bash
node tools/gen-m0.mjs    # schemas, tool contracts, fixtures, manifests
node tools/gen-types.mjs # TypeScript enum/union types
node tools/gen-docs.mjs  # ADRs, Threat Model, M0 report, README
```

## Authoritative source
The specification is frozen once M0 passes. Any deviation from the frozen contracts is a defect and must be resolved by editing the spec/schemas and bumping versions under an ADR, never by hand-patching an implementation.
