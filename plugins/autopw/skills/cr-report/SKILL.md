---
name: cr-report
description: Generate a formal Chinese CR report from native @playwright/test HTML, JSON, and trace evidence in a trusted workspace.
---

Use this skill when the user asks for a formal Chinese CR report, a release-review artifact, or a review package based on native Playwright evidence.

Workflow:

1. Call autopw_status with the user's absolute workspace path.
2. Ensure the workspace is trusted. Do not invent a workspace path or broaden trust.
3. Ensure the target has been checked with real @playwright/test and that its output includes results.json. If the report directory is not obvious, pass a workspace-contained playwright_root explicitly.
4. Call generate_cr_report with workspace_path and, when known, project, report_date, playwright_root, and run_id.
5. Return the formal report path, case artifact path, native HTML report path, native JSON path, trace count, test summary, gate, and report_state.

The tool writes:

- CR/<project>/<project>-CR-YYYYMMDD.md as the reader-facing Chinese report;
- CR/<project>/cases/<case-id>/report.md as the coverage artifact;
- state.json, diff-units.jsonl, facts.jsonl, review-groups.jsonl, checks.jsonl, checker-results.jsonl, issues.jsonl, and gate.json;
- no replacement HTML is generated: the native Playwright HTML report and trace.zip files remain the source evidence.

Interpretation rules:

- stage_report means the review is not complete. It is expected when tests fail, Git baseline is unavailable, or UAT/release/rollback evidence is missing.
- blocked means do not claim code merge, production switch, or release completion.
- A complete report requires rerunning the same Playwright command after fixes and reevaluating the gate.
