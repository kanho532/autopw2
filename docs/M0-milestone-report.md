# Milestone M0: MCP Contract Frozen — Report

Date: 2026-08-05
Status: Complete (acceptance met)

## Acceptance (npm run verify:m0 = 13 passed, 0 failed)
- 01 tool examples pass tool schema; 05 every tool has an error-path example
- 02 persistent examples pass corresponding schema (positives pass, negatives fail)
- 03 all schema references resolvable through common $defs
- 04 enums identical across docs table, schema $defs and generated TypeScript types
- 06 unique schema $id per persistent; fixtures map 1:1 to schemas
- 07 workspace/path/ID length and format limits fixed and finite
- 08 transition table is closed; no undefined transitions; matches transition fixtures
- 09 tool params cannot elevate trust/auth/network; host context narrows only
- 10 CLI is maintenance-only; MCP is the audit entry
- canonical: all 39 §0.2C schemas present; gate priority fixed; lease safe-window factor holds

## Deliverables
- Tool Schema Bundle: packages/mcp-contracts/contracts/tools/*.tool.json (10 tools)
- Persistent Data Schema Bundle: packages/schemas/schemas/*.schema.json (39 persistents + common $defs registry)
- TypeScript types: packages/mcp-contracts/src/types/enums.ts (generated from single-source enums.mjs)
- MCP Host Harness shell: apps/mcp-host-harness (loads contract inventory; no real MCP server in M0)
- Positive/negative fixtures: fixtures/persistents, fixtures/host-contexts, fixtures/run-states
- ADRs: docs/adr/ADR-001..ADR-015.md
- Threat Model v1: docs/threat-model.md
- Maintenance CLI manifest: packages/maintenance-cli/commands.json
- Verifier: tools/verify-m0.mjs (npm run verify:m0)

## Explicitly NOT done in M0 (per spec 0.7)
No Playwright, no real Worker, no Planner, no real Discovery, no full CLI audit commands. These begin at M1+.

## Change-management
M0 is an ADR-governed baseline (ADR-015). Breaking changes require a new ADR, a Schema/Tool version bump, regeneration and a rerun of all affected verify:mN.
