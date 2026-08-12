---
name: web-audit
description: Run, explain, and report a safe AutoPW web audit for a user-trusted workspace.
---

Before calling `derive_coverage` or `run_audit`, call `autopw_status` with the
user's absolute workspace path. Do not invent a workspace path, target URL,
allowed origin, authentication scope, or workspace ID. If the workspace is not
trusted, tell the user to run the explicit `autopw trust` CLI command.

Use `derive_coverage` first when the user asks for scope, requirements, or
coverage only. Use `run_audit` only when the user authorizes execution. Poll
with `get_run_status`, then read `get_run_result` and `explain_run`.

After a run reaches a terminal result, call `export_run_report`. AutoPW itself
generates the formal Chinese report; do not call `cr-agent` or any CR skill.
The export must remain inside the tested project at
`.autopw/reports/<run_id>/` and keeps these files together:

- `report.md` and `report.html`: detailed Chinese review report;
- `results.json` and `report-manifest.json`: machine-readable result and hashes;
- `playwright-report/index.html`: Playwright execution and evidence index;
- `playwright-report/test-results/`: trace, screenshot, console, and API evidence.

For each case, report the concrete operation sequence, expected and actual
result, status, duration, concise possible cause, concrete code or endpoint
location, and evidence links. Keep possible-cause analysis short: return one
high-probability explanation when the signal is specific; otherwise say that
the evidence is insufficient and ask the user to inspect the linked trace and
source location. Never present a possible cause as a confirmed root cause.

For a previous run, use the same flow: verify trust, call `get_run_result` and
`explain_run`, then call `export_run_report`. Use `cleanup_run` only when the
user explicitly asks to remove retained artifacts.
