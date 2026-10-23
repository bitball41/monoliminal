# Slow sending and startup — October 23, 2026

Client release: 2.24.8. Source: `Chat/chat.html`. No database migration is required.

## Evidence

Live gateway logs for 13:00–13:33 UTC showed message POSTs averaging 1,397 ms,
with a 3,933 ms p95 and 56,624 ms maximum. Message GETs reached 60,077 ms.
Settings, invitations and other unrelated reads also stalled. Postgres logged
statement timeouts, including message inserts. No active blockers were present
in the inspection snapshot. These results establish real server stalls, but do
not establish the platform-level cause of every stall.

Startup also amplified the problem: it created another Supabase client in the
embedded boot path, read settings repeatedly, awaited nine loaders, then awaited
every channel's unread query before painting the shell and fetching General.
Unread badges already display 99+, but exact counts scanned entire histories.

Using an authenticated member's RLS context, an exact General unread count
read 52,324 rows and took 715.998 ms. Limiting the same visible-row query to the
100 rows needed by the badge took 2.009 ms. This is a single database measurement,
not an end-to-end browser loading or message-send benchmark.

Later, two transactional member-context inserts (both rolled back) took
5,611.049 ms and 16,615.908 ms. The latter hit cached buffers and spent hundreds
of milliseconds even in the ordinary owner-preview marking trigger, which has
no reply lookup for this input. Several other independent triggers also stalled.
This reproduces a remaining server execution problem independently of the UI;
the client patch cannot establish that it has resolved those stalls. The same-ID
duplicate insert was rejected and left only one row inside the test transaction.

## Changes

- Reuse the Supabase client; coalesce launcher gates and settings reads.
- Keep device/account/maintenance checks. Display startup failures with Retry
  instead of silently signing out a valid session after a temporary API error.
- Load identities and channel navigation first. Paint the shell, connect
  Realtime, and load the first conversation before optional catalogs, favorites,
  invitations, device registration and unread hydration. Background jobs use a
  bounded queue, with at most two unread queries running together.
- Query at most 100 RLS-visible unread IDs per chat channel. Keep the existing
  99+ badge display and ignore stale responses after the channel is marked read.
- Bound REST reads and read-only RPC requests to 12 seconds. Disable SDK retry
  loops for primary startup/history reads. Profile compatibility fallbacks run
  for schema errors rather than repeating timed-out queries.
- Assign each message one UUID before insertion. Retry with the same ID, check
  for an already committed row after errors, and reconcile by ID rather than
  message text. Bound message requests to 20 seconds; a lost response is not
  treated as proof the write failed. Late confirmations repair failed bubbles.
- Merge optimistic messages and live arrivals into in-flight history results,
  resolving already confirmed placeholders before merging to avoid duplicates.

## Verification and delivery

All 205 automated tests pass. The suite covers startup with optional loaders stalled, settings
coalescing, cancellation propagation, bounded unread work, read-state races,
ambiguous responses, duplicate IDs, identical messages arriving out of order,
late confirmations and history/optimistic-send overlap. Existing authorization,
groups, Noelle, voice, polling, launcher and deployment tests remain included.

No authenticated browser send/load timing was measured. Chromium could not be
installed in this environment because the browser download was invalid.
The database queries above were run against production with member RLS enabled.
The fix reduces confirmed expensive work and improves recovery; it does not
prove the shared server cannot stall again.

The existing Chat deployment Action failed at Storage GET with HTTP 402 on the
previous main revision. Source and a manually uploadable `chat.html` are the
deliverables; a successful production upload must be verified separately.
