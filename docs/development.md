# Development

## Canonical files

Use the app paths linked in the root README. Keep one current copy of each app. Git history stores earlier source versions; Supabase `deployments/` will store earlier deployed artifacts.

Each existing app remains a standalone HTML file. Moving it into an app folder does not require splitting its CSS or JavaScript. Keep deployed object filenames stable so existing launchers continue to use their current URLs.

## Chromebook workflow

Open this repo in GitHub or press `.` on GitHub to edit in github.dev. Make the change, commit it to a branch, open a PR, and merge into `main`.

## Before merging

- Preview the changed app and check its main interaction.
- Keep changes focused on the intended app.
- Check that no credentials or private user data are added.
- When automation is enabled, verify the relevant workflow and live artifact after merging.

Folder creation and renames in the initial scaffold preserve the original blobs. They do not deploy or modify Supabase/R2 content.
