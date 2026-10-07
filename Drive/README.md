# Liminal Drive

Canonical single-file source: [`Liminal-Drive.html`](Liminal-Drive.html).
Production Storage bucket: `liminal-apps`. Keep the object name `Liminal-Drive.html` unchanged.

Drive opens on **Games**, followed by **Apps**, **Drive**, Recent, Starred, and **Junk**.
The existing root games and tools are grouped without changing their public file URLs.
New uploads from Games go under `Games/`; Apps uploads go under `Apps/`.
Folder bundles show their `index.html` as the launch entry, rather than listing their assets as separate games.
Use Drive for folders and ordinary file previews. Administrators can use Move to reorganize files.

Browsing, launching, previews, and downloads are public. Sign-in uses the same Supabase Auth account and pinned SDK as Chat.
On a shared origin, Chat and Drive reuse the SDK session and `lc_theme` preference. Different origins still require signing in with the same account.
Old Drive sessions migrate into the SDK storage on first use. Account display names, avatars, and staff roles come from the verified server profile.
The UI fonts are embedded; no client SDK or font CDN is required.

Moderators and Managers can upload files and folder bundles. Admins and higher roles can also replace, rename, move, trash, restore, and permanently delete files.
These rights are enforced in `Backend/edge-functions/liminal-drive-admin`, not only by hiding buttons.

HTML games launch from their separate public R2 origin in a sandbox that supports browser saves, relative assets, fullscreen, and pointer lock.
Source preview remains available. The R2 bucket must serve uploaded HTML with `Content-Type: text/html`.

Checks:

```sh
node scripts/validate-deployments.mjs
node --experimental-strip-types --test scripts/deployment.test.mjs scripts/drive.test.mjs
```

HTML changes on `main` use the existing Deploy Drive Action. Backend functions are deployed separately; see [backend functions](../Backend/edge-functions/README.md).
See [deployment setup](../docs/deployment.md) for repository secrets and rollback.
