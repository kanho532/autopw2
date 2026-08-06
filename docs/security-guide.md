# Security Guide

The host owns workspace, trust, auth and network policy. Tool input is schema-validated and secret-like fields are rejected at the MCP boundary; persisted request, evidence and report content is redacted as defense in depth.

Authorized paths are realpath checked and symlink escapes are denied. Browser navigation is restricted to the resolved origin allowlist. Untrusted PR contexts are connect-only, isolated and cannot enable head configuration or manage lifecycle. Production mode is read-only for mutating planner actions.

M8 does not claim OS-level sandboxing or complete DNS rebinding prevention. Deployments requiring those controls must enforce them in the host/container boundary.
