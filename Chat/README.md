# Corazon Chat

Corazon Chat is part of the Corazon platform by Crimson Heart. It was
previously called Liminal Chat.

## Chat 6.1, part 3: custom roles, editable rules, account sticker favorites

Needs [`20261111200000_chat_custom_roles_rules_stickers.sql`](../Backend/migrations/20261111200000_chat_custom_roles_rules_stickers.sql).
Until it is applied, Chat keeps the built-in roles and default rules and keeps
sticker favorites in the browser, so the HTML can be published first.

- **Custom staff roles.** Roles live in `public.chat_staff_roles` instead of
  being hard-coded. Each has a **permission level** (Mod, Manager, Admin or
  Co-owner) and a **position**. The level decides what the role can do, with
  exactly the existing rules: admin level cannot ban, mod-level time-outs stop at
  two hours, Drive and sticker uploads follow the level. The position decides
  who may act on whom (`private.chat_staff_power`), so a "Senior Mod" placed
  above Mod can time out Mods. Owner and PRESTON stay fixed at the top. The
  owner manages roles in Settings → Owner → Roles & badges → Role hierarchy:
  create (name, badge colour, level), edit, move up or down within a level,
  move to another level, delete (holders become Members). Built-in roles can be
  renamed but keep their level and cannot be deleted. Every built-in role keeps
  its current level, and admin, Super Mega Tuff Admin and Dusty stay equal
  until the owner reorders that level. Co-owners assign roles below their own
  position as before. The profile `staff_role` check became a foreign key to
  the catalog; an unknown role is stored as Member. The `chat-auth` Edge
  Function's password-reset pre-check reads the catalog too (the database
  re-checks every reset).
- **Editable rules (owner only).** The Rules dialog reads
  `app_settings.community_rules`; the owner edits it in Settings → Owner →
  Rules (add, remove, reorder, up to 30 rules) and every open Chat updates
  live. "Restore defaults" brings back the original six. Rule text is always
  shown as text, never HTML.
- **Sticker favorites on the account.** `public.user_fav_stickers`, one row per
  account, readable and writable only by its owner. Favorites already saved in
  a browser are merged into the account once, then follow the account to every
  launcher and device.

Tests: `scripts/chat-roles-rules.test.mjs` (built-in levels unchanged, custom
role creation, placement, level rules, reordering, deletion, catalog privacy,
rules validation, sticker privacy), the custom-role cases in
`scripts/security.test.mjs`, and the Roles and Rules panels in
`scripts/chat-polish.browser.mjs`.

## Chat 6.1, part 2: realtime, speed and a lighter, tighter layout

Measured with `scripts/chat-runtime.browser.mjs` at 4x CPU throttle (offline
fixture, 200 messages), `main` before this part vs after. Request-free local
measurements, not a production result.

- **Realtime as private broadcasts.** Chat used 13 `postgres_changes`
  listeners per client. Realtime decoded every change and evaluated row
  security once per listener, and every join created and deleted 13
  subscription rows (about 75,000 since October 20). Realtime's change polling
  was the largest database consumer (23,358 s). Now database triggers
  ([`20261111003952_chat_broadcast_changes.sql`](../Backend/migrations/20261111003952_chat_broadcast_changes.sql))
  (applied 2026-11-11, ledger version `20261111003952`; verified live: 14
  triggers, two join policies, no publish policy, broadcasts flowing with
  messages)
  send each change once, to `chat:live` (rows every signed-in member may read)
  or `chat:user:<username>` (DMs, groups, invitations, read cursors,
  owner-preview and follower-only posts). The recipients mirror each table's
  read policy at send time; joining a topic is authorized by
  `realtime.messages` policies (unbanned accounts, own user topic only), and
  browsers cannot publish to them. Soft-deleted rows carry no content and
  profiles never carry the legacy password column. Chat joins the two topics;
  if the join is refused (migration not applied yet) it falls back to the
  previous listeners automatically. The launcher keeps its one small
  app-settings listener, so Realtime's poller keeps running until a launcher
  update removes it.
- **Typing.** Each key press re-scanned the whole app for one selector,
  `.app-shell:has(.main-panel[data-workspace-home]) :is(#search-btn, …)` (90%
  of selector time while typing); it now keys on a flag on `<html>`. The
  conversation column is no longer a CSS size container (two `@container`
  rules became `data-narrow` / `data-tight` attributes set by a
  ResizeObserver). The character counter is a fixed-size contained box, so
  updating it no longer re-lays out the page. Key-event processing fell 41%
  (1,834 to 1,086 ms for 150 characters) and typing layout 65%.
