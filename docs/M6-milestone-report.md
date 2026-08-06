# Milestone M6: MCP Security Boundaries

Status: Complete (`npm run verify:m6` passed).

M6 extends the TypeScript runtime with an explicit host-owned security boundary. `TrustResolver` and `SecurityPolicyEngine` resolve a monotonic policy from host context and profile narrowing. `untrusted_pr` runs are forced to `connect`, cannot select PR head configuration or manage operations, and cannot replace the approved auth scope. Production mode is fail-closed for destructive actions.

The runtime now persists a redacted trust snapshot with each Run, validates workspace paths through realpath-aware containment, rejects arbitrary run roots, applies the resolved host-approved origin policy to Discovery and Playwright execution, blocks redirects and service workers, and validates adapter cwd, command IDs, environment keys, network origins, time and output budgets. Tool input is rejected at the control-plane boundary when it contains secret-like fields or values. Artifact reads remain workspace-bound and opaque.

Evidence and reports are protected by secret redaction, screenshot masks for password/sensitive selectors, Markdown escaping, HTML escaping and a restrictive Content-Security-Policy. Planner validation receives the production read-only flag, and the evidence manifest records `redaction_status`.

## Verification

Run:

```bash
npm run verify:m6
```

The M6 verifier covers trust/profile narrowing, untrusted PR restrictions, production mutation denial, path and artifact boundaries, network schemes/origins, adapter sandbox controls, secret redaction, report CSP/escaping, planner read-only validation and persisted trust snapshots. `verify:m6` includes the M1–M5 acceptance chain.

Runtime implementation remains strict TypeScript. `.mjs` is limited to deterministic repository generators and verification harnesses.

## Known scope

The fixture target uses an explicit loopback port pattern because its port is allocated dynamically; production hosts should provide exact target origins. Explicitly approved loopback origins remain usable for local fixtures, while non-approved private/DNS-resolved addresses are blocked. Deployment-specific process/container isolation, OS-level network enforcement and browser interception for every external integration remain host/runtime responsibilities and must bind to the same resolved policy before production adapters are enabled.
