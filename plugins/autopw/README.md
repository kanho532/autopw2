# AutoPW Codex Plugin

AutoPW provides trusted local web application coverage derivation, test-plan
generation, Playwright execution, evidence, and quality reports through a
standard MCP server. Before using audit tools, explicitly trust a workspace
with the packaged `autopw` CLI; MCP tools cannot create or expand trust.

For release-style review, the `cr-report` skill and `generate_cr_report` tool
turn native `@playwright/test` output into a formal Chinese CR package. The
workflow preserves Playwright's native HTML report, `results.json`, and
`trace.zip` evidence, then writes a reader-facing report plus structured CR
coverage artifacts under `CR/<project>/` in the trusted workspace.

See `docs/codex-plugin-installation.md` in the repository for setup and
security details.
