# Liminal Chat

## Idle rendering and frame recordings (2.26.1)

Link and YouTube preview images now use the same viewport visibility and
compositing rules as message media. Avatar ring backgrounds also hide when
offscreen or in a hidden tab, including image rings containing animated GIFs.
Original sources, dimensions and appearance are preserved when returning.
`scripts/chat-media-visibility.browser.mjs` verifies these paths offline.

Frame recordings retain their own bounded long-frame, long-task and operation
samples after stopping. They also record aggregate intersecting media/name/ring
counts and open-dialog counts at start/stop and at most once per second after
a frame gap. These counts describe intersection state, including its 32px
margin; they do not establish which images were painted. No URLs, message text,
usernames or new continuous sampling are added. Later passive observations
remain separate from the recorded minute.

## Display name styles (2.26)

Settings → Profile → **Name style** has six fonts, a solid color, a two-color
gradient, a color fade, and a moving gradient. Animated styles have three speed
choices. A live preview updates before the existing debounced autosave; Reset
restores the default font and color. Names are styled in messages/replies,
members, DMs, profile cards, search, forums, and group/member pickers. Handles,
mentions, notification text, and staff badges keep their existing behavior.

Styles travel in the existing profile load and Realtime subscription, adding no
polling or per-message queries. Animations pause offscreen and in hidden tabs;
reduced motion disables them, and the dyslexic setting overrides decorative
fonts. Unsupported gradient clipping falls back to a solid color. Fonts are
fixed local stacks or the fonts already used by Chat; arbitrary CSS and font
URLs are not supported.

**Apply `Backend/migrations/20261025222612_chat_name_styles.sql` before publishing
the HTML.** It adds `profiles.name_style` with an empty default. The database
limits the JSON shape, font/effect/speed IDs and colors, and independently
enforces self-only style edits even with legacy permissive profile policies.
Existing profiles and older clients keep working. A failed style write reports
an error and keeps the last saved profile; it is not silently discarded.

Validation: `npm test` covers payload injection, unchanged JSON updates, database
constraints and authorization. `scripts/chat-name-styles.browser.mjs` runs with
production traffic blocked and checks preview/autosave, reopening, failed-save
recovery, reset, live updates, animations/accessibility and narrow/light layouts.

## Noelle AI

The initial release is visible to owners only (the existing Owner/Preston
access level; co-owners and other staff do not have access). Owners can mention
`@NoelleAI` in a chat channel to get a reply from GPT-6 Luna. Test prompts,
replies, and their reply chains are owner-only rows enforced by RLS, including
history, direct API reads, Realtime, inboxes, and administrative readers.
Only owners see mention autocomplete and the bot profile. Losing owner access
cancels pending generations and clears the preview from the current client.
The separate `Noelle AI` identity carries an AI badge and cannot be used to log in.
The bot is absent from member counts and DMs. Only successfully sent channel
mentions invoke it; loading history, edits, and other clients' Realtime events
do not create API calls.

Apply `Backend/migrations/20261018044605_noelle_ai.sql` and
`Backend/migrations/20261018045645_noelle_ai_owner_preview.sql` and
`Backend/migrations/20261018050243_noelle_ai_recent_examples.sql`, then deploy
`Backend/edge-functions/noelle-ai/{index.ts,handler.ts,persona.ts}` with JWT
verification enabled, and deploy the updated `chat-auth` before publishing Chat.
The function reuses the existing `OPEN_AI`/`OPENAI_API_KEY` server secret. It uses
the Responses API with `gpt-6-luna`, no tools, no provider-side response storage,
no reasoning, and at most 256 output tokens. This is persona prompting, not
fine-tuning.

The private corpus view reads only the consenting Noelle account's current,
undeleted public text messages/forum posts; it never reads `dm_messages`.
Each reply uses a bounded mixture of relevant, representative, and recent
examples, excluding contact details, credential-like text, and unsuitable
examples. The selection reserves space for recent messages before the older representative
sample, so new public messages are picked up without a rebuild or retraining.
Edits/deletions take effect on the next request. Deleting the consent message
(including soft deletion) or the source account stops new replies.
No message examples or private records are committed to the repository.

Owner settings → Noelle AI controls availability, the daily USD budget (25 cents
by default), and the per-person daily limit (50 by default). Six requests per
minute per person and three concurrent generations are enforced server-side.
Days reset at midnight America/Chicago. Each claim conservatively reserves
$0.005; completed requests settle at the published $0.10 input / $0.50 output
per million tokens. Unknown usage and uncertain provider failures retain the
reservation. The 44,000-byte input limit and 256-output-token cap keep the
reservation above the maximum request cost at those rates. Review this bound
before changing model, pricing, tools, or token limits. Duplicate source IDs
cannot generate or post a second reply. Deleted/edited source messages, disabled
chat, banned senders, lost channel permission, or revoked consent cancel an
in-flight reply before insertion. Bot replies are excluded from engagement
analytics.

Canonical source: [`chat.html`](chat.html).

## Browser tabs demo layout

Settings → Appearance → Layout → **Browser tabs · Demo** saves an optional
layout for this browser. Select **Reload to apply** to activate it. Classic is
the default and can be restored from the same setting after another reload.

The demo puts open conversations in a scrollable tab strip, utilities in a left
rail, and members on the right (a drawer on small screens). The plus button
opens a home tab with the existing channel and conversation lists, a profile
preview, and the latest three inbox notifications. Opening a conversation uses
that home tab or selects its existing tab. Closing a tab preserves its draft;
closing the last tab opens Home. Home does not read or poll hidden conversation
history. Open tabs last until the page reloads; saved drafts remain available.
No backend migration is required.

Offline browser regression coverage is in `scripts/chat-layout.browser.mjs`.
Run with Playwright available and `CHAT_BROWSER_PATH` set if Chromium is not in
Playwright's cache. It checks layout changes across reloads, drafts, unreads,
groups, inbox navigation, forums, voice, keyboard navigation, removed
conversations, light themes, and 320–1440px viewports without production traffic.

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

## Recent-feature review and polish

See [the ten-area review](../docs/chat-polish-review.md) for scope, fixes, validation, and the database update. The standalone HTML remains the canonical client; shared analytics stays generated from `scripts/chat-analytics-ui.mjs`.

