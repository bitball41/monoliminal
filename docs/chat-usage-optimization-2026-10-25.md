# Chat usage optimization — 2.25.0

Implementation is prepared and tested. **The database migration and thumbnail
backfill have not been applied.** Supabase `apply_migration` failed twice with
`Invalid or expired requestState`; the transactional `execute_sql` fallback
failed with the same error. A subsequent catalog check confirmed the new
`pfp_thumbnail` column was absent. Do not deploy the frontend before the SQL.
The temporary avatar maintenance function has been redeployed disabled; an
unauthenticated HTTP request returns 410 with `Maintenance disabled`.

## Changes and acceptance evidence

| Checklist | Prepared change | Verification / remaining work |
| --- | --- | --- |
| 1. Avatar caching | Stable original/thumbnail URLs, visible-only loading, one in-flight request per URL, bounded persistent public-image cache with HTTP-cache fallback, failure backoff and reused image nodes. | Native Chromium: 30 rebuilds of 30 avatars caused one avatar fetch, with 929 memory reuses; an offscreen avatar had no `src` and was not fetched. The HTTP preview lacks CacheStorage. Cross-document CacheStorage reuse passed in the unit fixture; native HTTPS verification remains pending. Cross-origin resource timing did not expose transferred bytes; zero must not be interpreted as zero bytes downloaded. |
| 2. Thumbnails | Upload-time 200×200 WebP companions; `pfp` preserves originals, including animated GIFs used in the full profile. Old clients changing `pfp` invalidate stale thumbnails. | Prepared 62 current avatars: 28,289,645 original bytes → 386,888 thumbnail bytes (98.63% smaller in aggregate). There are 21 animated originals. All originals downloaded successfully. Backfill waits for the SQL migration; no profile has been changed. |
| 3. Unreads | One RLS-preserving RPC replaces per-channel reads, caps each badge at 100, coalesces overlapping calls, retains cursors and updates from Realtime. | Tests cover bans, follower-only content, authentication, concurrent loads, cursor changes during requests and incoming messages. A five-minute healthy reconciliation remains as a lost-event safety net. A bounded legacy fallback supports backend-first rollout. |
| 4. Recurring RPCs | Activity interval increases from 60 to 120 seconds, with idle/hidden/offline gates and bounded retry. All conversation/invite entry points now share in-flight work. Forum caches follow relevant events with five-minute healthy / 20-second disconnected reconciliation. | Request-count and concurrency tests pass. The previous five-minute conversation reconciliation is retained. Activity sampling can now lag interaction by up to two minutes; DAU/WAU/MAU still use server records. |
| 5. Receipts | New client omits `read_by` reads/writes and removes receipt UI. New cursor RPC updates only `dm_reads`; the legacy receipt RPC becomes cursor-only. Cursor subscription is filtered to the current user. | Database tests prove both endpoints leave every DM message column unchanged and reject non-participants, banned users and anonymous callers. Cursors are monotonic and unchanged views do not write again. Historical `read_by` data and guard/import dependencies remain intact; no columns are dropped. |
| 6. Logging / failures | Recurring client warnings are rate-limited and omit payloads. The signup-throttle Edge warning emits only a code. Avatar failures back off for five minutes and failed assets are not cached. Request reductions also avoid corresponding platform request logs. | Browser console output does not itself consume Supabase log ingestion. Pooler/infrastructure logging has not been changed. No currently referenced avatar failed during preparation. A broader historical-media repair is not claimed. |
| 7. Log scans | Save aggregate findings; use explicit windows, source filters and route filters. Never poll Logs Explorer as a live application monitor. | This run used one daily baseline scan and small bounded metadata probes. Billable GB scanned is unavailable through these tools; no percentage reduction is claimed. |
| 8. SQL / Realtime | Batch unreads through existing RLS, remove message-row receipt fan-out, preserve existing indexes and channel cleanup. | Existing history/index and authorization tests pass. Current analytics summary benchmark: 3,746.9 ms, 50,784 shared-buffer hits, zero shared reads; the message-facts ledger is ~71,062 rows / 27,795,456 bytes. This confirms a remaining analytics cost. No ledger/index is dropped and no unbenchmarked analytics rewrite is deployed. |
| 9. Before / after | Capture baseline counters and export local per-route request/failure/time aggregates alongside avatar cache counters in the performance report. | The baseline is saved in the companion JSON. The after window, billing meters and overall savings remain pending deployment and comparable traffic. |

## Rollout

1. Apply `Backend/migrations/20261025051855_optimize_chat_usage.sql` through the
   authenticated Supabase migration tool or SQL editor. It is additive and
   idempotent; it preserves originals, receipt history and authorization rules.
2. Check that the column, two new RPCs, cursor-only legacy RPC and `dm_reads`
   publication exist. Verify authenticated/member, banned and anonymous cases.
3. Backfill prepared thumbnails with `chat-avatar-maintenance` using a fresh
   temporary capability, only its SHA-256 digest in deployment configuration,
   and a short expiry. The handler compares the current `pfp`, verifies the
   uploaded HTTP object before referencing it, and conditionally sets only
   `pfp_thumbnail`. It skips changed profiles. Never commit capabilities,
   service keys or the per-user manifest. Redeploy the committed disabled
   configuration after completion.
4. Merge the frontend after the backend checks pass. The repository's existing
   main-branch workflow runs the full tests and publishes Chat to Storage.
5. Verify the delivered HTML reports 2.25.0, and test unread cursors and avatar
   replacement in a real signed-in browser. Keep the prior release available
   through the existing deployment history/rollback workflow.

## Measurement

The saved baseline is October 24 05:00 UTC → October 25 05:00 UTC, a complete
America/Chicago calendar day: 8 active accounts, 9 browser IDs, 1,266 channel
messages and 236 DMs. Successful message GETs were 3,831 (478.9/account), forum
GETs 1,112 (139/account), activity RPCs 1,139 (142.4/account), and each
conversation/invite RPC 784 (98/account). These are measured request counts;
the proposed savings percentages remain estimates.

The baseline log query returned its top-100 limit. Individual recorded route /
method / status groups are valid, but the result is incomplete for overall
request totals and uncommon failures. Do not silently treat it as a complete
request inventory or rerun broad scans just to fill a chart.

After rollout, use a full Chicago day and the same successful route groups,
normalize by active accounts and message volume, and note weekday/device mix.
Use billing meters for egress, log ingest and log-query scan GB; those values
cannot be reconstructed exactly from request counts. Browser resource timing
zeros without timing exposure are unknown, not zero-transfer proof.

For a future single baseline query, group public-avatar paths into a single
bucket *before* aggregation, rather than creating a result group per filename.
Keep explicit UTC boundaries and `source='edge_logs'`, request only the needed
routes, and save the aggregate. Use `pg_stat_statements` for application SQL
costs; those queries are distinct from scanning diagnostic logs.

## Follow-up that still needs evidence

- Collect the complete after window and billing meters before claiming overall
  database, egress, latency, ingestion or scan savings.
- Optimize the measured analytics-summary bottleneck separately, with identical
  output/authorization tests and before/after plans; the current benchmark is
  evidence of cost, not proof that any particular rewrite will help.
- Audit historically broken non-avatar media only with a narrow failed-route
  sample. Do not crawl every historical attachment or repeatedly scan a day of
  logs to search for a handful of errors.