- **Scrolling and idle.** The Fade/Shift name clock searched the whole
  document 20 times a second even with no animated names; it now walks live
  element lists and checks once a second when there are none. Rings and names
  everywhere hold while the timeline scrolls. Scroll script time fell 62%,
  timers 95%, and the scroll p95 frame from 50 to 33 ms (p99 67 to 50 ms).
- **Compact sidebar.** Channel rows 42 to 33 px, conversation rows 50 to 39 px
  with 28 px avatars, tighter section and category spacing. The rules are now
  defined once instead of an old rule plus an override.
- **Old layout removed.** Hover lifts, scaling and glows are now flat colour
  changes (press feedback stays). 294 CSS declarations that a later identical
  selector always overrode, 27 selectors for classes nothing renders, 55
  emptied rules, the unused sidebar indicator and 9 functions nothing called
  are gone. A computed-style comparison of all 1,048 elements in four
  theme/width combinations shows no change outside the compacted sidebar.
  The file is 12 KB smaller (643.6 KB gzip). Most of its weight is the app
  script (46%) and embedded fonts (24%: OpenDyslexic 314 KB, flags 105 KB);
  moving OpenDyslexic to a separately hosted file would make Chat about 18%
  smaller for everyone who does not use the dyslexia font.

The runtime harness now types real keys and reports Event Timing, expects five
background timers, delivers fixture changes as broadcasts, and accepts
`CHAT_PROBE` and `CHAT_TRACE_EXTRA` for one-off inspection. `scripts/chat-realtime-broadcast.test.mjs`
applies the migration in PGlite and checks who receives each change and who
may join each topic; `scripts/chat-input-performance.test.mjs` guards the
typing fixes.

## Chat 6.1, part 1: database errors and analytics removal

Versioning now follows the launcher generation: this update (three parts) is
**6.1**, and smaller follow-ups are 6.1.1 to 6.1.5. `APP_VERSION` is `6.1`.

Production Postgres showed bursts of statement timeouts (89 in 23 minutes, 39
in 5 minutes), `messages_pkey` / `dm_messages_pkey` duplicates,
one `dms_non_luna_participants_unique_idx` duplicate, and `permission denied`
on `dm_messages` and `dm_blocks`. Read-only counters are saved in
[supabase-usage-followup-2026-11-10.json](../docs/supabase-usage-followup-2026-11-10.json).

- **Duplicate message IDs.** Every new message still gets one fresh
  `crypto.randomUUID()`, reused by its retries so a lost response cannot send
  it twice. The duplicates came from retries: an insert aborted on the client
  after 20 s could still commit, and the retry re-inserted the same ID. A retry
  now looks the ID up first and only inserts when it is absent; after an
  aborted attempt it waits until 30 s after that attempt started, so a write
  still in flight is seen. A server refusal (permission, filter, block) is
  returned without an extra lookup. A row with the same ID is only accepted
  when it is this sender's message in the same conversation; it is never
  overwritten (no upsert). If another row owned the ID, the message is sent
  once under a new ID.
- **Duplicate DM threads.** Opening a DM looks for an ordinary DM
  (`is_group = false`) with exactly the pair. The old lookup also matched a
  two-person group with the same members, so `maybeSingle` failed and Chat
  inserted a DM that already existed. Repeated clicks share one request, a
  failed lookup no longer falls through to an insert, and a DM created by the
  other person at the same moment is adopted after the unique conflict.
- **Permission denied.** `anon` has no privileges on chat tables (checked
  live; grants and RLS are unchanged). The errors were requests sent with the
  publishable key after a session could not be refreshed: supabase-js falls
  back to the key, and wake/recovery kept reading lists and retrying sends.
  While signed in, Chat now stops any `/rest/v1/` request without a user token
  before it leaves the browser, refreshes the session once (at most every
  30 s), and treats the request as a network failure so unsent messages stay
  queued. If Auth reports the session ended (`SIGNED_OUT`), Chat stops its
  background work and reloads to sign-in; drafts are kept. Wake and Realtime
  recovery skip their reads until a session is available.
