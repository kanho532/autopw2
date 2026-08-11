# Generated Testing Guide

The default pipeline is Discovery → Requirement → Candidate Catalog → Planner
selection → Compiler → TestPlan → Runner → Audit/Gate/Report. Planner output
selects trusted candidate IDs only; it does not author code, selectors, URLs,
or assertions.

Generated plans are deterministic for the same trusted inputs. A run writes the
effective plan, mapping audit, requirement coverage, execution evidence,
release metrics, and report below the selected data root.
