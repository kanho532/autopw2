# Profile, Policy and Contract Guide

Profiles select tier and quality behavior; host context supplies the authoritative workspace, trust, auth and origin scope; MCP contracts define the wire-level schema. A profile cannot widen host policy or add an unapproved auth scope.

The primary implementation language is TypeScript. Contract source lives in `packages/mcp-contracts/src/tools.mjs` and generated artifacts are refreshed with `node tools/gen-m0.mjs`; runtime packages consume the generated JSON bundle. Contract changes require regenerated artifacts, verification and an ADR/version review.
