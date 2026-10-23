-- Operational cleanup applied on 2026-10-23. This resets performance counters
-- for completed October 20 migration batches, not the records they restored.
-- Restrict the target to this database, the known restore prefix and old entries.
-- DO bodies retain large literal payloads in pg_stat_statements; monitoring
-- repeatedly materializes these texts even when requesting numeric totals.
-- Aggregate measurements are recorded in docs/shared-backend-stalls-2026-10-23.md.
BEGIN;
SET LOCAL work_mem = '64MB';
DO $cleanup$
DECLARE
  entry record;
BEGIN
  FOR entry IN
    SELECT userid, dbid, queryid
    FROM extensions.pg_stat_statements
    WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND stats_since < '2026-10-21T00:00:00Z'::timestamptz
      AND query LIKE 'DO $restore_%'
  LOOP
    PERFORM extensions.pg_stat_statements_reset(entry.userid, entry.dbid, entry.queryid, false);
  END LOOP;
END
$cleanup$;
COMMIT;
