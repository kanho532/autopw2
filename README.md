# AutoPW v2.1 (MCP-First)

AutoPW is a Profile-driven Web quality audit engine delivered as a Codex local MCP plugin. The MCP Server is the sole primary public entry; the maintenance CLI and internal Core API are not the audit path.

This repository is at **Phase 0 (Milestone M0: MCP Contract Frozen)**. No implementation code runs yet; this milestone freezes the public Tool Schema Bundle, the persistent Data Schema Bundle, the Host Context contract, the state machine and the security/retention/threat/ADR baselines that every later milestone must satisfy.

## Run the M0 acceptance gate
```bash
npm install
npm run verify:m0
```
`verify:m0` returns 0 only when all mandatory M0 checks pass. Subsets: `npm run contract`, `npm run schema:test`, `npm run docs:check`.

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
