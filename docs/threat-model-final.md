# Final Threat Model

Trust boundaries are: host to MCP server, MCP server to worker, worker to browser, browser to demo target, and runtime to durable storage. The host is authoritative for workspace, auth, trust and origins; the worker is authoritative for lease and phase progression; artifacts are run- and kind-bound.

Primary mitigations are schema validation, secret rejection/redaction, realpath authorization, origin checks, untrusted-PR restrictions, production read-only policy, atomic writes, CAS lease state and typed terminal gates. Residual risks are documented in [known-limitations.md](known-limitations.md) and must be accepted explicitly by a deployment owner.
