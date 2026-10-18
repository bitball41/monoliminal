# Edge functions

Tracked deployed source:

- `liminal-drive`: public listing, file streaming, range requests, and download responses.
- `liminal-drive-admin`: verified Liminal profiles, role-based uploads, signed URLs, multipart uploads, folders, and file management.
- `chat-auth`: shared Chat account signup, self-deletion, authorized password resets and owner test-account management.

Both functions keep R2 credentials server-side. Their `shared.ts` files use the deployed function's existing environment variables; never commit their values.
`liminal-drive` is public (`verify_jwt: false`). `liminal-drive-admin` requires JWT verification and separately validates the user and current database profile.
The permissions module matches Chat's role hierarchy. Mod and Manager have upload access; Admin and higher have management access. Banned accounts have no write access.
Create-only uploads include an atomic R2 `If-None-Match: *` condition. Signed URLs require that header in the signature. Raw multipart operations require Admin management permission because R2's documented multipart completion path lacks an atomic destination create-only condition. Mod and Manager can still upload large files directly using a signed PUT; their proxy fallback is limited to 32 MiB.

Deploy the public Drive function with `index.ts`, `shared.ts`, and `metadata.ts`, retaining `verify_jwt: false`. Deploy the admin function with `index.ts`, `shared.ts`, `metadata.ts`, and `permissions.ts`, retaining `verify_jwt: true`. Deploy both functions before publishing the Settings/customization HTML. The duplicated pure metadata helpers must remain identical.

Drive metadata uses reserved, hashed R2 sidecar keys and conditional `PutObject` writes. The editor must supply the revision returned by `get_metadata`; conflicts return HTTP 409. Public listings expose the validated metadata on live files, not the internal sidecar objects. File copy/delete operations also copy/delete their sidecars, so moves and trash/restore retain customization without leaking it onto a new file at the old path. No database schema change is required.
Deploy `chat-auth` with `index.ts` and `permissions.ts`, retaining `verify_jwt: false`: signup is public, and every other action verifies the token with Auth and loads the current database profile. Apply the authorization migration first; password resets also require its service-only authorization RPC immediately before the Auth write.
The GitHub HTML deployment Actions do not deploy Edge Functions. Backend updates must be deployed separately through the Supabase tool or CLI.

Regression checks use a mocked Auth/R2 transport and never mutate production:

```sh
npm ci --ignore-scripts
npm test
```
