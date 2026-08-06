# M8 Milestone Report — Release Hardening

M8 closes the v2.1 MCP-First implementation with a deterministic release gate. The runtime accepts an explicitly bounded browser matrix of Chromium, Firefox or WebKit, viewport, locale and approved auth-scope dimensions. Full-tier execution projects instances before Run creation and refuses `MATRIX_BUDGET_EXCEEDED` instead of silently trimming.

The M8 verifier covers the three-browser matrix, logical and instance reconciliation, artifact handle resolution, discovery and derivation timing, planner cache hits, a 100k tombstone dataset, atomic half-write recovery, restart/polling behavior, deterministic crash injection, storage migration and server/worker protocol mismatch. `npm run verify:v2.1` is the required local release command.

The fixed CI environment is Node 20+, 4 vCPU, 8 GB RAM, pinned Playwright browsers, local demo target, fixture planner, no external network, and the frozen profile/policy/contract bundle. The bounded soak suite is the CI representation of the long-running gate; release candidates additionally require the operational 24-hour server soak, cross-platform browser run, upgrade/rollback rehearsal, security review and `npm audit --omit=dev`.

Known limitations that remain intentionally outside M8 are OS-level sandbox enforcement, DNS rebinding defenses beyond the host/browser boundary, and a production planner/executor implementation. They are recorded in [known-limitations.md](known-limitations.md).