- **Timeouts.** `chat_unread_counts` takes 6 to 20 ms alone but averaged
  704 ms in production, and unrelated statements also reached the 8 s limit,
  so its plan is not the bottleneck: the database saturates in bursts. The
  largest consumer is Realtime's WAL polling (23,358 s since Oct 20, max
  14.7 s). When it stalls, every client loses its socket together, and each
  recovery re-read the conversation list, invites, DM blocks and unread counts
  every few seconds. Now:
  - Rejoins are jittered (up to 15 s) instead of all firing after 0.7 s.
  - The recovery backoff resets only after the connection has stayed up for
    60 s, so a flapping socket keeps backing off.
  - Recovery re-reads lists at most once a minute; unread counts are reused
    for a minute even without Realtime.
  - A 5xx response (statement timeout, gateway) pauses background
    reconciliation for 30 s, doubling to 5 minutes. Opening a conversation,
    loading history and sending still go through.
  No index or function change was needed for the unread lookup.
- **Phantom unread badges.** Channels showed 1 (sometimes 2) unread
  messages that had already been read. Message timestamps carry microseconds
  (all of the latest 1,000 do), but Chat rounded the read cursor to
  milliseconds before asking `chat_unread_counts`, so the server saw the last
  message read as newer than the cursor. This hit every channel whose latest
  message was from someone else, at each recount (boot, reconnect, every five
  minutes). Chat now sends the stored server timestamp unchanged and compares
  at microsecond precision. Two smaller causes are fixed too: a cursor only
  moves forward (an older page or a trimmed cache no longer marks newer
  messages unread), it never falls back to this device's clock when nothing
  is loaded, and a late or repeated delivery of something already read does
  not add a badge. Read state stays local to the device, as before; there is
  no new database write.
- **Analytics removed** at the owner's request. Every message insert ran an
  analytics trigger (two lookups and a write to a three-index fact table),
  each open Chat called `chat_record_activity` once a minute, and Control and
  the staff console recomputed a 30-day summary. Chat no longer sends
  `chat_record_activity` or `chat_get_analytics`; the staff and owner consoles
  lose their Analytics tab and show member, staff and channel counts from data
  already loaded. Control drops the analytics section, message-volume tiles and
  per-user/channel message counts.
  [`20261110222605_remove_chat_analytics.sql`](../Backend/migrations/20261110222605_remove_chat_analytics.sql)
  drops the triggers, RPCs, private fact tables and the analytics-only index,
  and rewrites `admin_dashboard_get_state` without them. Message data,
  permissions, RLS, the device moderation registry and deployment history are
  untouched. The dropped analytics history cannot be restored.

### Rollout

1. Apply `20261110222605_remove_chat_analytics.sql` (two-second lock
   timeout; run it at a quiet time). **Done 2026-11-10** (ledger version
   `20261110222605`), verified with read-only catalog checks. Older Chat clients get "function not
   found" from PostgREST for `chat_record_activity` without reaching Postgres,
   and back off to every 5 minutes until they reload.
2. Publish `Chat/chat.html` and `Admin/liminal-admin-dashboard.html`.
   An older Control copy shows "Analytics unavailable" after step 1 and works
   otherwise.

Tests: `scripts/chat-db-errors.test.mjs` (DM dedupe, anon gate, pressure
cooldown, recovery), the send idempotency cases in
`scripts/chat-send-loading.test.mjs`, and the removal checks in
`scripts/chat-backend-performance.test.mjs`, which apply the migration in
PGlite and confirm every account sees the same rows, policies are unchanged,
members can still send and banned accounts still cannot.

## Corazon rebrand (2.28.0)

A visual and naming rebrand. Accounts, messages, permissions, Supabase
access and the launcher protocol are unchanged.

- **Palette.** A new default theme, Corazon: background `#390606`, surfaces
  `#230404`, text `#FFF1F0`, and one soft rose accent (`#F4A6A1`) for
  selection, focus and primary buttons. The sidebar, member list, dialogs and
  cards use the surface colour; the conversation uses the background. Its
  overrides live in the `corazon-brand` style block and apply only while the
  Corazon theme is active, so the other themes look as before.
- **Type.** The logo and title (`Corazon Chat`) use Courgette. Body and UI
  text keep Montserrat and the system font. Pacifico and Syne still load for
  the name-style fonts members can pick.
