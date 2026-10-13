# Migrations

This folder tracks new changes to the existing Liminal database. It does not recreate the older production schema.

Generate migrations with `supabase migration new`. Keep filenames aligned with the linked project's migration ledger. Apply database changes through Supabase; GitHub's HTML deployment Actions do not apply migrations.

Chat's live online status requires `20261009154000_private_chat_online_presence.sql` in the production database. Apply it before deploying the client, then verify both policies on `realtime.messages`. Without them, the private `liminal-online` join fails; Chat uses bounded retries and shows presence as unavailable. It does not fall back to HTTP polling or heartbeat RPCs. Clients that already received a permission rejection need to reload once to retry the join.

The policies only allow Presence for authenticated, unbanned Chat accounts on `liminal-online`. Keep those restrictions when tuning usage. Chat uses private Realtime Presence alone for online connections, with separate keys per tab and a count deduplicated by known account. It does not read or pulse `user_presence`, and database freshness does not gate online status. Status and custom status changes arrive through the existing profile subscription. Clean departures remove a tab's entry; crash and network-loss departures wait for the server's socket liveness detection. Presence keys and metadata are client supplied, so this cosmetic information must never authorize actions.

Healthy message and launcher-control subscriptions use 5-minute HTTP reconciliation, with shorter fallbacks on disconnect and no periodic message/control reads from hidden tabs.

The backend authorization migration secures current and legacy write paths. All permission checks use the verified account and canonical database role. Caller-supplied owner flags, usernames and legacy password fields do not grant access.

Run `npm ci --ignore-scripts` and `npm test` before deployment. The isolated database tests use PGlite and a reduced snapshot of the existing runtime schema; the test fixture is not a production migration. Also run the rollback-only SQL checks in `../tests/authorization-regression.sql` against the linked project when deploying. They create temporary fixture accounts and revert all writes, including settings and audit rows.
