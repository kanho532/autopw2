# AutoPW MCP-first installation

AutoPW uses TypeScript for the server, worker and maintenance surfaces. The MCP Server is the primary audit entry; the CLI is maintenance-only.

```bash
npm install
npm run verify:m7
```

Create a project profile from `profiles/default/profile.json`, register the workspace in the MCP Host Context, then use the MCP sequence `derive_coverage` (optional preview) → `run_audit` → `get_run_status` → `get_run_result`. A disconnected MCP session does not cancel an accepted Run; reconnect with the same workspace and Run handle.

For installation diagnostics:

```bash
node packages/maintenance-cli/dist/index.js doctor --root .
node packages/maintenance-cli/dist/index.js schema verify --root .
```
