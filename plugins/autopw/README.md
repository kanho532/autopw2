# AutoPW Codex Plugin

AutoPW provides trusted local web application coverage derivation, test-plan
generation, Playwright execution, evidence, and quality reports through a
standard MCP server. Before using audit tools, explicitly trust a workspace
with the packaged `autopw` CLI; MCP tools cannot create or expand trust.

The plugin exposes one `web-audit` skill. Tier behavior is deliberate:

- `smoke` runs AutoPW only and produces no CR artifacts.
- `fast` exports a checksummed evidence bundle and uses the focused CR phases
  (`cr-intake`, `cr-evidence`, `cr-issues`, `cr-gate`, `cr-report`).
- `full` exports the same evidence contract and hands it to the complete
  canonical `cr-agent` lifecycle.

AutoPW never substitutes its test gate for the canonical CR release gate.

See `docs/codex-plugin-installation.md` in the repository for setup and
security details.
