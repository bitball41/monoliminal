# Migrations

This folder tracks new changes to the existing Liminal database. It does not recreate the older production schema.

Generate migrations with `supabase migration new`. Keep filenames aligned with the linked project's migration ledger. Apply database changes through Supabase; GitHub's HTML deployment Actions do not apply migrations.

Chat's live online status requires `20261009154000_private_chat_online_presence.sql` in the production database. Apply it before deploying the client, then verify both policies on `realtime.messages`. Without them, or when the presence tracker rejects a track, Chat uses bounded retries. After those retries it falls back to a slow `user_presence` read so the member list still has counts. It does not poll that table while live presence is healthy. Clients that already received a permission rejection need to reload once to retry the join.

The policies only allow Presence for authenticated, unbanned Chat accounts on `liminal-online`. Keep those restrictions when tuning usage. Chat uses private Realtime Presence alone for online connections, with separate keys per tab and a count deduplicated by known account. It does not read or pulse `user_presence`, and database freshness does not gate online status. Status and custom status changes arrive through the existing profile subscription. Clean departures remove a tab's entry; crash and network-loss departures wait for the server's socket liveness detection. Presence keys and metadata are client supplied, so this cosmetic information must never authorize actions.

Healthy channel-message and launcher-control subscriptions use 5-minute HTTP reconciliation, with shorter fallbacks on disconnect and no periodic message/control reads from hidden tabs. An open DM reconciles about every 20 seconds, because a missed direct-message event otherwise stays hidden until reload.

The backend authorization migration secures current and legacy write paths. All permission checks use the verified account and canonical database role. Caller-supplied owner flags, usernames and legacy password fields do not grant access.

`20261013060000_chat_cosmetic_sub_roles.sql` adds `profiles.sub_role`. `20261013223000_chat_subrole_catalog.sql` adds the editable catalog. Subroles do not change staff rank. Signed-in people pick their own with `chat_set_own_subrole`. Co-owners and owners create, rename, recolor, and delete them with `chat_save_subrole` and `chat_delete_subrole`. Direct profile edits still cannot set one.

Run `npm ci --ignore-scripts` and `npm test` before deployment. The isolated database tests use PGlite and a reduced snapshot of the existing runtime schema; the test fixture is not a production migration. Also run the rollback-only SQL checks in `../tests/authorization-regression.sql` against the linked project when deploying. They create temporary fixture accounts and revert all writes, including settings and audit rows.

`20261013234532_private_group_chats.sql` adds invitation-based private groups on top of the existing DM tables, member-only private attachments, a compatibility inbox for old clients, and owner-only feature configuration. Invitations do not grant message access. Group reads and writes remain scoped to accepted participants, without a staff-role exception. Apply this migration before the 2.23 Chat deployment.
