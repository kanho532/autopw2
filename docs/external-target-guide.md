# External Target Guide

Run a target without changing its source:

```text
npm run test:external -- --target <project-path> --url <base-url> --tier full
```

Use `--plan-mode overlay --plan <file>` to supplement generated coverage or
`--plan-mode replace --plan <file>` to execute an explicit trusted plan. Manual
cases need explicit `oracle_bindings`; requirement references alone do not earn
coverage credit. Results, reports, and `latest.json` are written under
`--data-root` (or `<target>/.autopw2`).
