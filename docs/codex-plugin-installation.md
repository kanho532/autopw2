# Install AutoPW for Codex

The repository marketplace is `.agents/plugins/marketplace.json`; install the
`autopw` entry from that source in the Codex Plugins Directory. The plugin
launches the version-pinned `@autopw/codex-plugin-runtime@2.2.0` STDIO server.

Before using AutoPW, explicitly trust an existing local workspace and a local
or HTTPS target origin:

```text
autopw trust <absolute-workspace-path> --target http://127.0.0.1:3000
autopw list
```

Then ask Codex to call `autopw_status`, `derive_coverage`, or `run_audit` with
the trusted workspace path. If Playwright Chromium is absent, run:

```text
autopw install-browser
```

Use `autopw untrust <absolute-workspace-path>` to remove target authority.
