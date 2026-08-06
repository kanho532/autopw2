# CI gate adapter

CI reads the persisted `results.json`; it does not duplicate discovery, planning or execution. After the MCP Run reaches `GATED`, invoke:

```bash
node tools/ci-adapter.mjs .autopw/data/runs/<run_id>/artifacts/results.json
```

Quality exit codes are: `0` for pass, `1` for fail or unstable, and `2` for incomplete or infra. Invalid or missing results use operational exit code `70`.
