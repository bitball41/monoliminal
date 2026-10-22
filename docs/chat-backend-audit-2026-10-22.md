# Liminal backend timeouts — October 22, 2026

Applied to `trsirhyucncmyyfyiuje`. These changes run in the database and do not
require a new Chat HTML upload.

## Confirmed causes

The 14:55–15:06 UTC incident included failed message inserts, DM read receipts,
unread counts and settings reads. PostgREST logged both statement timeouts
(`57014`) and connection-pool acquisition timeouts (`PGRST003`). Postgres logs
repeatedly identify the owner-preview audit/reply lookups, along with message
row-lock waits. Other queries also timed out as connections became unavailable.

1. Both Noelle owner-preview triggers compare `messages.id::text` with an ID
   from JSON. The UUID primary-key index cannot serve this expression. One
   failed-ID lookup scanned 55,595 rows, used 1,438 shared blocks, and took
   964.191 ms. A partial expression index preserves malformed-ID behavior and
   owner-only rules. The identical lookup used an index and took 0.130 ms.
   Bulk deletion invokes the audit trigger for every affected message, so the
   old full-table scan multiplied its cost.
2. Message, forum, follow and DM policies repeatedly called the signed-in
   username/staff helpers while filtering rows. Statement statistics showed
   more than four million profile-index accesses. Scalar InitPlans now reuse
   request-constant identity results; membership and all row predicates, policy
   roles and restrictive/permissive modes remain intact. Inbox and invitation
   functions use the same optimization.
3. Exact unread counts use `deleted=false`. The existing live-message partial
   index uses `coalesce(deleted,false)=false`, which does not match that predicate.
   A covering partial index now serves exact counts without loading every
   message body. A member's full General count changed from 990.385 ms and
   131,126 shared-block accesses to an index-only plan: 42.826 ms and 3,090
   shared-block accesses in the transactional test. After deployment, a sample
   taken concurrently with advisor scans took 340.894 ms and 3,120 blocks.
4. The analytics function materialized the entire durable message ledger and
   rescanned it for multiple counters. Cumulative statistics showed a 1.967 s
   mean across 73 calls and 53,475 temporary blocks written. A direct baseline
   took 3,943.579 ms with 758 temporary blocks written. Totals now share one
   aggregate; date-filtered queries can use indexes, and sender deduplication
   avoids sorting the whole ledger. No analytics fields or definitions changed.

## Validation and limits

- Both migrations were applied live. `ANALYZE` refreshed message/ledger planner
  statistics. The final Performance Advisor reports no warning-level findings;
  its old per-row Auth initialization warning is gone. The six informational
  unindexed foreign keys are outside these hot queries. Security Advisor's
  findings have the same categories/counts as before the repair.
- A 13-conversation member inbox changed from 78.159 ms to 15.138 ms.
- Three sequential post-repair analytics calls measured 200.8, 203.1 (median)
  and 952.2 ms. A sample concurrent with advisor work took 2,176.568 ms but wrote
  no temporary blocks. The optimized query still has a variable execution time;
  these measurements do not prove the server cannot stall under other load.
- Twenty focused tests pass, including 114 existing authorization checks.
  New coverage compares every analytics field and complete visible message,
  forum, follow, DM, receipt, inbox and invitation results before/after for
  members, an owner, banned/test accounts and a missing identity. Existing
  private-group and Noelle tests verify access revocation and owner-only rows.
  The maintenance script also passes an idempotency check.
- Table statistics showed little dead-row accumulation (233 in public messages,
  301 in DMs at inspection), no stuck idle transactions and no active blockers
  at the final activity snapshot. These snapshots cannot exclude transient
  contention during a later busy period. Historical query counts are cumulative,
  not current requests per second.
- These are database timings. No authenticated browser send/read flow or
  after-deployment busy-period load test was performed. The live Chat HTML was
  updated at 12:06 UTC; the separate downloadable launcher object still had an
  October 12 timestamp. This repair does not publish or replace either file.

Checks:

```sh
node --experimental-strip-types --test scripts/chat-backend-performance.test.mjs \
  scripts/security.test.mjs scripts/chat-groups.test.mjs \
  scripts/noelle-ai.test.mjs scripts/chat-analytics.test.mjs
```
