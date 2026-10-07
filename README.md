# MonoLiminal

One cloud development folder for the Liminal ecosystem. Edit here from GitHub or github.dev, then clone the same repo when working on a computer.

## Apps

| App | Canonical source | Supabase Storage object |
| --- | --- | --- |
| Chat | [`Chat/chat.html`](Chat/chat.html) | `chat.html` |
| Chat launcher | [`Chat/liminal-chat-launcher.html`](Chat/liminal-chat-launcher.html) | `liminal-chat-launcher.html` |
| Player | [`Player/liminalplayer.html`](Player/liminalplayer.html) | `liminalplayer.html` |
| AI | [`AI/luna.html`](AI/luna.html) | `luna.html` |
| Drive | [`Drive/Liminal-Drive.html`](Drive/Liminal-Drive.html) | `Liminal-Drive.html` |
| Games | [`Games/games.html`](Games/games.html) | `games.html` |
| Movies | [`Movies/movies.htm`](Movies/movies.htm) | `movies.htm` |

All seven existing app files were moved into these folders without changing their contents. Download suffixes such as `(27)` were removed. The production object names above match the existing `liminal-apps` bucket.

## Other folders

- `Shared/`: common design references and reusable source.
- `Backend/edge-functions/`: backend function source.
- `Backend/migrations/`: database migrations.
- `scripts/`: reusable deployment and verification scripts.
- `config/deployments.json`: source-to-destination mapping for each artifact.
- `docs/`: setup and development notes.
- `.github/workflows/`: separate deployment Actions for each artifact, shared checks, and manual rollback.

## Working on an app

1. Edit its canonical file.
2. Open a PR and merge it into `main`.
3. That file's deployment workflow validates and publishes it once the repository secrets are configured.

Start with a manual Drive dry run. Its HTML belongs in `Drive/`; its backend functions belong in `Backend/edge-functions/`.

## Deployment status

The Actions and archive/upload/rename script are implemented. Add `SUPABASE_URL` and `SUPABASE_DEPLOY_KEY` as repository Actions secrets, then run a manual dry run. See [deployment setup](docs/deployment.md) for the exact steps, rollback, and recovery limits. Live production access has not been verified during implementation.

Supabase remains the app host. Drive's user-uploaded files remain separate from these app HTML artifacts.
