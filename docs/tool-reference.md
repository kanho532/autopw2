# Tool Reference

The public surface is the frozen ten-tool MCP contract in `packages/mcp-contracts/contracts/tools`. Mutating tools return `accepted` and are polled through their matching status tool. Result tools return `not_ready` until the durable operation or Run reaches its terminal state.

`run_audit` accepts an optional matrix with `browsers`, `viewports`, `locales` and `auth_scope_ids`. Matrix auth scopes must be approved by the host context. Full-tier instance projection happens before Run creation; an over-budget request returns `MATRIX_BUDGET_EXCEEDED`.

Artifact handles are run-bound and kind-bound. Read artifacts through the result or explanation tool; do not construct paths from tool output.

The Codex plugin adds `prepare_cr_evidence` for terminal `fast` and `full`
runs. It exports checksummed AutoPW results, reports, execution metadata, and
case evidence to `.autopw/cr-evidence/<run_id>/`. The bundle is input to the
canonical CR lifecycle; it does not assign CR severity, calculate a release
gate, score the change, or render the formal CR report.