- **Default theme.** Midnight, the old default, is still offered. A device
  that had Midnight saved moves to Corazon once (`lc_theme_brand` records
  it); choosing Midnight again afterwards sticks. The Crimson theme is
  retired now that Corazon covers it; a device with Crimson saved opens in
  Corazon. Every other saved theme is kept.
- **Copy and assets.** Title, metadata, favicon, notification icon, loading
  screen, login, navigation, settings, rules, toasts, blocked and maintenance
  screens, voice prompts and the owner console say Corazon. Downloads are
  named `corazon-chat-launcher.html`, `corazon-chat-data-<date>.json` and
  `corazon-performance-<version>.json`. `corazon` and `crimsonheart` are
  reserved usernames alongside `liminal`.
- **Launcher v6.** Restyled and renamed in its visible text. The message
  protocol is unchanged; the version moves from 5 to 6 so Chat can require
  the Corazon launcher. The Hub opens Chat as a launcher too, so its
  handshake version (`protocol` in `Hub/liminal.html`) also moves to 6.
  Launcher v6 downloads Chat once more after the update, because its
  IndexedDB cache is keyed by launcher version.

### Making everyone update the launcher

Order matters. Raising the minimum before v6 is downloadable locks everyone
out, because the replacement they download would be v5 and blocked too.

1. Publish `Chat/liminal-chat-launcher.html` to
   `liminal-apps/liminal-chat-launcher.html` and confirm the delivered file
   contains `LAUNCHER_VERSION=6` (the link in `launcher_download_url`).
2. Publish `Chat/chat.html`.
3. Hand out the updated `Hub/liminal.html` to anyone who opens Chat from the
   Hub. Older Hub copies report version 5 and get the download screen.
4. Then set `app_settings.min_chat_launcher_version` to `6`. Anyone on a v5
   (or older) launcher or Hub sees "This launcher is out of date" with a
   download button for `corazon-chat-launcher.html`. Their account, messages
   and saved settings are unchanged.

To roll back, set the value back to `5`.

Kept on purpose, because changing them would break existing links, sessions
or older clients:

- Storage bucket and object names (`liminal-apps/chat.html`,
  `liminal-apps/liminal-chat-launcher.html`) and the media buckets
  (`liminal-media`, `liminal-pfp`, `liminal-stickers`, `liminal-group-media`).
- The sign-in email domain (`@accounts.liminal.invalid`). Changing it would
  lock every account out.
- Realtime channel names (`liminal-online`, `liminal-presence`,
  `liminal-voice-signal`, `liminal-launcher-controls`) and the `liminal:*`
  postMessage types shared by the launcher, Hub and Chat.
- `lc_*` local storage keys, window-name prefixes and the launcher cache
  database, so saved sessions, drafts and settings carry over.
- Server messages in applied migrations (for example `Liminal Chat is
  currently disabled`). Chat checks the same setting before sending and shows
  its own Corazon message, so a new migration was not needed.

`scripts/chat-polish.browser.mjs` and `scripts/chat-layout.browser.mjs` now run
their header, call-card and layout checks in Corazon as well as Midnight and
Mono Light. The polish check also stopped expecting per-message DM receipts,
which were retired in favour of read cursors in an earlier release.

## Fewer duplicate background reads, plus timeline fixes (2.27.5)

Log Ingestion passed its 1 GB allowance on November 5. Every PostgREST
request writes a log line, and Chat sends most of them. Read-only statement
counters (no log scans, saved in
[supabase-usage-followup-2026-11-05.json](../docs/supabase-usage-followup-2026-11-05.json))
pointed at three avoidable patterns:

- **Wake catch-up.** Every `focus`, `visibilitychange` or `pageshow` more
  than 4 seconds apart re-read the open conversation, even with a healthy
  Realtime socket that had already delivered those messages. Chromebook users
  switch windows constantly. A wake now re-reads immediately only after a real
  absence: hidden for 30 seconds or more, frozen, page hidden, or offline.
  Otherwise the existing reconcile interval (5 minutes, 20 seconds for DMs)
  decides. Unhealthy Realtime still recovers and catches up as before.
- **SUBSCRIBED re-reads.** Each Realtime join reloaded the subrole catalog,
  conversation list and group invites. Boot and recovery already start those
  reads alongside the join, so each boot read them twice. SUBSCRIBED now
  reloads only a list that has not been read since that join (or the last
  channel error) began. A rejoin after an error still reconciles everything.
