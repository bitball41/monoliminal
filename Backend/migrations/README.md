# Migrations

This folder tracks new changes to the existing Liminal database. It does not recreate the older production schema.

Generate migrations with `supabase migration new`. Keep filenames aligned with the linked project's migration ledger. Apply database changes through Supabase; GitHub's HTML deployment Actions do not apply migrations.

Chat's live online status also requires `20261009154000_private_chat_online_presence.sql` in the production database. Without its two policies, the private `liminal-online` join fails and Chat falls back to an HTTP pulse every 8 seconds and a presence read every 10 seconds. Apply it before deploying the client, then verify both policies on `realtime.messages`. Clients that already received a permission rejection need to reload once to retry the join.

The policies only allow Presence for authenticated, unbanned Chat accounts on `liminal-online`. Keep those restrictions when tuning usage. With the private channel available, Chat uses a 4-minute verification pulse and a 5-minute verification read; joins and leaves arrive through Realtime. Healthy message and launcher-control subscriptions use 5-minute HTTP reconciliation, with shorter fallbacks on disconnect and no periodic message/control reads from hidden tabs.

The backend authorization migration secures current and legacy write paths. All permission checks use the verified account and canonical database role. Caller-supplied owner flags, usernames and legacy password fields do not grant access.

Run `npm ci --ignore-scripts` and `npm test` before deployment. The isolated database tests use PGlite and a reduced snapshot of the existing runtime schema; the test fixture is not a production migration. Also run the rollback-only SQL checks in `../tests/authorization-regression.sql` against the linked project when deploying. They create temporary fixture accounts and revert all writes, including settings and audit rows.
