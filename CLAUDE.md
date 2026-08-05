# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository nature

This is a **specification-only** repository. There is no source code, no build system, no package manifests, and no git history — only two Chinese-language design documents for **AutoPW v2.1** (a Profile-driven Web quality audit engine):
- `AUTOPW_V2_1_SPECIFICATION_RC2.md` — the self-contained technical specification (RC2, dated 2026-08-05). Treated as authoritative once frozen: any implementation deviation is a defect.
- `AUTOPW_V2_1_IMPLEMENTATION_MILESTONE_PLAN.md` — the phased delivery plan (M0→M8) that decomposes the spec into verifiable milestones.

When asked to "implement," "add," or "fix" something here, first recognize whether the change belongs at the spec level (edit the markdown) or in a downstream code project that has not yet been created. Do not invent code structure that the spec does not define or scaffold code into this repo unless explicitly requested — Phase 0 of the milestone plan is where the `packages/` layout and Schema bundle are meant to be created, and that work does not exist here.

## How the two documents relate

The spec and the milestone plan are intentionally decoupled:

- The **specification** defines *what* the system is: state machine, data contracts, invariants, security boundaries. Its §15 ("测试要求强制" / mandatory test requirements) and core invariants (§1.4) are non-negotiable hard constraints. Any contradiction found in the spec must be fixed by editing the spec, never silently resolved in an implementation.
- The **milestone plan** defines *the order to build it*: M0 (Specification Frozen) → M1 (State Truth) → M2 (Deterministic Audit Loop) → M3 (Coverage Intelligence) → M4 (Planner Safely Integrated) → M5 (Operationally Reliable) → M6 (Pipeline Integrated) → M7 (Security Boundary Enforced) → M8 (v2.1 Final Released). Later milestones must not break earlier invariants, and the model/Planner is deliberately integrated only at Phase 4 — the deterministic loop (state, storage, compiler, execution, audit, gate) must stand on its own first.

The milestone plan proposes a `packages/` and `tests/` directory layout (§0.2C) and `npm run verify:m0` … `verify:v2.1` scripts (§四), but none of these exist yet — they are forward references inside the plan.

## Architectural big picture (from the spec)

AutoPW audits web apps Profile-driven, with deterministic coverage derivation as the skeleton and a constrained Planner as an assistant. Three entry points (CLI / SDK / MCP) all share one orchestration core, one Schema bundle, one gate evaluator, one security policy. MCP is deliberately a thin layer that does **not** expose low-level fill/compile/execute tools, to stop an agent from bypassing the state machine.

Five mental models to keep in mind when reading or editing either document:

1. **Phases vs Run Status vs Audit Status are orthogonal.** Normal phases run `CREATED → ... → GATED`. A controlled **TERMINALIZING** branch exists for failures that still have enough structure to produce a quality gate (e.g. Planner retries exhausted → PLAN_DEFECT → incomplete). A **Fatal Failure** (storage/schema/trust integrity lost) is *separate*: it sets `run_status=FAILED`, writes `failure.json`, releases the lease, and produces **no quality gate** — never fake one. `INCOMPLETE` is an audit result, not a phase. The transition table in §7.2 is fixed; any off-table transition is `RUN_PHASE_INVALID`.
2. **Logical Case vs Execution Instance.** One `feature × scenario` logical case can expand to multiple execution instances in `full` tier (every browser × viewport). Audit reconciles *both* sets independently: `planned cases == generated cases`, and `required executions == collected == accounted`.
3. **The model only selects Candidate IDs.** Discovery and the Scenario Contract produce a `CandidateCatalog`. The Planner picks IDs from typed allow-lists; it emits no code, CSS, XPath, free URLs, or paths. The Plan Validator hard-checks this; violations retry then become PLAN_DEFECT. The compiler is deterministic and only imports `@autopw/execution-fixture`.
4. **Effective tier is computed per feature** before priority/scenario pruning (§8.5), and one Run can contain mixed tiers — solved by the Execution Batch Planner. Gate priority is fixed and not configurable: `incomplete > infra > fail > unstable > pass`. `results.json` is the single machine gate source of truth; reports cannot rewrite it.
5. **Trust can only tighten.** `Host Trust Context` (trusted / untrusted_pr) is injected by the CI/host, never promotable by the project's Profile. untrusted_pr forces `connect` mode, refuses the PR's own startup scripts/Adapters/Policy, and uses one-shot least-privilege identities.

When a claim seems ambiguous, the spec is the source of truth — check §7 (state machine), §8 (derivation), §10 (execution), §11 (gate), §15 (mandatory invariants). The numbered invariants in §15 (INV-STATE-*, INV-STRUCT-*, INV-GATE-*, etc.) are the acceptance criteria echoed by each milestone.

## Editing conventions for these documents

- The spec is bilingual-friendly technical Chinese with heavy use of tables, fenced code blocks as normative structural examples (not literal files), and `ts`/`json`/`yaml` blocks. Match the surrounding register, table style, and §-numbering when editing.
- The spec repeatedly distinguishes *normative structure examples* ("规范性结构示例") from *JSON Schema*. Never turn a structural example like `{"issues": "Issue[]"}` into a real schema; real persistence files must each have a Draft 2020-12 JSON Schema (§13.1 lists the canonical Schema set).
- When you change a behavior in the spec, propagate it to: the matching §15 invariant, the matching milestone's acceptance criteria & key tests, and Appendix D's v2.0→v2.1 change log when appropriate. A spec edit that does not update its invariants is itself a defect.
- Cross-document references (e.g. "见第十二章", "INV-PLAN-01") use the spec's own section/anchor scheme — keep those consistent.