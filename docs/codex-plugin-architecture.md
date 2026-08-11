# Codex Plugin Architecture

The AutoPW plugin is a host and transport layer, not a replacement for the
M0-M10 pipeline:

```text
Codex -> STDIO MCP adapter -> trusted workspace registry -> internal McpServer -> AutoPW pipeline
```

`packages/codex-plugin-runtime` owns standard MCP transport, workspace trust,
target injection, and tool metadata. `packages/mcp-server` remains the internal
control-plane server. The adapter supplies bundled schemas and tool contracts so
the runtime does not depend on a source checkout.

Only the user-facing `autopw` CLI can add or remove workspace trust. MCP tools
receive an absolute trusted workspace path and never accept target URLs, allowed
origins, workspace IDs, or authentication scopes from the model.
