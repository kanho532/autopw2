# M10 Release Hardening Report

Status: Complete

M10 makes the declarative TestPlan and structured Discovery engines the trusted
Core defaults. The M0–M8 fixture path remains an explicit, deprecated
compatibility lane for one release cycle.

Release hardening adds a default-path run, dual-run compatibility evidence,
per-stage release metrics, deterministic plan and execution identifiers,
response body bounds, cache-corruption handling, artifact-path containment, and
the M10 verifier. Run `npm run verify:m10` for the targeted release-hardening
gate; `npm run verify:v2.2` is the complete release chain.
