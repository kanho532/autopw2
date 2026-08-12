---
name: web-audit
description: "Run, triage, and report a trusted AutoPW web audit with tier-aware CR integration: smoke uses AutoPW only, fast adds evidence-focused CR phases, and full uses the complete canonical CR lifecycle."
---

# AutoPW audit

Use this as the single AutoPW skill for coverage derivation, execution, failure
triage, evidence export, and CR handoff.

Before any AutoPW call, call `autopw_status` with the user's absolute workspace
path. Never invent a workspace path, target URL, origin, authentication scope,
workspace ID, CR range, or release baseline. If trust is missing, instruct the
user to run the explicit `autopw trust` CLI command.

## Choose the operation

- For scope, requirements, or coverage only, call `derive_coverage`. Poll with
  `get_operation_status`, then read `get_operation_result`. Do not run CR phases
  for a derivation-only request.
- For an authorized audit, call `run_audit` with the requested tier. Poll with
  `get_run_status`, then read `get_run_result` and `explain_run`.
- For failure explanation only, verify trust, then use `get_run_result` and
  `explain_run`. Do not rerun unless requested.
- Use `cleanup_run` only when the user explicitly requests retained-artifact
  deletion.

Default to `fast` when the user authorizes an audit but does not select a tier.

## Tier routing

### smoke

Run AutoPW only. Summarize the AutoPW gate, failed or incomplete cases, and
evidence handles. Do not call `prepare_cr_evidence`. Do not use any CR skill or
worker, do not create `CR/` artifacts, and do not issue a code-merge or release
decision.

### fast

After the run is terminal, call `prepare_cr_evidence` with
`review_tier: "fast"`. Treat its bundle as evidence input, never as the CR
decision.

Use the installed canonical CR lifecycle for these phases only:

1. `cr-intake` — normalize project, CR intent, type, range, and output mode.
2. `cr-evidence` — audit AutoPW results, coverage, trace, screenshots, and
   missing UAT/rollback evidence.
3. `cr-issues` — persist normalized findings; do not convert every failed test
   into P1 automatically.
4. `cr-gate` — calculate the decision from the issue/check registry.
5. `cr-report` — render the Chinese report from the existing gate and issues.

Do not claim `cr-branch-governance`, `cr-diff`, `cr-scope`, or
`cr-technical-review` ran in fast mode. If any is required for the requested
merge or release decision, record the missing dependency and keep
`Report State: stage_report`.

### full

After the run is terminal, call `prepare_cr_evidence` with
`review_tier: "full"`, then use `cr-agent` as the canonical controller for:

1. `cr-intake`
2. `cr-branch-governance`
3. `cr-diff`
4. `cr-scope`
5. `cr-technical-review`
6. `cr-evidence`
7. `cr-issues`
8. `cr-gate`
9. `cr-report`

Use the canonical CR rules, coverage gate, issue registry, and Chinese report
template. The AutoPW gate describes test execution only and must never override
`cr-gate`. If the canonical CR skills are unavailable, return the exported
evidence path and report the CR dependency as blocked; do not synthesize a
replacement release gate or formal CR report inside AutoPW.

## Output contract

For every tier, report the tier, run ID, AutoPW gate, audit state, and evidence.
For fast and full also report the CR case, CR type, range, report state, allowed
action, blocked action, next action, evidence bundle, and persisted CR report
path when one was written.
