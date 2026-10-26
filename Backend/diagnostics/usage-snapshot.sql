-- Read only: database counters, not Supabase diagnostic-log scans.
-- Execute via the authenticated SQL editor/MCP connection. Save the JSON result.
-- Compare deltas only with matching reset markers and a comparable workload.
-- No row contents, filenames, credentials, or user identifiers are returned.
SELECT jsonb_build_object(
  'captured_at', now(),
  'database_bytes', pg_database_size(current_database()),
  'database_stats_reset', (SELECT stats_reset FROM pg_stat_database WHERE datname=current_database()),
  'statement_stats_reset', (SELECT stats_reset FROM extensions.pg_stat_statements_info),
  'statement_groups', (
    SELECT jsonb_agg(s ORDER BY s.total_exec_ms DESC) FROM (
      SELECT (regexp_match(query, '(chat_[a-z_]+|admin_dashboard_[a-z_]+|games_[a-z_]+)'))[1] AS identifier,
        sum(calls)::bigint AS calls,
        round(sum(total_exec_time)::numeric,1) AS total_exec_ms,
        round((sum(total_exec_time)/nullif(sum(calls),0))::numeric,2) AS mean_exec_ms
      FROM extensions.pg_stat_statements
      WHERE query ~ '(chat_[a-z_]+|admin_dashboard_[a-z_]+|games_[a-z_]+)'
        AND query ~* '^\s*(select|with)'
        -- This diagnostic contains its own identifier pattern. Exclude it.
        AND query NOT ILIKE '%pg_stat_statements%'
      GROUP BY 1
    ) s
  ),
  'tables', (
    SELECT jsonb_agg(t ORDER BY t.total_bytes DESC) FROM (
      SELECT schemaname, relname, n_live_tup, n_tup_ins, n_tup_upd, n_tup_del,
        seq_scan, seq_tup_read, idx_scan, pg_total_relation_size(relid) AS total_bytes
      FROM pg_stat_user_tables
      WHERE schemaname IN ('public','private','legacy')
      ORDER BY pg_total_relation_size(relid) DESC LIMIT 20
    ) t
  ),
  'storage', (
    SELECT jsonb_agg(b ORDER BY b.bytes DESC) FROM (
      SELECT bucket_id, count(*) AS objects,
        coalesce(sum((metadata->>'size')::bigint),0) AS bytes
      FROM storage.objects GROUP BY bucket_id
    ) b
  )
) AS usage_snapshot;
