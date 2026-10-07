# Deployment setup

## Current state

The source files and target mapping are ready. There is no deployment script, configured credential, or active Action in this scaffold. Every entry in `config/deployments.json` starts with `enabled: false`.

The existing public Storage bucket is `liminal-apps`. Its history directory is `deployments/`. Keep each production object name exactly as listed in the manifest, including capitalization.

## Required publish behavior

Never overwrite a production object in place. Implement one reusable script in `scripts/` with this sequence:

1. Validate the local artifact and all configuration before touching Storage.
2. Move the current production object to a unique `deployments/<app>/<timestamp>-<run-id>-previous.html` history path (preserve `.htm` for Movies).
3. Upload the new artifact using a unique temporary object name with overwrite disabled.
4. Move/rename the temporary object to the canonical production filename.
5. Download the deployed artifact and verify its hash against the source.
6. Record the commit SHA, timestamp, source, destination, and hash after verification.

If there is no production object on a first deployment, proceed only after confirming it is absent; do not treat an authorization or network error as absence.

If upload, promotion, or verification fails after archival, restore the previous artifact. If promotion already happened, move the failed new artifact aside before restoring the old one. Report rollback failures explicitly and retain the archive for recovery.

The required move-first sequence leaves a brief interval where the canonical path is absent. Serialize deployments to the same object and do not cancel an in-progress run during promotion. Verify the actual launcher-visible result as well as the Storage API result; renaming does not establish that every cache is immediately fresh.

## Activation checklist

Wire up Drive first, then the other artifacts:

1. Implement and verify the reusable archive/upload/promote script, including failure recovery.
2. Configure the project URL and a server-only deployment credential as GitHub Actions secrets. Never put a privileged key in HTML or this public repo.
3. Confirm the bucket, canonical object path, history path, and restore behavior.
4. Replace the fail-fast placeholder step in the corresponding workflow template with the script invocation.
5. Mark that artifact enabled in `config/deployments.json` and ensure the script honors that flag.
6. Rename only that template from `.yml.example` to `.yml`.
7. Manually run and verify the first deployment before relying on automatic pushes.

Templates watch one exact app file, not an entire shared folder. Merging a PR changing Drive should deploy Drive only. Chat and its launcher also have separate templates. Changing deployment machinery does not automatically republish every app; verify it and manually dispatch the affected workflows.

Backend function/database deployment and Drive's R2 file operations need their own setup later; the Storage templates publish app HTML only.
