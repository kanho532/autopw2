# Operations Guide

Run `npm run verify:v2.1` before release. For production-like checks, also run `npm run audit:prod`, the full browser matrix, upgrade/rollback rehearsal and the 24-hour soak under the fixed environment in the M8 report.

Monitor `get_run_status` and `get_operation_status`; polling is read-only and bounded. Accepted handles survive MCP transport and server restart because registry, run state, checkpoints and artifacts are durable. Use `sweep()` or the maintenance CLI after retention TTLs expire. Tombstones remain queryable as `RESULT_EXPIRED` until their retention policy removes them.

If a worker lease is stale, use the resume workflow. Never delete a live data root while a worker is running; stop/drain the worker first, then perform cleanup.

## Declarative plans and case evidence

M9.1 provides the internal `@autopw/test-plan` contract. Plans are declarative
data and are validated against the supported UI/API/Hybrid step DSL; arbitrary
JavaScript, shell commands, environment-variable reads, XPath, and automatic
CSS locators are rejected. `fromFixturePlan()` is the compatibility adapter
used during migration.

M9.2 stores new case evidence under `runs/<run_id>/cases/<case_id>/` and records
case artifacts in `artifact-index.json`. New case artifact Handles are opaque
`art_<digest>` values and resolve through the index with kind, path, size, and
SHA-256 checks. Existing run-level Handles remain readable for M0–M8
compatibility.

## External project reports

External-project integration is planned for M9.9. M9.0-M9.2 do not expose a supported external-project CLI; use the internal MCP/runtime entry points and the M9 contract/storage verifiers until the integration milestone is implemented.