- **First DM open.** Opening an uncached DM fetched its page, then
  immediately ran a catch-up over the same rows. Only a cached DM reconciles on
  reopen now.

`scripts/chat-request-dedupe.test.mjs` counts the requests: 20 focus wakes in
five minutes now make one message read instead of 20, and boot makes one read
of each list instead of up to two. These are request-count results, not a measured
billing change. Message delivery, access-revocation checks, activity
tracking and the periodic reconcile intervals are unchanged.

Fixes found in the same pass:

- A banner saved without a crop position rendered at `NaN%` and fell back to
  the top-left corner. It is centred now.
- A confirmed send replaced its bubble without marking it as part of the
  timeline tail, so the newest message briefly used offscreen containment.
- A message dropped by the slur filter was put back into the composer.
- Deleting a message used the open view's table instead of the message's own.
- Leaving a conversation while "Load older" was in flight could hide that
  button for the conversation's live window.
- Subrole badge colours are cached instead of recomputed for every message
  header, and the avatar loader only scans for detached images when nodes were
  removed.

## Rings and typing dots stop redrawing every frame (2.27.4)

The lag predates name styles, and main-thread profiling never found it, because
it ran on the compositor and GPU side. Any animated ring on screen made Chrome
redraw the whole window 60 times a second for as long as it stayed visible.
The rings had a smooth spin, so the compositor produced a new frame every
vsync. The typing indicator animated `content`, which only the main thread can
animate, so Chat ran a full page update every frame while anyone was typing.
On a Chromebook that is sustained GPU load: dropped frames, delayed input and
eventual thermal throttling. It depends on who is on screen and typing, and
on-device reports showed long frames with no script in them.

- Rings now spin in 70 steps per turn (20 per second, 5° each), still on the
  compositor. Every running ring is put on one timeline phase (`startTime 0`)
  when it comes into view, restarts or the tab returns, so all rings step in
  the same frame. CSS still controls pause and resume.
- The name clock ticks on the same 50 ms timeline grid, so a ring step and a
  name change share one redraw.
- Typing dots are three dots with stepped `opacity` animations: compositor
  only, redrawn only when a dot changes.

Offline harness, idle, static avatars, rings restarted at random times,
backgrounds Off, no CPU throttle. GPU work is SwiftShader, so it stands in for a
weak or software-composited GPU:

| Idle scene | 2.27.1 | 2.27.4 |
| --- | --- | --- |
| Rings + someone typing, no name styles: window redraws | 60/s | 21/s |
| Same: GPU process CPU | 284% of a core | 42% |
| Same: page updates | 60/s | 0.1/s |
| Rings + typing + 9 animated names: GPU process CPU | 305% | 154% |
| Rings + typing + 9 animated names: window redraws | 46/s (saturated) | 21/s |

Animated GIF messages and stickers still redraw at their own frame rate while
visible. They already pause offscreen.

`scripts/chat-name-effects.test.mjs` covers the stepped, aligned rings, the
grid-aligned name clock and the opacity dots. `chat-idle-rendering.test.mjs`
and `chat-media-visibility.browser.mjs` load the new helper. Name-style,
media-visibility, diagnostics, runtime `--verify`, `--media-regression` in the
launcher, and a busy `chat-soak --verify` all pass.

## Idle Chat stops repainting every frame (2.27.3)

Chat dropped frames and lagged typing even when nobody scrolled and the
background was Off. The cause was the Fade and Shift name styles. Chrome
services a running CSS animation on every display frame, even one with
`steps()`, so each visible animated name made it restyle, paint and commit
the whole page continuously. The 2.27 step change reduced paint per change,
not those frames. The fade's `steps()` also applied per keyframe segment, so
it changed on almost every frame anyway.

Fade and Shift now move on one shared clock about 20 times a second. It writes
`--name-mix` (fade) or `--name-pos` (shift) only on visible, unpaused names
whose value changed, so page updates are capped at about 20 per second however
many names are on screen. Between ticks nothing runs. All names stay in phase,
keep their speeds and fade shape, stop in a hidden tab, offscreen or while the
timeline scrolls, and stay static under reduced motion. Name identity checks
ignore the clock's properties. Intersection tracking now covers only Fade and
Shift names rather than every name, and loaded avatars stop being observed.

