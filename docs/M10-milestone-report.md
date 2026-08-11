# M10 Release Hardening Report

Status: Complete

M10 makes declarative TestPlan execution the trusted Core default. Structured
Discovery is the sole Discovery implementation after M9.5; it is not a runtime
mode flag. The M0–M8 Fixture plan path remains an explicit, deprecated
compatibility lane for one release cycle.

Release hardening adds a default-path run, dual-run compatibility evidence,
per-stage release metrics, deterministic plan and execution identifiers,
accepted response-payload bounds (after Playwright transport buffering),
cache-corruption handling, artifact-path containment, and
the M10 verifier. Run `npm run verify:m10` for the targeted release-hardening
gate; `npm run verify:v2.2` is the complete release chain.
