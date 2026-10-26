-- Preserve the exact analytics output and existing private/staff-only boundary.
-- Historical facts remain immutable; no content, counts, or caches are stored.
SET lock_timeout = '2s';

-- Count eligible public messages from a compact sender-only index. The predicate
-- exactly matches the existing analytics definition; test-account exclusions stay
-- in the profile join, so profile changes still take effect immediately.
CREATE INDEX IF NOT EXISTS messages_analytics_visible_sender_idx ON public.messages(sender)
  WHERE NOT owner_preview AND NOT coalesce(deleted,false)
    AND lower(sender) NOT IN ('luna','noelleai') AND coalesce(type,'')<>'system';

CREATE OR REPLACE FUNCTION private.chat_analytics_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  d date := (now() AT TIME ZONE 'America/Chicago')::date;
  result jsonb;
  -- Compute rolling bounds once per call instead of for every fact/filter.
  cutoff_24h timestamptz := now()-interval '24 hours';
  cutoff_48h timestamptz := now()-interval '48 hours';
  cutoff_7d timestamptz := now()-interval '7 days';
  cutoff_30d timestamptz := ((d-29)::timestamp AT TIME ZONE 'America/Chicago');
BEGIN
  -- Called only by the authenticated staff RPC or the validated dashboard state.
  WITH humans AS MATERIALIZED (
    SELECT * FROM public.profiles WHERE NOT coalesce(is_test_account,false) AND lower(username)<>'luna'
  ), facts AS NOT MATERIALIZED (
    SELECT scope,actor_key,channel_id,sent_at FROM private.chat_message_facts WHERE NOT excluded
  ), activity AS MATERIALIZED (
    SELECT * FROM private.chat_activity_days WHERE day >= d-29
  ), fact_totals AS MATERIALIZED (
    SELECT count(*) FILTER (WHERE scope='channel') AS messages_total,
      count(*) FILTER (WHERE scope='channel' AND sent_at>=cutoff_24h) AS messages_24h,
      count(*) FILTER (WHERE scope='channel' AND sent_at>=cutoff_48h AND sent_at<cutoff_24h) AS messages_previous_24h,
      count(*) FILTER (WHERE scope='channel' AND sent_at>=cutoff_7d) AS messages_7d,
      count(*) FILTER (WHERE scope='dm') AS dm_messages_total,
      count(*) FILTER (WHERE scope='dm' AND sent_at>=cutoff_24h) AS dm_messages_24h
    FROM facts
  ), days AS (SELECT d-i AS day FROM generate_series(0,29) i),
  ad AS (SELECT day,count(DISTINCT user_id) accounts,count(DISTINCT device_id) browsers
    FROM activity GROUP BY day),
  md AS (SELECT (sent_at AT TIME ZONE 'America/Chicago')::date AS day,
    count(*) FILTER (WHERE scope='channel') messages,count(*) FILTER (WHERE scope='dm') dms
    FROM facts WHERE sent_at >= cutoff_30d GROUP BY 1),
  sd AS (SELECT (signed_up_at AT TIME ZONE 'America/Chicago')::date AS day,count(*) signups
    FROM private.chat_signup_facts WHERE NOT excluded GROUP BY 1)
  SELECT jsonb_build_object(
    'generated_at',now(),'timezone','America/Chicago',
    'activity_since',(SELECT activity_since FROM private.chat_analytics_meta),
    'durable_messages_since',(SELECT durable_messages_since FROM private.chat_analytics_meta),
    'accounts_total',(SELECT count(*) FROM humans),
    'members_total',(SELECT count(*) FROM humans WHERE NOT is_banned),
    'staff_total',(SELECT count(*) FROM humans WHERE NOT is_banned AND private.chat_staff_rank(staff_role)>=2),
    'banned_total',(SELECT count(*) FROM public.profiles WHERE is_banned),
    'timed_out_total',(SELECT count(*) FROM public.profiles WHERE timeout_until>now()),
    'dau',(SELECT count(DISTINCT user_id) FROM activity WHERE day=d),
    'wau',(SELECT count(DISTINCT user_id) FROM activity WHERE day>=d-6),
    'mau',(SELECT count(DISTINCT user_id) FROM activity),
    'browsers_today',(SELECT count(DISTINCT device_id) FROM activity WHERE day=d),
    'browsers_7d',(SELECT count(DISTINCT device_id) FROM activity WHERE day>=d-6),
    'browsers_30d',(SELECT count(DISTINCT device_id) FROM activity),
    'foreground_5m',(SELECT count(DISTINCT user_id) FROM activity WHERE last_seen_at>now()-interval '5 minutes'),
    'returning_today',(SELECT count(DISTINCT a.user_id) FROM activity a WHERE a.day=d
      AND EXISTS(SELECT 1 FROM private.chat_activity_days prev WHERE prev.user_id=a.user_id AND prev.day<d)),
    'messages_total',(SELECT messages_total FROM fact_totals),
    'messages_24h',(SELECT messages_24h FROM fact_totals),
    'messages_previous_24h',(SELECT messages_previous_24h FROM fact_totals),
    'messages_7d',(SELECT messages_7d FROM fact_totals),
    'active_senders_7d',(SELECT count(*) FROM (SELECT DISTINCT actor_key FROM facts WHERE scope='channel' AND sent_at>=cutoff_7d) senders),
    'dm_messages_total',(SELECT dm_messages_total FROM fact_totals),
    'dm_messages_24h',(SELECT dm_messages_24h FROM fact_totals),
    'visible_messages',(SELECT count(*) FROM public.messages m LEFT JOIN public.profiles p ON p.username=m.sender
      WHERE NOT m.owner_preview AND NOT coalesce(m.deleted,false) AND NOT coalesce(p.is_test_account,false)
      AND lower(m.sender) NOT IN ('luna', 'noelleai') AND coalesce(m.type,'')<>'system'),
    'devices_total',(SELECT count(DISTINCT device_id) FROM public.chat_devices),
    'devices_seen_7d',(SELECT count(DISTINCT device_id) FROM public.chat_devices WHERE last_seen_at>=cutoff_7d),
    'channels_total',(SELECT count(*) FROM public.channels WHERE kind IN ('chat','forum')),
    'signups_7d',(SELECT count(*) FROM private.chat_signup_facts WHERE NOT excluded AND signed_up_at>=cutoff_7d),
    'daily',(SELECT jsonb_agg(jsonb_build_object('day',days.day,
      'accounts',CASE WHEN days.day >= ((SELECT activity_since FROM private.chat_analytics_meta) AT TIME ZONE 'America/Chicago')::date THEN coalesce(ad.accounts,0) END,
      'browsers',CASE WHEN days.day >= ((SELECT activity_since FROM private.chat_analytics_meta) AT TIME ZONE 'America/Chicago')::date THEN coalesce(ad.browsers,0) END,
      'messages',coalesce(md.messages,0),'dms',coalesce(md.dms,0),'signups',coalesce(sd.signups,0)) ORDER BY days.day)
      FROM days LEFT JOIN ad USING(day) LEFT JOIN md USING(day) LEFT JOIN sd USING(day)),
    'top_channels',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.messages DESC,t.channel_id),'[]'::jsonb)
      FROM (SELECT f.channel_id,coalesce(c.label,'Forum / removed channel') label,count(*) messages,
        count(DISTINCT f.actor_key) senders FROM facts f LEFT JOIN public.channels c ON c.id=f.channel_id
        WHERE f.scope='channel' AND f.sent_at>=cutoff_7d
        GROUP BY f.channel_id,c.label ORDER BY count(*) DESC,f.channel_id LIMIT 8) t)
  ) INTO result;
  RETURN result;
END;
$function$;

-- CREATE OR REPLACE preserves existing ownership and EXECUTE grants.
NOTIFY pgrst, 'reload schema';