Offline harness, idle, backgrounds Off, 4× CPU throttle, no frame counter:

| Idle scene | 2.27.2 | 2.27.3 |
| --- | --- | --- |
| 9 animated names: main thread busy | 252 ms/s | 165 ms/s |
| 9 animated names: page updates | 32/s | 20/s |
| 15 animated names: main thread busy | 251 ms/s | 195 ms/s |
| 15 animated names: key event duration, median / p95 | 120 / 200 ms | 32 / 48 ms |
| Same, inside the v4 launcher | 251.5 ms/s | 165.6 ms/s |

With animated names paused, an idle 2.27.2 used about 2 ms/s, so the rings,
avatars and the launcher were not the idle cost. Rings spin on the compositor.
Removing avatar layer promotion cut layers from 76 to 44 but saved no main
thread time, so it is unchanged. The launcher adds no measurable idle work.

`scripts/chat-name-effects.test.mjs` covers the clock (in phase, visible-only,
scroll pause, unchanged values, hidden tab, reduced motion) and fails on 2.27.2.
`chat-name-styles.browser.mjs`, `chat-runtime.browser.mjs --verify`,
`chat-media-visibility.browser.mjs`, `chat-diagnostics.browser.mjs` and a busy
`chat-soak.browser.mjs --verify` pass. The runtime harness now scrolls to the
top before its long-session burst, so that phase still reads history after
2.27.2 made the bottom rejoin live mode.

## Messages stay live after scrolling (2.27.2)

If a message arrived while the timeline was scrolled even slightly above the
bottom, Chat switched into history mode, and scrolling back down did not
switch it back. Sitting at the very bottom:

- new messages waited behind the "new messages" badge instead of appearing;
- every small scroll near the bottom requested another page from the server;
- DM read marks were withheld, so the other person saw the DM as unread;
- tapping the badge, or sending a message, first refetched the latest page
  and rebuilt every mounted row and its images before continuing.

Once the page being read reaches rows the live cache already holds, Chat now
rejoins live mode locally. It merges the page with the live cache (late rows
by time, unsent rows last), reconciles the rows already on screen, pins to the
bottom and marks the conversation read. This happens on scrolling back down,
when a message arrives at the bottom, after a newer page ends there, and on
Jump to present or send. A page that ends before the live cache, in deeper
history, still loads newer rows from the server as before, and an anchored
jump that is still settling is not pulled to the bottom.

Offline harness, about 210 mounted rows, 4× CPU throttle: the old full rebuild
took 84–139 ms of script and 145–232 ms to the next frame. The in-place
reconcile took 3–6 ms.

`scripts/chat-new-messages.test.mjs` covers rejoining, ordering, staying in
history and Jump to present. Four of its new tests fail on 2.27.1.

### Long-session soak

`scripts/chat-soak.browser.mjs` runs the full app offline for many minutes
with real timers and Realtime callbacks, plus simulated messages, typing,
presence, profile edits, focus/wake and scrolling. `--busy` adds DM traffic,
animated names and channel switches, and `--blip` drops the Realtime socket
every five minutes. It samples heap, DOM, listeners and attributed main-thread
work, and counts samples where the timeline is at the bottom but not live.

A 25-minute run of 2.27.1 found no leak or growth over time: heap stayed at
3–5 MB, long frames fell after startup, and DOM growth followed the message
caps. The stuck history mode above was the defect it surfaced. In 12-minute
`--busy --blip` runs (a message every 3 s, reading a little above the bottom
once a minute, tapping the badge whenever it showed at the bottom):

| | 2.27.1 | 2.27.2 |
| --- | --- | --- |
| Samples at the bottom but not live | 7 | 0 |
| Samples with delivered messages not shown | 10 of 47 | 0 of 48 |
| Badge taps that rebuilt the timeline | 7 (35–96 ms each) | 0 |
| Top-level `renderTimeline` time | 1,055 ms | 52 ms |
| `messages` reads | 28 | 9 |

The two runs shared one machine, so their frame intervals are not compared.
With `--verify`, a 3.5-minute run fails on 2.27.1 and passes on 2.27.2.

```sh
CHAT_MEDIA_DIR=/path/to/gif-test-assets SOAK_MIN=25 \
node scripts/chat-soak.browser.mjs Chat/chat.html soak --busy --blip --verify
```

## Smoother scrolling (2.27.1)

