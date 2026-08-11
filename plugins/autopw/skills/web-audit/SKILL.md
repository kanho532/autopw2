---
name: web-audit
description: Run a safe AutoPW coverage derivation or web audit for a user-trusted workspace.
---

Before calling `derive_coverage` or `run_audit`, call `autopw_status` with the
user's absolute workspace path. Do not invent a workspace path, target URL,
allowed origin, authentication scope, or workspace ID. If the workspace is not
trusted, tell the user to run the explicit `autopw trust` CLI command.

Use `derive_coverage` first when the user asks for scope, requirements, or
coverage only. Use `run_audit` only when the user authorizes execution. Poll
with `get_run_status`, then read `get_run_result` and `explain_run`.
