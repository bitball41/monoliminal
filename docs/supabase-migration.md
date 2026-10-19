# Liminal Supabase migration

The source is `ucgjwrjqmexenmrpbdkh`. No destination is configured. The migration
backup workflow only reads the original project; it never restores, deletes,
changes policies, changes a password, or switches the launcher.

## Enable the private export

Add these **repository Actions secrets** at
<https://github.com/bitball41/monoliminal/settings/secrets/actions>:

| Secret | Value |
| --- | --- |
| `LIMINAL_SOURCE_DB_URL` | Original project's **Connect → Session pooler** PostgreSQL connection URI, with its database password percent-encoded in the URI. Use port **5432**, database `postgres`, and the original project's `postgres.ucgjwrjqmexenmrpbdkh` username. A direct connection is also accepted if IPv6 works. |
| `LIMINAL_SOURCE_ACCESS_TOKEN` | A Supabase personal access token belonging to an account that can read the original project's configuration, function source, and secret inventory. Generate it at <https://supabase.com/dashboard/account/tokens>. |
| `LIMINAL_BACKUP_PASSPHRASE` | A unique, single-line passphrase with at least 24 characters. Keep an independent private copy: the encrypted backup cannot be recovered without it. |

The existing server-only `SUPABASE_DEPLOY_KEY` is reused to download Storage
objects. If that secret is unavailable or unsuitable, also add
`LIMINAL_SOURCE_STORAGE_KEY` with the original project's server secret key or
legacy `service_role` key. Public/anon keys are rejected. Do not put credentials
in workflow inputs, issue comments, PR descriptions, source files, or chat.

Do not reset a working source database password simply to run this workflow.
Use the existing password, or arrange a password change separately if it has
actually been lost.

The first push to `codex/liminal-migration-backup` starts a run. If required
secrets are missing, its preflight stops before accessing the database or
downloading anything. Add the secrets and rerun the failed job. The workflow
can also be manually dispatched once present on the default branch.

Only the pinned CLI release is downloaded; its archive SHA-256 is verified.
The exporter inspects its command help before use and initializes an isolated
local CLI configuration. Inventory queries request read-only transactions; the
fixed dump/download commands do not mutate the source. Pull-request validation
never receives export secrets.

## What the encrypted archive contains

- `database/roles.sql`, `schema.sql`, and `data.sql`: custom roles, application
  schema, data including Auth login records, and ordinary Storage metadata.
- `database/managed-schema-reference.sql`: an additional reference export of
  `auth`, `storage`, `realtime`, and `vault`, including custom managed-schema
  objects which the normal schema dump can omit. **Do not restore the whole
  reference schema over a fresh project's managed schemas.** Extract and apply
  the relevant custom objects after inspecting the target version.
- `database/history-*.sql`: migration history, separately exported.
- `database/catalog.json`: actual per-table counts, extensions, policies,
  publication membership, managed-schema triggers, and server version.
- `storage/`: every object listed directly in the database, including private
  buckets, plus bucket definitions, original object metadata and paths,
  downloaded byte counts, and SHA-256 checksums. Numeric local filenames prevent
  attachment paths from writing outside staging. There is no public-only listing
  or REST pagination limit.
- `supabase/functions/`: the source of every currently deployed function,
  including functions not tracked in this repository. The configuration retains
  each function's `verify_jwt` flag and version.
- `configuration/`: Auth, Storage, Realtime, PostgREST and project settings, and
  the Edge Function secret inventory. Some settings are redacted and the secret
  inventory may contain only digests. **This is not a copy of every secret value.**
- `repository-source.tar`: tracked source at the workflow's checked-out commit.
- `backup-manifest.json` and `checksums.json`: export status, boundaries,
  required manual work and checksums for every payload file.

Existing Liminal Drive files are stored in Cloudflare R2. They remain in their
current R2 bucket and are not duplicated by this Supabase Storage export. Keep
that bucket, and configure its existing credentials in the new backend. Any R2
backup is a separate operation.