Scrolling the timeline with the pointer over messages dropped frames. Two
causes were measured in the offline harness (4× CPU throttle, software GL,
pointer over the timeline, wheel scrolling up through unseen messages):

- The 2.27 scroll class on `.timeline` had descendant rules (`.msg` pointer
  events, `.display-name` animation pause). Each toggle restyled ~900 elements
  (30–40 ms per toggle under throttling), and slow frames let the 120 ms settle
  timer toggle it again mid-gesture. The class now only styles the scrollbar.
  Visible animated names get `data-scroll-paused` individually.
- Without hover suppression, each message passing under the cursor revealed
  its action bar (layout, paint and layer rebuilds). Hover is now suppressed
  by `pointer-events: none` on the single `.timeline-inner` wrapper, an
  inherited property that does not restyle the subtree.

The new-messages badge's `hidden` attribute is no longer rewritten on every
scroll frame. Over two A/B runs of the first scroll up: 73–81 → 108–144 frames
in the window, long tasks 19–22 → 5–8, style recalc ~800 ms → ~300 ms, p95
117 ms → 67 ms. Remaining cost is painting animated GIFs/rings, unchanged.

No backend change. `scripts/chat-scroll-rendering.test.mjs` and the new
`scroll` phase of `chat-runtime.browser.mjs --verify` cover this.

## Smoothness and delivery fixes (2.27)

**Lite mode removed.** It had no setting; Chat silently switched it on for
reduced-motion, data-saver, ≤2 GB/≤2-thread devices and ≤4 GB Chromebooks,
turning off animation, blur and link previews and halving message windows.
Every device now gets the same rendering and limits (200 history rows, 50-row
catch-up). Reduced motion is still honored by the existing
`prefers-reduced-motion` rules; Chromebooks keep their 24 fps background cap
and static sign-in rays. The always-true `data-performance="auto"` selectors
and the never-set `"full"` rules are folded into plain rules. Picker popovers
now get the transparent, unblurred backdrop their own rule intended.

**Rendering**

- Fade and moving-gradient names step at about 20 updates per second (30 for
  Fast) instead of every frame. In a 40-name software-rendered trace, paint and
  raster time fell from 379 ms to 148 ms per 3 s. Names also pause while the
  timeline scrolls. The fade keyframes keep its ease-in-out shape.
- Message images, GIFs and stickers remember their natural size per browser
  (`lc_media_sizes`, 600 entries, keyed by stored `media_url` so private group
  links survive re-signing) and reserve that box on later renders instead of
  shifting the timeline as they load. Images also decode asynchronously.
- Link previews persist for seven days (`lc_link_previews`, 200 entries);
  failed lookups for a day. Timeouts and rate limits are not stored.

**Delivery**

- The catch-up poll re-reads up to 60 s or 50 known rows before the newest
  message, raising its limit by the known rows, so a row committed late and
  missed by Realtime is recovered. Late rows are placed by `created_at` among
  delivered rows (pending sends stay below) and DM previews keep the newest row.
- Failed sends with no server error code (network/timeouts) retry automatically,
  oldest first, when the browser comes back online or the tab wakes; at most
  three automatic attempts. The retry reuses the message ID, so a lost response
  cannot create a duplicate. Refusals (permissions, filters, blocks) still wait
  for Retry.
- Typing indicators expire on the receiving device's clock, and read marks use
  the newest delivered message's server timestamp, so a skewed device clock no
  longer sticks "is typing" or miscounts unread messages. Read-state storage
  writes are batched (flushed on page hide).
- `profile_updated` broadcasts no longer make every client refetch the profile
  when the Realtime row change for it arrives within the grace window.
- Opening a conversation with unread messages shows a **New** divider above the
  first unread message from someone else until another conversation opens.

No backend migration is required. Validation: `npm test` (new
`scripts/chat-message-order.test.mjs` covers ordering, catch-up windows, clock
handling, auto-retry and the profile refetch gate). The offline layout, name
style, media visibility, diagnostics and runtime `--verify` browser harnesses
pass; `chat-polish.browser.mjs` fails at the same assertion on the unchanged
2.26.1 source.

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

The standalone launcher is [liminal-chat-launcher.html](liminal-chat-launcher.html) and has its own deployment Action. It is published under the same object name; people who download it get `corazon-chat-launcher.html`.

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

