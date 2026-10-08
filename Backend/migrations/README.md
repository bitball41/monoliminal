# Migrations

This folder tracks new changes to the existing Liminal database. It does not recreate the older production schema.

Generate migrations with `supabase migration new`. Keep filenames aligned with the linked project's migration ledger. Apply database changes through Supabase; GitHub's HTML deployment Actions do not apply migrations.

The backend authorization migration secures current and legacy write paths. All permission checks use the verified account and canonical database role. Caller-supplied owner flags, usernames and legacy password fields do not grant access.

Run `npm ci --ignore-scripts` and `npm test` before deployment. The isolated database tests use PGlite and a reduced snapshot of the existing runtime schema; the test fixture is not a production migration. Also run the rollback-only SQL checks in `../tests/authorization-regression.sql` against the linked project when deploying. They create temporary fixture accounts and revert all writes, including settings and audit rows.
