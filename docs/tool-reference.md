# Tool Reference

The public surface is the frozen ten-tool MCP contract in `packages/mcp-contracts/contracts/tools`. Mutating tools return `accepted` and are polled through their matching status tool. Result tools return `not_ready` until the durable operation or Run reaches its terminal state.

`run_audit` accepts an optional matrix with `browsers`, `viewports`, `locales` and `auth_scope_ids`. Matrix auth scopes must be approved by the host context. Full-tier instance projection happens before Run creation; an over-budget request returns `MATRIX_BUDGET_EXCEEDED`.

Artifact handles are run-bound and kind-bound. Read artifacts through the result or explanation tool; do not construct paths from tool output.

The Codex plugin additionally exposes `generate_cr_report` as a trusted-workspace
delivery tool. It consumes a workspace-contained native `@playwright/test`
`results.json` (and adjacent HTML/trace artifacts), then writes a formal Chinese
CR report plus coverage artifacts under `CR/<project>/`. It never replaces the
native Playwright HTML report or trace files.
