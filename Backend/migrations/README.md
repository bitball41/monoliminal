# Migrations

This folder tracks new changes to the existing Liminal database. It does not recreate the older production schema.

`20261016011605_chat_analytics.sql` adds private, server-validated foreground activity and durable message/signup facts, corrects distinct-browser counting, and gives Control and Chat the same analytics summary. Apply it before deploying either HTML update. See [analytics definitions and coverage](../ANALYTICS.md).

Generate migrations with `supabase migration new`. Keep filenames aligned with the linked project's migration ledger. Apply database changes through Supabase; GitHub's HTML deployment Actions do not apply migrations.

Chat's live online status requires `20261009154000_private_chat_online_presence.sql` in the production database. Apply it before deploying the client, then verify both policies on `realtime.messages`. Without them, or when the presence tracker rejects a track, Chat uses bounded retries. After those retries it falls back to a slow `user_presence` read so the member list still has counts. It does not poll that table while live presence is healthy. Clients that already received a permission rejection need to reload once to retry the join.

The policies only allow Presence for authenticated, unbanned Chat accounts on `liminal-online`. Keep those restrictions when tuning usage. Chat uses private Realtime Presence alone for online connections, with separate keys per tab and a count deduplicated by known account. It does not read or pulse `user_presence`, and database freshness does not gate online status. Status and custom status changes arrive through the existing profile subscription. Clean departures remove a tab's entry; crash and network-loss departures wait for the server's socket liveness detection. Presence keys and metadata are client supplied, so this cosmetic information must never authorize actions.

Healthy channel-message and launcher-control subscriptions use 5-minute HTTP reconciliation, with shorter fallbacks on disconnect and no periodic message/control reads from hidden tabs. An open DM reconciles about every 20 seconds, because a missed direct-message event otherwise stays hidden until reload.

The backend authorization migration secures current and legacy write paths. All permission checks use the verified account and canonical database role. Caller-supplied owner flags, usernames and legacy password fields do not grant access.

`20261013060000_chat_cosmetic_sub_roles.sql` adds `profiles.sub_role`. `20261013223000_chat_subrole_catalog.sql` adds the editable catalog. Subroles do not change staff rank. Signed-in people pick their own with `chat_set_own_subrole`. Co-owners and owners create, rename, recolor, and delete them with `chat_save_subrole` and `chat_delete_subrole`. Direct profile edits still cannot set one.

Run `npm ci --ignore-scripts` and `npm test` before deployment. The isolated database tests use PGlite and a reduced snapshot of the existing runtime schema; the test fixture is not a production migration. Also run the rollback-only SQL checks in `../tests/authorization-regression.sql` against the linked project when deploying. They create temporary fixture accounts and revert all writes, including settings and audit rows.

`20261013234532_private_group_chats.sql` adds invitation-based private groups on top of the existing DM tables, member-only private attachments, a compatibility inbox for old clients, and owner-only feature configuration. Invitations do not grant message access. Group reads and writes remain scoped to accepted participants, without a staff-role exception. Apply this migration before the 2.23 Chat deployment.

`20261014010005_private_group_dm_uniqueness.sql` excludes private groups from the existing participant uniqueness index. Groups can share members with each other and an ordinary DM, while ordinary DMs retain their uniqueness rule and Luna exception.

`20261014212514_message_content_trgm.sql` adds trigram indexes for message text search. `20261014212942_chat_list_mentions.sql` adds `chat_list_mentions`, which Chat calls while opening the inbox. A browser `ILIKE` on `messages` cannot use that index while row security is on, and that scan was reading the whole table on every sign-in.

`20261016012609_private_voice_calls.sql` enables the top-bar phone button for DMs and accepted private groups. Apply this SQL before using private calls. Only conversation members may access signaling; blocked accounts and paused private chats cannot connect. Membership changes rotate the topic and end existing calls within the four-second access check. Private calls use the existing TURN configuration and eight-person voice limit. Invitations use ordinary private messages; microphones require each participant to join.

`20261016042314_chat_intentional_polish.sql` replaces repeatable private-call membership fingerprints with server-generated room epochs and filters exact username mentions before the inbox limit. Run the whole file once after the earlier Chat migrations. Existing private calls need to rejoin after the topic changes. This file is copy/paste ready; the HTML deployment workflow does not execute it.
