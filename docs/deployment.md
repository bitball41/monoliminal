# Deployment setup

## Add two repository secrets

Open **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | The HTTPS origin of the Supabase project containing `liminal-apps`, e.g. `https://your-project.supabase.co` |
| `SUPABASE_DEPLOY_KEY` | A server-only `sb_secret_…` key or legacy `service_role` key for that project |

Use GitHub's secret form; never put the key in chat, source files, or HTML. Public keys are rejected. No npm install or R2 credentials are needed.

## First run

1. Open **Actions → Deploy Drive → Run workflow**, branch `main`.
2. Leave **dry_run** checked.
3. With credentials, the script checks the public bucket and reads the current object without writing. Without both credentials, an **offline-plan** validates only local files; it does not test Storage access.
4. Confirm the summary shows bucket `liminal-apps` and object `Liminal-Drive.html`.
5. Run again with **dry_run** unchecked to publish, then check Drive through its actual launcher.

A push/merged PR changing one canonical HTML file deploys only that artifact. Chat and its launcher have separate workflows. Multiple changed files trigger independent deployments. PR checks never deploy and receive no deployment secrets.

All seven manifest entries are enabled. Set an entry's `enabled` to false to pause its publishing; dry runs remain available. Changes to scripts, config or workflows run checks, but do not automatically republish app HTML.

## Deployment sequence

The reusable workflow checks out current `main` after acquiring the per-app concurrency lock. Queued runs therefore use current source instead of republishing an older queued revision. Reports record the actual checkout SHA.

1. Validate the manifest/HTML and run deployment/recovery tests.
2. Read the current object after confirming the public bucket is accessible.
3. If source and current hashes match, verify the public copy and report `unchanged`.
4. Save a fresh recovery journal with all planned paths.
5. Move the current object to `deployments/<app>/<timestamp>-<commit>-<uuid>-previous.html` (or `.htm`).
6. Upload a fresh `…-incoming.html` with overwrite disabled and cache lifetime zero.
7. Verify its bytes, then move/rename it to the canonical filename.
8. Verify authenticated and public downloads against the source SHA-256.
9. Save a fresh JSON deployment record, job summary, and GitHub report artifact.

Production objects are never overwritten in place. Move-first briefly removes the canonical path. Handled upload/promotion/verification failures attempt to restore the previous artifact. Failed promoted files are moved aside to `…-failed.html`. An ambiguous move response is checked against both paths and hashes rather than blindly retried.

A metadata write failure after successful HTML verification produces a warning and leaves the verified version live. Keep the GitHub report in that case.

## Manual rollback

1. Find an HTML object under `liminal-apps/deployments/<app>/`. The path is also recorded in previous job summaries.
2. Open **Actions → Roll back app → Run workflow**, branch `main`.
3. Select the app and paste the full object path, e.g. `deployments/chat/<id>-previous.html`, not a URL.
4. Inspect a dry run, then uncheck **dry_run** and run again.

Rollback reads the chosen history file, archives current production, and uploads/promotes a fresh replacement. The chosen history file stays available. Another app's history is rejected.

## Recovery and limits

Deploy and rollback share one app-specific lock with in-progress cancellation disabled. Different apps can deploy concurrently. GitHub can replace a queued pending run; a run that proceeds reads current main.

Normal handled errors and termination signals attempt restoration. A forced kill, runner loss, sustained Storage outage, or Actions timeout can prevent recovery from finishing. Inspect the `…-prepared.json` journal and its `archivePath`. If production is absent, move that archive back to the canonical filename in Supabase. Move a failed current object aside first if necessary. Avoid concurrent manual Storage edits to the same object during an Action.

The public verification uses a fresh cache key. It cannot establish that every browser holding the old canonical URL refreshes immediately. Check through the actual launcher after the first deployment and cache-related changes.

Reports remain in Actions artifacts for 90 days. Supabase history is not automatically pruned. Automatic recovery may consume the previous archive by moving it back; a failed incoming file/journal may remain for diagnosis.

These Actions publish app HTML only. Drive's R2 user files, backend functions, database migrations, and bucket policies are not modified. Live Storage access has not been verified during implementation.

## Local checks

Requires Node.js 22 or newer; no third-party Node packages.

```sh
node scripts/validate-deployments.mjs
node --test scripts/deployment.test.mjs
node scripts/deploy-storage.mjs drive --dry-run
```

Dry runs without credentials produce offline plans. Set the two secrets as environment variables to inspect Storage. A live local deploy omits `--dry-run`. Keep credentials outside version control.

## References

- [Storage REST request shapes in the official SDK](https://github.com/supabase/storage-js/blob/main/src/packages/StorageFileApi.ts).
- [Storage error codes](https://supabase.com/docs/guides/storage/debugging/error-codes).
- [Server-only API keys](https://supabase.com/docs/guides/getting-started/api-keys).
- [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
