# Milestone M3: Coverage Intelligence Ready

Date: 2026-08-06
Status: Complete (acceptance met)

## Delivered

- Bounded TypeScript Discovery over the authorized project subtree plus an allowed-origin target fetch.
- Candidate catalog for routes and controls with page/source observations explicitly marked untrusted.
- Discovery budgets and split wall-clock metrics.
- Deterministic Diff Analyzer with NOOP handling, Git name-status parsing and route-map feature impact mapping.
- Derivation Engine for scenario observations, P0/P1/P2, effective tiers, PLANNED/BLOCKED states and CDD Draft data.
- Stable Execution Instance Planner with full browser×viewport×locale×auth expansion, dimension projections and narrowing suggestions.
- Preview and formal Run now share the same Discovery/Derivation pipeline and input-version digest fields.
- Matrix budget preflight returns `MATRIX_BUDGET_EXCEEDED` before creating an Operation/Run.

## Acceptance

- `npm run verify:m0`: 13 passed, 0 failed
- `npm run verify:m1`: 31 passed, 0 failed
- `npm run verify:m2`: 15 passed, 0 failed
- `npm run verify:m3`: 19 passed, 0 failed
- `npm run build:types`: passed

## Explicitly not in M3

Real model planning, final Plan Cache, cross-process Worker takeover and untrusted PR adapters remain later milestones.
