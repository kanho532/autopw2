# M11 — Generalized Evidence, Application Modeling and Trustworthy Triage

## 1. Objective

M11 replaces the fixture-driven generation assumptions in the current pipeline with evidence-backed application modeling. The target outcome is not merely more generated cases; it is a generator that can explain why an operation, payload, fixture and oracle are trustworthy and that does not report generator mistakes as product defects.

The existing M9/M10 declarative TestPlan, execution, evidence, audit and MCP boundaries remain the compatibility baseline.

## 2. Delivery rules

- Each phase must build and pass its bounded verifier before it is merged.
- Existing M9/M10 fixtures remain regression assets, not generalization evidence.
- New facts, relations, requirements and oracles retain their evidence references.
- Ambiguous generation blocks coverage and produces `PLAN_DEFECT`/`incomplete`; it never silently becomes a product defect.
- Production and destructive permissions are trusted Host policy, never target content or an untrusted tool parameter.
- Public contract changes are additive or versioned and retain a compatibility reader.

## 3. Phase plan

### Phase 0 — Safety containment and characterization

Status: implemented in the first M11 delivery.

Deliverables:

- Propagate the trusted production flag from Core to the declarative runner.
- Default destructive generation to deny; only an explicit trusted Host policy may allow it outside production.
- Add `acceptable_statuses` to lifecycle API requests.
- Require generated setup and cleanup requests to declare acceptable HTTP outcomes.
- Do not perform a second DELETE for a case whose test body already proves deletion.
- Classify generated assertion/plan failures as `PLAN_DEFECT` until strong provenance-aware triage exists.
- Make `PLAN_DEFECT` and `TEST_DEFECT` force an `incomplete` Gate.
- Replace Audit's fixed HIGH confidence with a conservative classification-aware value.
- Add full Core production-mutation and false-product-defect regression tests.

Exit criteria:

- A production Core run performs zero generated writes.
- A generated oracle mismatch cannot create `PRODUCT_DEFECT`.
- Setup/cleanup non-acceptable statuses fail their lifecycle phase.
- Existing trusted manual assertions can still report a product defect.

### Phase 1 — Evidence and ApplicationGraph contract

Status: implemented in the second M11 delivery.

Deliverables:

- Add a standalone `@autopw/application-graph` package.
- Define versioned Evidence, Operation, Resource, Field, Route, Control, Workflow, Edge and Diagnostic contracts.
- Convert current Discovery facts into deterministic evidence and graph nodes without changing requirement generation yet.
- Preserve evidence conflicts and weak associations as diagnostics instead of silently overwriting them.
- Persist `evidence-facts.json`, `application-graph.json` and `graph-diagnostics.json` for previews and runs.
- Add a deterministic graph verifier covering multi-resource grouping and conflicting evidence.

Exit criteria:

- Graph identifiers and ordering are deterministic across repeated builds.
- Multiple resources remain separate even when they expose the same HTTP methods.
- Every graph node and edge has evidence references.
- Conflicting operation evidence is visible in diagnostics.

### Phase 2 — Generalized discovery adapters

Status: implemented in the third M11 delivery.

Deliverables:

- Ingest OpenAPI 3.x/Swagger and standalone JSON Schema documents from JSON or YAML.
- Use TypeScript AST adapters for Fetch, Axios, request wrappers, Express-style routers, NestJS decorators, Fastify and Next.js route handlers.
- Record bounded live document/fetch/XHR request and response facts as `RUNTIME` evidence.
- Keep regex discovery only as a calibrated `0.45` confidence fallback when no structured endpoint adapter succeeds for a file.
- Preserve AST, OpenAPI, runtime and fallback evidence independently and fuse matching claims in ApplicationGraph without source-precedence overwrite.

Exit criteria:

- A controlled multi-framework fixture exposes all expected endpoints and schema constraints.
- OpenAPI and AST evidence for the same operation remain separately traceable on one graph node.
- Live request and response observations are represented as runtime evidence.

### Phase 3 — Requirement Engine v2

Status: implemented in the fourth M11 delivery.

Deliverables:

