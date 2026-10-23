# Shared Chat and Games stalls — October 23, 2026

The 2.24.8 Chat file was confirmed in production: 1,731,854 bytes, uploaded at
14:10:56 UTC. Continued failures were not explained by an uninstalled patch.

## Live findings and repair

Both apps share project `trsirhyucncmyyfyiuje`. Chat messages, startup settings,
profile reads and `games_get_usage` stalled together. A process snapshot showed
the Supabase exporter reading `pg_stat_statements` for over 40 seconds, alongside
API requests and aborted transactions. No lock blockers were listed.

Performance history contained 2,883 entries and 26,437,483 bytes of query text.
Of this, 183 completed migration DO statements from October 20 accounted for
25,334,704 bytes. DO bodies retained literal batch payloads in performance
history. Only byte counts, query identifiers and aggregate timings were
inspected; migration payloads were not exported into this report.

The targeted maintenance script resets only those old migration performance
entries. It was applied live and reported 183 entries removed. It does not
modify messages, accounts, game statistics or database authorization. The
remaining query text measured 1,104,124 bytes, about 96% less. Existing Chat,
Games and other query-performance entries were retained.

PostgreSQL documents that statement text is stored in an external file and
that clients can use `pg_stat_statements(false)` to avoid repeated text retrieval:
https://www.postgresql.org/docs/17/pgstatstatements.html

This identifies avoidable monitoring overhead. The timings below support an
improvement after cleanup, but are not proof that it was the only cause of the
intermittent stalls or a substitute for monitoring CPU/resource time series.

## Measurements

- Before: separate rolled-back member inserts took 5,611 and 16,616 ms.
- After cleanup: a three-insert transaction measured 2,998, 198 and 33 ms.
- A subsequent separate member-context transaction measured a 150 ms insert,
  10 ms history query and 1.3 ms profile RPC. All test messages were rolled back.
- Games usage measured 438 ms, then 76 ms in a later transaction.
- A later settings read measured 1.9 ms. Reading performance totals measured
  287 ms, down from a monitoring process observed active for over 40 seconds.

The 14:37–14:38:30 UTC gateway sample still included requests completing from
the stall: settings and Games requests reached about 51 seconds. It also showed
50 successful Chat reads averaging 180 ms and four successful sends averaging
1,800 ms. The window overlaps the cleanup and must not be represented as a
clean before/after comparison.

The later 14:40–14:46 UTC gateway window had no failures on the sampled paths:
48 successful sends averaged 447 ms (2,636 ms maximum), 93 history reads averaged
214 ms, 18 settings reads averaged 110 ms (343 ms maximum), five profile RPCs
averaged 81 ms and 20 Games usage calls averaged 392 ms (1,319 ms maximum).
Intermittent latency remains: send p95 was 2,422 ms. This is evidence of recovery
from the prolonged stalls, not evidence of consistently instantaneous sends.

Direct HTTP probes from the execution environment took 4–7 seconds end to end,
while matching response headers reported 132 and 186 ms upstream service times.
The environment/network overhead must not be attributed entirely to Postgres.

## Games startup resilience

The embedded Games page awaited a settings fetch without a deadline. The
launcher hello and fallback timer could start duplicate requests. Coalesce
those requests and gate decisions, preserve successful settings for this boot,
and abort a stalled request after eight seconds, including its response body.
The pre-existing network-error fallback remains; known minimum launcher
versions still block obsolete launchers. No game catalog or launch behavior
changes are included.

Verification covers overlapping gates, stalled headers/body, a hello arriving
mid-request, cleanup of timers and enforcement of a newer launcher version.
All 209 application and authorization tests pass, along with deployment mapping
validation. The backend cleanup is live. The Games HTML change is a separate
upload; the pre-existing automatic deployment credential/HTTP 402 problem
does not establish that the new Games file has been published.
