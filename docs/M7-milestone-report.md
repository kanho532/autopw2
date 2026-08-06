# Milestone M7: Agent Workflow Complete

Status: Complete (`npm run verify:m7` passed).

M7 keeps the frozen ten-tool MCP surface and adds the Agent-facing behavior around it:

- bounded status views with counts, tier/batch aggregation, recent events and terminal-aware polling;
- page/page_size result views for issues, CDD summaries and Explain, plus `focus_case_id` filtering;
- run-bound artifact references whose handle, kind and workspace are checked before reads;
- repeatable, best-effort progress notifications. Status and persisted artifacts remain the source of truth;
- a maintenance-only TypeScript CLI for doctor, schema/profile validation, offline storage migration, server/run inspection and CI gate mapping.

The CI adapter consumes the persisted `results.json` gate and returns quality exit codes (0 pass, 1 fail/unstable, 2 incomplete/infra). Parse or storage failures use operational exit code 70 and never create a quality result.

The default profile template is `profiles/default/profile.json`. Installation and migration guidance is in `docs/installation.md` and `docs/migration.md`.