- Replace the global first-match derivation function with a standalone ApplicationGraph-driven Requirement Engine v2.
- Derive requirements inside each resource partition and cover every operation, constrained field and evidenced workflow.
- Split validation requirements into required, min/max length, enum, numeric boundary, pattern and format atoms.
- Store operation/resource/field/workflow IDs, Evidence references, payload strategy, fixture strategy and oracle specification on every requirement.
- Keep legacy fact IDs in `source_refs` for planner compatibility while graph Evidence IDs remain authoritative provenance.
- Block requirements whose payload synthesis, fixture operations or oracle response contract is not proven.

Exit criteria:

- Resources that expose identical HTTP methods never share operations, fields or fixtures.
- Every graph operation maps to at least one deterministic requirement.
- All constraint atoms are independently visible and traceable.
- Missing payload, fixture or oracle evidence yields `BLOCKED` with a concrete reason.

### Phase 4 — Schema-driven payload and fixture synthesis

Status: implemented in the fifth M11 delivery.

Deliverables:

- Generate deterministic valid, invalid and boundary values from schemas.
- Resolve identity from response schemas, Location headers or explicit mappings.
- Forbid catalog-wide fallback to the first POST endpoint.
- Require fixture create/read/update/delete operations to belong to the same graph resource.
- Use explicit seed/manual fixtures for resources without a create operation; otherwise block.

Exit criteria:

- Repeated synthesis produces byte-for-byte identical payload and fixture contracts.
- Required, enum, string and numeric constraints produce independently selectable invalid or boundary variants.
- Response-body and `Location` identities compile without assuming a global `body.id` convention.
- Multi-resource compilation contains zero cross-resource fixture bindings.
- Read-only resources remain blocked until an explicit seed/manual fixture is supplied.

### Phase 5 — Semantic Oracle and TestPlan 1.1

- Add safe relation and collection assertions without JavaScript evaluation.
- Compile refresh, persistence, summary, count and search oracles into semantic assertions.
- Grant oracle coverage only when the complete oracle specification is compiled and bound.
- Read TestPlan 1.0 and 1.1; write 1.1 only when new steps are used.

### Phase 6 — Provenance-aware triage, Gate and coverage

- Execution emits low-level failure signals and expected/actual context.
- Triage combines plan origin, evidence strength, oracle strength and phase to classify issues.
- Report tier coverage separately from discovered-scope coverage.
- Add generated-case precision, false-product-defect rate, semantic-oracle coverage and cleanup integrity.

### Phase 7 — Safe live UI exploration

- Implement bounded BFS over routes and read-only interactions.
- Deduplicate by route and DOM/state fingerprint.
- Associate control, interaction, network operation, response and UI mutation evidence.
- Do not submit mutating controls without an explicit trusted policy and isolated fixture strategy.

### Phase 8 — Generalization acceptance and rollout

- Add REST multi-resource, Axios, nested router, Next.js, OpenAPI-only, RBAC, pagination, seeded-data, read-only, GraphQL/RPC and URL-only targets.
- Run the ApplicationGraph path in dual mode before retiring legacy heuristics.
- Require zero cross-resource fixture bindings and zero false product defects in controlled generator-error fixtures.

## 4. Target pipeline

```text
OpenAPI / AST / Runtime / DOM / Regex
                  |
                  v
           Evidence Facts
                  |
                  v
          ApplicationGraph
      Operations / Resources / Fields
       Routes / Controls / Workflows
                  |
                  v
       Requirement Engine v2
                  |
          +-------+-------+
          |               |
   deterministic       ambiguous
     compiler              |
          |                v
          |             BLOCKED
          v
       TestPlan
          |
       Execution
          |
        Triage
          |
   Audit / Gate / Report
```

## 5. Global definition of done

- Generic planner/compiler code contains no Todo-specific field, path or identity literals.
- Controlled multi-resource targets achieve exact expected operation and resource grouping.
- Generated ambiguity never becomes a high-confidence product defect.
- Production mutation protection is verified through the complete Core path.
- Every mutating case has a proven fixture strategy and verified cleanup/postcondition.
- Reports expose both in-tier and discovered-scope denominators.
- `verify:v2.2` and the new M11 verifier suite pass.
