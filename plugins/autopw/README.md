# AutoPW Codex Plugin

AutoPW provides trusted local web application coverage derivation, test-plan
generation, Playwright execution, evidence, and quality reports through a
standard MCP server. Before using audit tools, explicitly trust a workspace
with the packaged `autopw` CLI; MCP tools cannot create or expand trust.

`export_run_report` generates a detailed Chinese report at
`.autopw/reports/<run_id>/` in the tested workspace. The report records every
executed operation, expected and actual behavior, concise possible cause, code
location, and evidence link. Its sibling `playwright-report/` directory keeps
the Playwright trace, screenshot, console, API response, and execution index in
the same delivery location. This workflow is self-contained and does not call
`cr-agent`.

See `docs/codex-plugin-installation.md` in the repository for setup and
security details.