Vault's encryption root key is not in a SQL dump. This exporter stops if Vault
contains secrets; preserve the key separately before extending the workflow for
that case. Ordinary project keys should be replaced with the new project's keys.
Custom database LOGIN-role passwords also require separate setup.

## Getting the backup

The workflow publishes only `liminal-backup.tar.gz.gpg` and a credential-free
`summary.json`. **This repository is public; Actions artifacts are not a private
storage boundary.** The encryption passphrase is the boundary. Plaintext SQL,
files, tokens, function source and detailed manifests are never uploaded as
artifacts. Temporary plaintext is removed when the process exits.

The encryption uses GnuPG AES-256 with an iterated salted key derivation. A full
decrypt-and-hash verification must pass before the final `.gpg` file is created.
The exported artifact is retained for **7 days**. Download it promptly and keep
another private copy; Actions is temporary staging, not permanent retention.

A failed export can still produce an **encrypted incomplete archive**. Check
`summary.json`: only `status: exported` means the export finished. That status
does not claim a successful destination restore. Failed components are recorded
inside the encrypted archive; raw error bodies and database credentials are not
printed to the public job log.

To decrypt locally, let GnuPG prompt for the passphrase:

```sh
gpg --output liminal-backup.tar.gz --decrypt liminal-backup.tar.gz.gpg
tar -xzf liminal-backup.tar.gz
```

Verify every SHA-256 in `liminal-backup/checksums.json` before importing. Preserve
original file paths from `storage/downloaded-manifest.json`; the numeric local
names are not destination names.

## Destination and cutover

1. The friend creates an empty Supabase project and invites the connected
   Supabase account to the destination organization. Source and destination
   should use compatible PostgreSQL/Auth/Storage versions.
2. Restore database schema/data/roles and migration history following the
   official guide. Preserve the original Auth UUIDs and password hashes. Compare
   the target's default grants with the source; default privileges can otherwise
   grant more access than the original explicit grants.
3. Restore custom Auth/Storage/Realtime objects selectively, enable the recorded
   extensions and Realtime publication memberships, and verify RLS/grants.
4. Create all buckets with their original public/private settings and limits;
   upload actual bytes through Storage with the original bucket and object paths.
   Restore owner/user metadata deliberately. SQL object metadata alone is not a
   file backup and should not be blindly inserted over newly uploaded objects.
5. Deploy every backend function with its original JWT-verification setting.
   Re-enter custom secrets from their original providers, including R2 credentials
   and external API keys. Recreate relevant Auth/SMTP/provider settings.
6. Rewrite old project origins embedded in database content, backend configuration
   and frontend source, and replace frontend publishable keys. Existing R2 URLs
   stay unchanged. Do not use a broad textual replacement over passwords/hashes.
7. This is an online export, **not a cutover**: data written after the database
   dump is not included. Any Storage change during export causes an incomplete
   result. Arrange a short, controlled write pause for a final consistent export
   and restore before switching traffic; a client-only pause cannot enforce this.
8. Verify existing logins, counts, relationships, attachments (including private
   access), messaging, DMs, settings, moderation, AI, Drive, and administrative
   actions. Then switch the launcher and deployment settings, while retaining the
   source and downloaded backup until the new deployment is accepted.

No destination restore/cutover runs automatically from this workflow.

## Verified references

- <https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore>
- <https://supabase.com/docs/guides/troubleshooting/migrating-auth-users-between-projects>
- <https://supabase.com/docs/reference/cli/supabase-db-dump>
- <https://supabase.com/docs/reference/cli/supabase-functions-download>
- <https://supabase.com/docs/reference/api/v1-get-auth-service-config>
- <https://supabase.com/docs/reference/api/v1-list-all-functions>
- <https://supabase.com/docs/reference/api/v1-list-all-secrets>
