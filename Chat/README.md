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
