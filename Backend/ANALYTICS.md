# Chat analytics

Apply `migrations/20261016011605_chat_analytics.sql` before publishing the new Chat and Admin HTML. GitHub's HTML deployment does not apply SQL. No old tables or records are removed.

Both apps read the same `private.chat_analytics_summary()`. Chat calls the authenticated, staff-only `chat_get_analytics()` RPC. The dashboard embeds the summary in its existing token-validated `admin_dashboard_get_state()` response. An invalid or banned identity cannot read analytics or write activity. Private schema access remains closed to browsers.

## Definitions

- Active accounts: distinct authenticated user IDs observed in visible Chat with interaction within five minutes. Chat sends at most one request per minute while eligible; the database also throttles writes per day/account/browser. Hidden, idle, signed-out, banned, test, and offline clients stop sending. Activity collection is independent of cosmetic Realtime Presence.
- Daily / weekly / monthly: today, the last 7 calendar dates, and the last 30 calendar dates, including today, in `America/Chicago`. These are accounts, not a count of people. Windows remain partial until enough activity has been collected.
- Browsers: distinct persistent `lc_device_id` strings. Multiple accounts on one browser share an ID. Multiple browsers on one device, private browsing, or clearing storage can produce separate IDs. They do not identify physical devices or people.
- Foreground in 5m: accounts whose last eligible foreground observation reached the database within five minutes. This is not a socket-online count.
- Returning today: accounts observed today and on at least one earlier recorded date. No return/retention history is inferred before collection began.
- Messages: one metadata fact per successful insertion, deduplicated by scope and message ID. Edits, soft deletion, hard deletion, channel removal, and account deletion do not reduce sent totals. Visible-message counts query current undeleted rows separately. Forum replies count toward their parent channel.
- Engagement excludes Luna, system messages, and test accounts. Message/signup exclusions are captured when recorded. The moderation browser registry intentionally includes all registered identities.
- Private messages: aggregate volume across DMs and groups. Analytics stores no private message body, attachment URL, DM/group ID, or membership list.
- Signups: one fact per user ID, surviving account deletion. The seven-day signup card uses a rolling seven-day interval.
- A `24h` card and channel rankings use rolling intervals, not calendar days. Labels distinguish these from today.

## Coverage and storage

Activity starts at `chat_analytics_meta.activity_since`. Earlier dates are `null`, not zero. The first collected date and current date are partial. No last-seen device registry is treated as a historical daily visit log.

Existing surviving message and signup rows are backfilled once. Soft-deleted messages still present in the database are included; earlier hard-deleted rows cannot be recovered. The UI exposes the deployment timestamp after which message/signup history is durable.

All facts live in `private`, with RLS enabled and no browser table privileges. Timestamps, identities, increments, and role checks are controlled by the database. The only client-supplied activity parameter is its already-registered browser ID. The public RPC bridges have an empty search path, explicitly restricted EXECUTE privileges, and call private implementations that authenticate before doing any work. No USAGE grant on the legacy private schema is added.

## Maintenance and checks

`scripts/chat-analytics-ui.mjs` owns the identical view embedded in both standalone HTML apps. After changing it, run `node scripts/chat-analytics-ui.mjs`. Tests detect drift between the source and either HTML copy.

Run `npm test` and `node scripts/validate-deployments.mjs`. The analytics suite verifies backfill, account/browser/tab deduplication, unknown historical activity, midnight boundaries, returning accounts, exclusion rules, private metadata, immutable message totals, signup durability, real database permissions, dashboard consistency, foreground/idle behavior, coalesced requests, retries, HTML escaping, and JavaScript syntax.
