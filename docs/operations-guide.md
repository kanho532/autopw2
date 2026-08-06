# Operations Guide

Run `npm run verify:v2.1` before release. For production-like checks, also run `npm run audit:prod`, the full browser matrix, upgrade/rollback rehearsal and the 24-hour soak under the fixed environment in the M8 report.

Monitor `get_run_status` and `get_operation_status`; polling is read-only and bounded. Accepted handles survive MCP transport and server restart because registry, run state, checkpoints and artifacts are durable. Use `sweep()` or the maintenance CLI after retention TTLs expire. Tombstones remain queryable as `RESULT_EXPIRED` until their retention policy removes them.

If a worker lease is stale, use the resume workflow. Never delete a live data root while a worker is running; stop/drain the worker first, then perform cleanup.
