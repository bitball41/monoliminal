# Edge functions

Drive's deployed source is tracked here:

- `liminal-drive`: public listing, file streaming, range requests, and download responses.
- `liminal-drive-admin`: verified Liminal profiles, role-based uploads, signed URLs, multipart uploads, folders, and file management.

Both functions keep R2 credentials server-side. Their `shared.ts` files use the deployed function's existing environment variables; never commit their values.
`liminal-drive` is public (`verify_jwt: false`). `liminal-drive-admin` requires JWT verification and separately validates the user and current database profile.
The permissions module matches Chat's role hierarchy. Mod and Manager have upload access; Admin and higher have management access. Banned accounts have no write access.

Deploy the admin function with `index.ts`, `shared.ts`, and `permissions.ts`, retaining `verify_jwt: true`.
The GitHub HTML deployment Actions do not deploy Edge Functions. Backend updates must be deployed separately through the Supabase tool or CLI.

Regression checks use a mocked Auth/R2 transport and never mutate production:

```sh
node --experimental-strip-types --test scripts/drive.test.mjs
```
