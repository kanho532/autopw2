# ADR-017: Structured Discovery is the sole engine

Status: Accepted
Date: 2026-08-11

## Decision

M9.5 completed the Structured Discovery migration. AutoPW retires the
`discovery_engine` compatibility flag rather than presenting `legacy` as a
working alternative. Supplying that retired setting fails closed with
`DISCOVERY_ENGINE_RETIRED`.

Only `PlanEngineMode` remains configurable. The M10 compatibility path is the
Fixture plan engine for the frozen M0-M8 acceptance lane; it does not imply a
second Discovery implementation.

## Consequences

Release metrics record the selected plan engine only. Documentation and plugin
metadata describe Structured Discovery as the fixed implementation. This avoids
silent mode labels that do not select distinct behavior.
