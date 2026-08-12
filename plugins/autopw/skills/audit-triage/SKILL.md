---
name: audit-triage
description: Explain AutoPW audit failures and evidence from a trusted workspace run.
---

Use `autopw_status` first to verify the workspace is trusted. Then use
`get_run_result` and `explain_run` with the run ID supplied by AutoPW. Summarize
the gate, incomplete requirements, failed cases, and available evidence without
exposing secrets or reconstructing target authority. Use `cleanup_run` only
when the user explicitly asks to remove retained artifacts.
