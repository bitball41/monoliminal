# Chat usage repair — 2.24.7

The October 21 screenshot shows 0.42 GB egress, 118 MB database size,
0.25 GB file storage, 0.18 GB log ingestion, and 14.1 GB log queries.
These meters measure different things. Restored files and historical database
rows are part of the new project's starting footprint, not one day of new
messages. The log-query meter measures data scanned by log searches, not data
downloaded by Chat members. This audit used database statement statistics and
a single bounded one-hour log window, rather than repeated day-wide scans.

## Observed request costs

The project's cumulative statement statistics contained 8,815 calls to
`chat_private_voice_room`, 2,585 conversation-list calls, 2,580 invite-list
calls, and 1,731 voice-mute reads. These are cumulative counts since the
project's statistics began, not measured per-user daily rates.

The 00:00–01:00 UTC October 22 log window contained 466 successful message
reads, 137 forum-thread reads, and 77 calls each to conversation and invite
lists. Its current profile rows and public message attachments contained no
inline data-URL images; removing nonexistent inline images would not help.

## Changes

- Private voice calls retain authorization on joining and immediate checks on
  received membership events. Their safety poll runs every 32 seconds on the
  existing four-second timer instead of every four seconds (about 87% fewer
  periodic membership requests). A revocation hidden by RLS is still caught
  by this poll; its worst-case polling delay is now about 32 seconds.
- The voice-mute subscription still delivers changes immediately. Healthy
  calls reconcile the table every five minutes, with a 12-second fallback
  when that subscription is disconnected. Concurrent reads share one request.
- Opening global voice once no longer causes perpetual 20-second voice-history
  reads in other views or hidden tabs. Voice history follows the existing
  five-minute reconciliation / 20-second disconnected fallback.
- An open DM checks only its conversation ID for revoked access. It no longer
  downloads every preview and group invite every 30 seconds. Full lists
  reconcile every five minutes while healthy, and membership/invitation events
  still refresh them immediately. Message delivery and its existing 20-second
  DM fallback are unchanged.
- Conversation event bursts share a refresh and one follow-up when needed.
- Failed Realtime recovery backs off to one attempt per minute, rather than
  repeatedly recreating subscriptions and rehydrating unread lists. Hidden
  tabs wait for foreground recovery; healthy sockets remain connected.
- Launcher 5 stores the public 1.7 MB Chat document locally in IndexedDB. Each
  launch reads the small public Storage metadata JSON and reuses HTML only when
  its ETag still matches. Owner refreshes and explicit retries download anew.
  This avoids depending on cross-origin exposure of the ETag response header.
  Blocked, full or unsupported browser storage falls back to normal downloading.
  Both the new launcher and Chat HTML need manual publication.
- Newly uploaded public media uses unique keys with a seven-day browser cache.
  Existing sticker uploads retain their one-year policy. Private group
  attachments and application HTML are excluded from the media repair.

## Restored media headers

4,994 migrated public assets had `max-age=0`: 4,111 media objects, 520 avatar
objects, and 363 sticker objects. Newer public uploads mostly had the default
one-hour cache. The restored zero-duration headers cause avoidable browser
revalidation, and can cause repeated downloads where the browser cannot reuse
its previous response. Zero-duration headers alone do not prove that every
request downloaded the full object.

`Backend/edge-functions/chat-cache-repair` performs a one-time Storage API
same-key copy with `copyMetadata: false` and `cacheControl: max-age=604800`.
This changes the backing object's headers, unlike editing SQL metadata alone.
It checks the original version and size before copying and verifies size,
ETag and owner afterward. Service-role same-key upserts omit owner columns
and preserve the existing owner; this was verified on the live project.
Custom metadata is explicitly preserved. No object bytes pass through the
maintenance function.

The function requires a random temporary bearer capability, stores only its
SHA-256 digest, accepts at most 20 manifest entries per call, restricts buckets,
and expires. The committed configuration disables it. After maintenance the
live configuration is also disabled. No service key, maintenance capability,
or user asset manifest belongs in the repository.

Verification covers periodic request counts, lost-access cleanup, request
coalescing, reconnect backoff, hidden-tab behavior, maintenance authorization,
and preservation of storage ownership/metadata. The release does not claim
that all egress or log ingestion will disappear. Actual billing savings need
subsequent usage measurements after the updated Chat file is uploaded.

## Rollout and checks

Publish `liminal-chat-launcher.html` before `chat.html`. Existing users need
Launcher 5 to receive the application-document cache. Once that download is
live, the admin dashboard's minimum launcher version can be set to 5 using
its existing control. Do not raise it while the old download is still served.

All 195 unit/database tests pass and all eight deployment artifacts validate.
The offline native Chromium check is included as
`scripts/chat-launcher-cache.browser.mjs`; it could not run here because no
browser executable was installed and the browser download failed. Its native
file-origin check must not be represented as having passed. Unit checks do
exercise actual cache read/write flow, reuse between launcher instances,
version changes, explicit refresh, unavailable storage and metadata timeouts.
