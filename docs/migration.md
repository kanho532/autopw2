# Storage migration and rollback

The maintenance CLI records the storage schema in `<data-root>/storage-meta.json`. Migration is idempotent and creates `storage-meta.json.bak` before changing an existing metadata file.

```bash
node packages/maintenance-cli/dist/index.js doctor --root . --data-root .autopw/data --migrate
```

An unsupported storage major/version is reported as an operational diagnostic and is not rewritten. To roll back a metadata-only migration, stop the server, restore the `.bak` file, and rerun `schema verify`; Run artifacts are not deleted by this command.
