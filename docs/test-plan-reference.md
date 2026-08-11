# TestPlan Reference

A TestPlan is declarative JSON validated by both the public JSON Schema and the
runtime validator. It may contain UI, API, or hybrid cases, but never code,
shell commands, arbitrary URLs, or generated CSS/XPath locators.

`oracle_bindings` links a requirement to one or more `step_N` references in the
flattened setup, test, cleanup sequence. Each reference must resolve to an
`expect_*` step. Generated plans include these bindings; trusted manual plans
must declare them to receive oracle coverage credit.
