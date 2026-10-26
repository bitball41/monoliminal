# Supabase usage controls

Audit date: October 25, 2026 (America/Chicago). Repository base:
`71f6a0e81c184deb4492147efd9b3ed231694e40`, checked against freshly fetched
`origin/main`. Current project: `trsirhyucncmyyfyiuje` (Liminal).

## What needs attention

| Meter in the supplied screenshot | Used / included | Share |
| --- | --- | --- |
| Log Query | 87.7 / 100 GB | 87.7% |
| File storage | 0.56 / 1 GB | 56% |
| Log Ingestion | 0.55 / 1 GB | 55% |
| Database size | 135 / 500 MB | 27% |
| Egress | 0.97 / 5 GB | 19.4% |
| Monthly active users | 46 / 50,000 | 0.092% |

The screenshot has no capture timestamp. These are billing-cycle totals, not
daily growth rates or current live API measurements.

**Log Query counts log data scanned by Studio, the logs API, CLI, or agents.**
Repeated searches scan again. Ordinary application SQL/API reads affect other
resources and generate logs, but they are separate from reading diagnostic logs.
Supabase currently states that the query allowance is not enforced and is not
billed directly. Recheck the [live Log Query documentation](https://supabase.com/docs/guides/platform/manage-your-usage/logs-query)
before acting on a future warning. The [September 25 rollout announcement](https://supabase.com/changelog/logs-usage-based-pricing)
describes the grace period; newer organizations may receive a different future
enforcement date. The screenshot alone is not a reason to upgrade.

## Stop avoidable diagnostic scans

- Prefer this audit's [saved counters](supabase-usage-snapshot-2026-10-25.json),
  earlier saved request aggregates, and Postgres statistics before scanning logs.
- Use logs for a concrete question. Start with 5–15 minutes and filter source,
  route, and status inside the query. Save the result rather than rerunning it.
- Disable unattended refresh in any open log dashboard or external monitoring
  integration. The repository has no application or workflow polling the logs
  API; external tooling and dashboard history were not available for attribution.
- Do not schedule recurring broad log scans to measure these changes. Capture
  billing meters and database-counter deltas instead. A deliberate, one-time
  before/after request analysis can use explicit comparable windows when needed.

This audit used **zero log scans**. It does not attribute the existing 87.7 GB to
a particular person, tool, or application. Previous saved audits document some
log searches, but they do not expose per-query GB or a complete query history.

## Application work

Chat 2.25.0 already includes avatar thumbnails/cache, batched unreads, cursor-only
DM reads, and foreground/idle/activity gates. See its
[release evidence](chat-usage-optimization-2026-10-25.md). Do not undo those fixes
or blindly slow message delivery and access-revocation checks.

The current follow-up changes these refresh loops:

- Games statistics reconcile every five minutes instead of every minute while
  visible and online: 80% fewer routine reads in a continuously visible tab.
  Launches still trigger fresh statistics. Concurrent reads share work, with a
  follow-up when a launch completes during an earlier read.
- Admin state reconciles every two minutes instead of every 30 seconds: 75%
  fewer routine reads in a continuously visible tab. Manual refreshes and
  completed mutations still request fresh state. Old-session responses cannot
  repaint a replacement session.
- Automatic reads pause while hidden/offline, resume only when stale, and back
  off after failures to a maximum 15-minute retry delay. Games announcements
  keep their existing two-minute healthy reconciliation with the same offline
  and failure controls.
- The analytics summary computes rolling cutoffs once and uses a compact
  partial sender index to count eligible visible messages. All summary fields,
  account exclusions, historical facts, and staff permissions remain identical
  in the local before/after tests. The new index is about 450 KB in the synthetic
  fixture. The [saved synthetic benchmark](chat-analytics-performance-2026-10-25.json)
  records 154 → 103 ms median warm execution and 2,574 → 56 shared-buffer hits
  for the visible count. The [backend rollout record](supabase-analytics-deployment-2026-10-25.json)
  contains the subsequent live plan and access checks; production's visibility
  map and workload differ from the fixture.

Those intervals mean passive Games statistics can be five minutes old and
passive Admin state can be two minutes old. These changes reduce API requests,
database work, and resulting request logs. They cannot erase earlier Log Query
usage. The request-count reductions are verified behavior, not measured billing
savings; production savings need post-publication measurement.

## Read-only observations

The snapshot was captured at 23:36 CDT on October 25 (04:36 UTC October 26).
Statement counters were last reset on October 20 at 22:39 UTC and include the
whole interval since then. They are neither daily rates nor exact HTTP counts.
In particular, normalized statements grouped by matching identifiers may include
diagnostics or multiple statement shapes.

| Statement group | Cumulative calls | Mean execution time |
| --- | --- | --- |
| `games_get_usage` | 3,943 | 101 ms |
| `chat_get_analytics` | 141 | 2,108 ms |
| `admin_dashboard_get_state` | 47 | 2,951 ms |
| `chat_record_activity` | 8,054 | 75 ms |
| `chat_list_conversations` | 6,820 | 89 ms |

Postgres reports about 120 MB for `pg_database_size`; that definition and capture
time differ from the screenshot's 135 MB billing meter. The largest application
relations, including their indexes, are messages (~39 MB), message facts
(~29.5 MB), and DM messages (~10.9 MB). Restored historical rows contribute to
these sizes; lifetime insert counters are not newly sent message counts.

Storage object metadata totals roughly 542 MB. The largest buckets are public
media (238 MB), avatars/originals (171 MB), and app artifacts (104 MB). App
deployment history accounts for 208 objects / 101 MB; current/other app objects
account for 10 objects / 3.1 MB. No objects were deleted. A later retention policy
must preserve known-good rollback builds and current references before removing
anything. Avatar originals remain intentional, including animated profile images.

No public media/avatar/sticker objects currently report zero-duration cache
metadata. App HTML and private-group media have different freshness/access
requirements, so do not apply public-image cache rules to them.

Postgres connection/disconnection logs are already disabled, statement logging
is `ddl`, slow-statement logging is disabled, and `pgaudit.log` is `none`. There
is no evidence here for changing server log settings. The performance advisor's
unindexed foreign keys are in legacy/poker tables and `private.noelle_ai_config`;
do not add indexes simply to
clear informational warnings or drop indexes to save space without query plans.

The existing [security notes](../Backend/SECURITY.md) describe the authenticated
definer-function and leaked-password-protection advisories. This work preserves
authorization and does not treat those existing advisories as newly introduced.

AI and Movies still refer to the legacy project in their existing integration
code. Drive file data uses R2. Their traffic cannot be assumed to belong to the
current project's screenshot, and changing their integration is separate work.

## Measure without a new log scan

Run [the read-only usage snapshot SQL](../Backend/diagnostics/usage-snapshot.sql)
once before publication and once after a representative interval. Save both
results with timestamps and statement reset markers. Compare call deltas only
when reset markers match; divide by elapsed time and consider active users,
weekday, and message volume before claiming savings. A negative delta can also
mean statement eviction; do not interpret it as negative traffic.

Record the organization usage meters with the same project and billing window.
Database counters cannot reconstruct billable egress, ingestion bytes, or GB of
logs scanned. Closing a refresh loop changes future growth, not accumulated
monthly totals. The expected recurring request reductions in the PR are
controlled request-count results, not measured billing savings.

App publication follows [the existing deployment workflow](deployment.md).
The October 25 Chat release documented an HTTP 402 from the GitHub Storage
connection; do not assume that connection is repaired. Run one credentialed
dry run and verify delivered bytes before calling publication successful.
Backend SQL migrations are a separate step from HTML publication.

The analytics backend was applied to Liminal on October 25 at 23:54 CDT
(October 26 04:54 UTC), recorded by Supabase as
`20261026045434_optimize_chat_analytics_summary`. The repository migration was
renamed from its preparation timestamp `20261026043647` to that applied version;
the SQL bytes are unchanged. Its source SHA-256 is recorded in the
[deployment evidence](supabase-analytics-deployment-2026-10-25.json).

Live verification confirms all 31 summary fields match the previous SELECT
within one statement/snapshot, function security properties and wrapper hashes
are preserved, staff access works, and member/banned/anonymous access is denied.
The index is valid and ready (458,752 bytes). One post-deployment summary call
took 157 ms; the visible count used the index-only plan in 31 ms, with 7,296 heap
visibility checks on recently modified pages. These are single observations,
not sustained billing savings. Advisor warning groups/counts are unchanged.

The two-second index lock timeout did not trigger. No records, grants, or
rollback artifacts were removed. Admin/Games HTML delivery remains a separate
publication check and was not inspected during this backend rollout.

## Verification for this PR

All 239 tests pass, including request-count/concurrency/retry tests, control-token
renewal races, exact analytics JSON/permission comparisons, index-plan checks,
and the existing database authorization suite. All eight app artifacts validate;
`git diff --check` passes. The exact read-only diagnostic SQL also ran
successfully on the connected project without a log scan.

Admin/Games deployment dry runs produced `offline-plan` because no deployment
credentials are bound in this environment. They validate local artifact plans
only and do not verify Storage access or publish either app.
