# Edge functions

Tracked deployed source:

- `noelle-ai`: authenticated `@NoelleAI` channel replies, private live style
  examples, and atomic usage reservations. The initial release requires owner
  access; owner-only row policies also protect prompts, replies, and reply chains. Deploy `index.ts`, `handler.ts`, and
  `persona.ts` with `verify_jwt: true`; it also validates Auth and the current
  profile. Reuses the existing OpenAI server secret. The Noelle AI migration
  must be applied before deploying the function and Chat client.
  Public examples include bounded response context and topic matches; the
  caller's channel conversation stays separate from those historical examples.
  Chat mirrors the configured source profile's exact avatar, raw ring and bio
  through the owner-only profile RPC, keeping the bot's AI label and member role.
  Structured replies can request an optional GIF search through the existing
  authenticated `klipy-gifs` function (which uses its high content filter).
  The server validates returned media hosts, saves text and GIF atomically, and
  falls back to text if GIF search fails or GIFs are disabled.

- `liminal-drive`: public listing, safe source previews, range requests, and short-lived R2 download redirects. File downloads go directly from R2 to the browser; previews remain sandboxed through the function.
- `liminal-drive-admin`: verified Liminal profiles, role-based uploads, signed URLs, multipart uploads, folders, and file management.
- `chat-auth`: shared Chat account signup, self-deletion, authorized password resets and owner test-account management.

Both functions keep R2 credentials server-side. Their `shared.ts` files use the deployed function's existing environment variables; never commit their values.
`liminal-drive` is public (`verify_jwt: false`). `liminal-drive-admin` requires JWT verification and separately validates the user and current database profile.
The permissions module matches Chat's role hierarchy. Mod and Manager have upload access; Admin and higher have management access. Banned accounts have no write access.
Create-only uploads include an atomic R2 `If-None-Match: *` condition. Signed URLs require that header in the signature. Raw multipart operations require Admin management permission because R2's documented multipart completion path lacks an atomic destination create-only condition. Mod and Manager can still upload large files directly using a signed PUT; their proxy fallback is limited to 32 MiB.

Deploy the public Drive function with `index.ts`, `shared.ts`, and `metadata.ts`, retaining `verify_jwt: false`. Deploy the admin function with `index.ts`, `shared.ts`, `metadata.ts`, and `permissions.ts`, retaining `verify_jwt: true`. Deploy both functions before publishing the Settings/customization HTML. The duplicated pure metadata helpers must remain identical.

The replacement project is `trsirhyucncmyyfyiuje`. Restore these Edge Function secrets from the existing R2 setup: `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Keep the existing bucket and credentials; there is no need to copy its files into Supabase. Restore `CLOUDFLARE_R2` too if the existing deployment uses a public R2 domain. Missing required values return HTTP 503 with `DRIVE_STORAGE_NOT_CONFIGURED`; signed-in account status still works independently of storage configuration. Backups contain secret digests, not recoverable secret values.

Drive admin currently retains the gateway JWT check. Its handler also validates every user token through `/auth/v1/user` and loads current staff permissions from `profiles`. Supabase documents a possible incompatibility between the legacy gateway check and asymmetric signing keys. Verify a real signed-in request after configuring the new project; any gateway configuration change must retain the handler's Auth and role checks.

Drive metadata uses reserved, hashed R2 sidecar keys and conditional `PutObject` writes. The editor must supply the revision returned by `get_metadata`; conflicts return HTTP 409. Public listings expose the validated metadata on live files, not the internal sidecar objects. File copy/delete operations also copy/delete their sidecars, so moves and trash/restore retain customization without leaking it onto a new file at the old path. No database schema change is required.
Deploy `chat-auth` with `index.ts` and `permissions.ts`, retaining `verify_jwt: false`: signup is public, and every other action verifies the token with Auth and loads the current database profile. Apply the authorization migration first; password resets also require its service-only authorization RPC immediately before the Auth write.
The GitHub HTML deployment Actions do not deploy Edge Functions. Backend updates must be deployed separately through the Supabase tool or CLI.

Regression checks use a mocked Auth/R2 transport and never mutate production:

```sh
npm ci --ignore-scripts
npm test
```
