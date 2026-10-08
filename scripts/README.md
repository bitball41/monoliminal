# Deployment scripts

Use Node.js 22 or newer. Deployment scripts have no npm dependencies. The authorization regression suite uses the pinned PGlite development dependency; install it with `npm ci --ignore-scripts` and run all checks with `npm test`.

- `storage-api.mjs`: authenticated REST calls, fresh uploads, hashes and move reconciliation.
- `deployment.mjs`: validation and archive/upload/promote/recovery transaction.
- `deploy-storage.mjs`: CLI used by Actions; writes summaries and reports.
- `validate-deployments.mjs`: source and workflow mapping checks.
- `deployment.test.mjs`: mocked failures and REST request tests; never contacts production.
- `drive.test.mjs`: mocked Auth/R2 authorization checks and Drive frontend regressions.
- `security.test.mjs`: the complete password-reset role matrix and real SQL permission checks against an isolated database. It uses no live credentials.

See [deployment setup](../docs/deployment.md) for secrets, dry runs, publishing, rollback and recovery limits.
