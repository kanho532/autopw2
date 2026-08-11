# Legacy Plan Migration

The M2 FixturePlan is retained for compatibility verification only. New work
uses `@autopw/test-plan` and the declarative runner. To migrate a legacy case,
preserve its requirement reference, express setup/test/cleanup as TestPlan
steps, and add explicit oracle bindings for the assertions that earn coverage.

The legacy engine is deprecated in M10 and must be selected explicitly through
trusted host configuration.
