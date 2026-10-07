# Liminal Drive

Canonical single-file source: [`Liminal-Drive.html`](Liminal-Drive.html).
Production Storage bucket: `liminal-apps`. Keep the object name `Liminal-Drive.html` unchanged.

Drive opens on **Games**, followed by **Apps**, **Drive**, Recent, Starred, and **Junk**.
The existing root games and tools are grouped without changing their public file URLs.
New uploads from Games go under `Games/`; Apps uploads go under `Apps/`.
Folder bundles list their `index.html` as the main file; their assets remain available in Drive.
Use Drive for folders and ordinary file previews. Administrators can use Move to reorganize files.

Browsing, file previews, and downloads are public. Sign-in uses the same Supabase Auth account and pinned SDK as Chat.
The sign-in screen uses Chat’s full-page card, Log in/Sign up tabs, password controls, and account validation. Sign up calls the existing `chat-auth` endpoint and reuses Chat’s `lc_device_id`. On a shared origin, Chat and Drive reuse the SDK session and `lc_theme` preference. Different origins still require signing in with the same account.
Old Drive sessions migrate into the SDK storage on first use. Account display names, avatars, profile rings, and Chat’s staff role markers come from the verified server profile.
The UI fonts are embedded; no client SDK or font CDN is required.

Moderators and Managers can upload files and folder bundles. Admins and higher roles can also replace, rename, move, trash, restore, and permanently delete files.
These rights are enforced in `Backend/edge-functions/liminal-drive-admin`, not only by hiding buttons.

Games and Apps are download libraries, with file names, sizes, dates, and download actions. They contain no generated thumbnails or embedded game player. Download the HTML and open it in HTML Online Viewer or directly in a browser. HTML source remains available from the file menu; ordinary images, media, text, CSV, and PDFs retain their previews.

Navigation, search, and account dialogs render synchronously. File rows and profile images are preserved during unchanged refreshes. A public metadata snapshot appears immediately on later opens while the server listing refreshes. Account permissions are never cached, and opening Account does not wait for a server response.

Checks:

```sh
node scripts/validate-deployments.mjs
node --experimental-strip-types --test scripts/deployment.test.mjs scripts/drive.test.mjs
```

HTML changes on `main` use the existing Deploy Drive Action. Backend functions are deployed separately; see [backend functions](../Backend/edge-functions/README.md).
See [deployment setup](../docs/deployment.md) for repository secrets and rollback.
