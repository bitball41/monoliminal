# Deployment scripts

No npm dependencies; use Node.js 22 or newer.

- `storage-api.mjs`: authenticated REST calls, fresh uploads, hashes and move reconciliation.
- `deployment.mjs`: validation and archive/upload/promote/recovery transaction.
- `deploy-storage.mjs`: CLI used by Actions; writes summaries and reports.
- `validate-deployments.mjs`: source and workflow mapping checks.
- `deployment.test.mjs`: mocked failures and REST request tests; never contacts production.

See [deployment setup](../docs/deployment.md) for secrets, dry runs, publishing, rollback and recovery limits.
