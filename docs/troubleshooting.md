# Troubleshooting

`MATRIX_BUDGET_EXCEEDED`: reduce browsers, viewports, locales or auth scopes, or obtain a larger approved matrix budget. Full tier never silently samples.

`PROTOCOL_VERSION_MISMATCH`: upgrade the MCP server and worker as one bundle. The advertised protocol is available from `serverInfo()`.

`RESULT_EXPIRED`: the result or artifact passed its retention window or was swept. Re-run the audit; do not reconstruct an artifact handle.

`INCOMPLETE` or `INFRA_BLOCKED`: inspect the persisted run events, checkpoint and evidence manifest. These states are not product-defect claims.
