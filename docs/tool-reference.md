# Tool Reference

The public surface is the frozen ten-tool MCP contract in `packages/mcp-contracts/contracts/tools`. Mutating tools return `accepted` and are polled through their matching status tool. Result tools return `not_ready` until the durable operation or Run reaches its terminal state.

`run_audit` accepts an optional matrix with `browsers`, `viewports`, `locales` and `auth_scope_ids`. Matrix auth scopes must be approved by the host context. Full-tier instance projection happens before Run creation; an over-budget request returns `MATRIX_BUDGET_EXCEEDED`.

Artifact handles are run-bound and kind-bound. Read artifacts through the result or explanation tool; do not construct paths from tool output.

The Codex plugin's `export_run_report` tool renders a detailed Chinese report from a completed run into the trusted project at `.autopw/reports/<run_id>/`. `report.md` and `report.html` include each concrete operation, expected and actual result, concise possible cause, code location, and evidence links. `playwright-report/index.html`, its machine-readable `results.json`, and `test-results/` keep Playwright traces and related evidence beside that report. This is an AutoPW-native report flow and does not invoke `cr-agent`.
