# Known Limitations

- The fixture executor is deterministic and the formal planner output is persisted, but the current demo execution path still consumes the frozen fixture plan rather than an arbitrary external planner plan.
- OS/container sandboxing, complete DNS rebinding prevention and browser installation management belong to deployment infrastructure.
- The CI soak is bounded for repeatability; a release candidate must run the operational 24-hour soak separately.
- Lease contention is verified through deterministic CAS/fault fixtures; production deployments should add a true multi-process race test.
- The fixture host supplies the approved origin snapshot. Deployments must ensure the execution adapter receives the resolved host policy rather than a target-derived allowlist.
# M10 Known Limitations

- The fixture/legacy compatibility lane is retained temporarily for M0–M8
  regression verification and will be removed in a later major release.
- Manual oracle bindings prove trusted authorship and structural linkage; they
  do not attempt to prove natural-language semantic equivalence.
- `verify:v2.2` is the full release chain and may take substantially longer than
  targeted M9/M10 verifier commands because it includes historical E2E gates.
