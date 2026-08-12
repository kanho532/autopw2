# Changelog

## 2.2.0 Codex tiered CR integration

- Consolidate audit execution, coverage, triage, and CR handoff into one
  `web-audit` skill.
- Keep `smoke` AutoPW-only; route `fast` through evidence-focused CR phases and
  `full` through the canonical complete CR lifecycle.
- Add `prepare_cr_evidence`, a checksummed evidence export that deliberately
  does not duplicate CR severity, release gate, scoring, or report rendering.

## 2.2.0

- Initial Codex Plugin package with bundled skills and a version-pinned STDIO
  MCP runtime.
