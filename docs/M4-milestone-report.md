# Milestone M4: Planner Safely Integrated

Status: complete. Acceptance command: `npm run verify:m4`.

M4 adds a strict TypeScript Planner layer to the formal audit path. `PlannerProvider`, `DeterministicFixturePlanner` and `LocalStructuredPlannerProvider` receive typed Candidate Catalogs and return candidate IDs only. `validatePlannerOutput` checks candidate existence, case/route binding, locator uniqueness, input and expectation binding, strong normal-scenario assertions, production mutation safety and unsafe free-form output.

`PlanTemplateCache` stores only candidate selections. Its canonical key includes profile, policy, scenario, route, discovery, engine/schema, provider/model, tier, scope and auth-scope inputs while explicitly excluding `run_id`, seed and artifact paths. Cache hits are revalidated before use and formal Runs persist `planner-input.json`, `planner-output.json`, `plan-template.json` and `planner-audit.json`. The compiler now materializes the executable fixture plan from the validated action candidate IDs; it no longer ignores Planner output when building the execution input.

Untrusted discovery observations are marked and bounded as data; the provider has no tool surface. Unknown candidates, arbitrary URLs, selector/code fields, weak assertions and unsafe descriptions are rejected. Provider/model/timeout/token settings are installation configuration on `AuditVerticalSlice`/`McpServer`, not untrusted `run_audit` parameters. Verification covers these negative paths, cache/auth isolation and a formal MCP audit.

The implementation language remains strict TypeScript for runtime code. `.mjs` is retained only for deterministic verification and repository generation scripts.
