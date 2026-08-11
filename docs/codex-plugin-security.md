# Codex Plugin Security

Workspace trust is host-owned data under `AUTOPW_CONFIG_HOME` or the user's
`.autopw` directory, never project-controlled configuration. Trust records use
canonical real paths, a credential-free HTTP(S) origin, a fixed allowed-origin
list, and an isolated no-credential auth scope.

The plugin MCP adapter does not expose trust, target configuration, allowed
origins, workspace IDs, or auth scopes as tools. `run_audit` is accurately
marked mutating and destructive because generated plans can exercise UI or API
mutations. Results are returned through the existing redacted artifact and gate
pipeline.
