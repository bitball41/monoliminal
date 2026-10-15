# Liminal Chat

Canonical source: [`chat.html`](chat.html).

The standalone launcher is [liminal-chat-launcher.html](liminal-chat-launcher.html) and has its own deployment Action.

Production Storage bucket: `liminal-apps`. Keep the production object name `chat.html` unchanged.

Deployment Actions are ready; add repository secrets and verify a dry run. See [deployment setup](../docs/deployment.md).

## Presence

Online status uses Supabase Realtime Presence on the private `liminal-online` channel. The production database must have the policies from [`20261009154000_private_chat_online_presence.sql`](../Backend/migrations/20261009154000_private_chat_online_presence.sql), which restrict the channel to authenticated, unbanned Chat accounts.

Each tab tracks its own connection key. Chat combines those entries by known account, so opening multiple tabs counts once and closing one tab leaves the account online while another remains connected. Status and custom status come from profiles and update through the existing profile subscription. Presence sends state when a tab subscribes or reconnects; it does not poll `user_presence`, call heartbeat RPCs, or require database timestamps to remain fresh.

Subscription and tracking failures use bounded retries and show that presence is unavailable instead of reporting an authoritative zero. Closing a tab removes its presence when possible. A crash or lost network connection remains visible until the Realtime server detects the dead socket; presence cannot promise instant offline detection in that case.

Presence is cosmetic connection information. Client-supplied keys and metadata do not establish verified identity and must never grant permissions or authorize actions.

## Private groups and administration (2.23)

Conversations contains DMs and private groups. A group owner creates a named group and sends invitations; recipients must accept before they can read any history. Groups support up to 16 accepted/pending members, renaming, invitation cancellation, member removal, ownership transfer, and leaving. Ownership transfers to a remaining member when the owner leaves. Pending invitations are canceled when ownership changes.

Group operations use `chat_create_group`, `chat_manage_group`, and `chat_respond_group_invite`. The server derives identity from Auth and serializes membership changes. Group owners have no extra staff permissions. Staff who are not members cannot read, search, modify, or archive group messages. Group content and attachment links are stripped from shared audit copies. Group uploads use the private `liminal-group-media` bucket with membership policies and ten-minute signed links; stored messages retain only a storage reference. Existing DMs keep their behavior, and old clients receive only DMs through the original inbox RPC.

Staff settings has member moderation, badges/roles, channels/word filters, activity, and the deleted-message archive. Owner settings has an overview, broadcasts, roles/badges, app feature and message-limit controls, test accounts, media recovery, and channel cleanup. Configuration uses the owner-only `chat_owner_configure` RPC.

Apply [`20261013234532_private_group_chats.sql`](../Backend/migrations/20261013234532_private_group_chats.sql) before deploying this HTML. `npm test` includes isolated group authorization/storage checks and the existing authorization regression suite. Deployments run the full suite before publishing.

## Voice on school networks

Home calls use STUN and connect directly. School and campus Wi-Fi usually block that UDP path, so the same call never links. Apply [`20261015140000_voice_tickets_and_turn.sql`](../Backend/migrations/20261015140000_voice_tickets_and_turn.sql) before this client. It makes voice signaling a private channel and lets the owner save TURN servers. Use `turns:` on port 443. Signed-in members can read that relay password, so the relay account should only be allowed to relay media. Rejoin Voice Chat after saving it. Mods and above can mute someone below their rank. That mute is stored in `voice_server_mutes`, the muted mic is forced off, and everyone else stops playing it.
