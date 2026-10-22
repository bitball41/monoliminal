-- Preserve all existing authorization predicates and roles. Only request-constant
-- identity checks are moved into InitPlans; row-dependent membership checks remain.
SET lock_timeout = '2s';

DO $policy$
DECLARE p record; v_qual text; v_check text; v_fn text; v_sql text;
BEGIN
  FOR p IN SELECT * FROM pg_policies WHERE schemaname='public'
    AND tablename IN ('messages','dm_messages','dms','dm_reads','profiles','forum_threads','follows')
  LOOP
    v_qual := p.qual;
    v_check := p.with_check;
    FOREACH v_fn IN ARRAY ARRAY['private.chat_username()','private.chat_is_staff(false)','auth.uid()']
    LOOP
      -- The functions have no row inputs. Evaluate each once per statement.
      -- Keep already wrapped expressions intact on a repeated maintenance run.
      IF position('SELECT '||v_fn IN coalesce(v_qual,''))=0 THEN
        v_qual := replace(v_qual,v_fn,'(SELECT '||v_fn||')');
      END IF;
      IF position('SELECT '||v_fn IN coalesce(v_check,''))=0 THEN
        v_check := replace(v_check,v_fn,'(SELECT '||v_fn||')');
      END IF;
    END LOOP;
    IF v_qual IS DISTINCT FROM p.qual OR v_check IS DISTINCT FROM p.with_check THEN
      v_sql := format('ALTER POLICY %I ON %I.%I',p.policyname,p.schemaname,p.tablename);
      IF v_qual IS NOT NULL THEN v_sql := v_sql||' USING ('||v_qual||')'; END IF;
      IF v_check IS NOT NULL THEN v_sql := v_sql||' WITH CHECK ('||v_check||')'; END IF;
      EXECUTE v_sql;
    END IF;
  END LOOP;
END $policy$;

-- Inbox readers also reuse the authenticated identity across conversation rows.
CREATE OR REPLACE FUNCTION public.chat_list_conversations()
 RETURNS TABLE(id uuid, participants text[], created_at timestamp with time zone, title text, is_group boolean, group_owner text, last_id uuid, last_sender text, last_content text, last_type text, last_created_at timestamp with time zone, last_deleted boolean, last_read_by text[], my_last_read_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
SELECT d.id,d.participants,d.created_at,d.title,d.is_group,d.group_owner,m.id,m.sender,m.content,m.type,m.created_at,coalesce(m.deleted,false),coalesce(m.read_by,ARRAY[]::text[]),r.last_read_at
FROM public.dms d LEFT JOIN LATERAL (SELECT mm.* FROM public.dm_messages mm WHERE mm.dm_id=d.id ORDER BY mm.created_at DESC,mm.id DESC LIMIT 1) m ON true
LEFT JOIN public.dm_reads r ON r.dm_id=d.id AND r.username=(SELECT private.chat_username())
WHERE (SELECT private.chat_username())=ANY(d.participants);
$function$;

CREATE OR REPLACE FUNCTION public.chat_list_group_invites()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
SELECT coalesce(jsonb_agg(jsonb_build_object('group_id',i.group_id,'title',d.title,'invited_by',i.invited_by,'member_count',cardinality(d.participants),'created_at',i.created_at) ORDER BY i.created_at DESC),'[]'::jsonb)
FROM public.chat_group_invites i JOIN public.dms d ON d.id=i.group_id
WHERE i.invitee=(SELECT private.chat_username()) AND d.is_group AND cardinality(d.participants)>0;
$function$;

-- Aggregate durable totals once and let time-filtered reads use their indexes.
-- Avoid materializing the complete message ledger or sorting every actor key.
CREATE OR REPLACE FUNCTION private.chat_analytics_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  d date := (now() AT TIME ZONE 'America/Chicago')::date;
  result jsonb;
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
      count(*) FILTER (WHERE scope='channel' AND sent_at>=now()-interval '24 hours') AS messages_24h,
      count(*) FILTER (WHERE scope='channel' AND sent_at>=now()-interval '48 hours' AND sent_at<now()-interval '24 hours') AS messages_previous_24h,
      count(*) FILTER (WHERE scope='channel' AND sent_at>=now()-interval '7 days') AS messages_7d,
      count(*) FILTER (WHERE scope='dm') AS dm_messages_total,
      count(*) FILTER (WHERE scope='dm' AND sent_at>=now()-interval '24 hours') AS dm_messages_24h
    FROM facts
  ), days AS (SELECT d-i AS day FROM generate_series(0,29) i),
  ad AS (SELECT day,count(DISTINCT user_id) accounts,count(DISTINCT device_id) browsers
    FROM activity GROUP BY day),
  md AS (SELECT (sent_at AT TIME ZONE 'America/Chicago')::date AS day,
    count(*) FILTER (WHERE scope='channel') messages,count(*) FILTER (WHERE scope='dm') dms
    FROM facts WHERE sent_at >= ((d-29)::timestamp AT TIME ZONE 'America/Chicago') GROUP BY 1),
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
    'active_senders_7d',(SELECT count(*) FROM (SELECT DISTINCT actor_key FROM facts WHERE scope='channel' AND sent_at>=now()-interval '7 days') senders),
    'dm_messages_total',(SELECT dm_messages_total FROM fact_totals),
    'dm_messages_24h',(SELECT dm_messages_24h FROM fact_totals),
    'visible_messages',(SELECT count(*) FROM public.messages m LEFT JOIN public.profiles p ON p.username=m.sender
      WHERE NOT m.owner_preview AND NOT coalesce(m.deleted,false) AND NOT coalesce(p.is_test_account,false)
      AND lower(m.sender) NOT IN ('luna', 'noelleai') AND coalesce(m.type,'')<>'system'),
    'devices_total',(SELECT count(DISTINCT device_id) FROM public.chat_devices),
    'devices_seen_7d',(SELECT count(DISTINCT device_id) FROM public.chat_devices WHERE last_seen_at>=now()-interval '7 days'),
    'channels_total',(SELECT count(*) FROM public.channels WHERE kind IN ('chat','forum')),
    'signups_7d',(SELECT count(*) FROM private.chat_signup_facts WHERE NOT excluded AND signed_up_at>=now()-interval '7 days'),
    'daily',(SELECT jsonb_agg(jsonb_build_object('day',days.day,
      'accounts',CASE WHEN days.day >= ((SELECT activity_since FROM private.chat_analytics_meta) AT TIME ZONE 'America/Chicago')::date THEN coalesce(ad.accounts,0) END,
      'browsers',CASE WHEN days.day >= ((SELECT activity_since FROM private.chat_analytics_meta) AT TIME ZONE 'America/Chicago')::date THEN coalesce(ad.browsers,0) END,
      'messages',coalesce(md.messages,0),'dms',coalesce(md.dms,0),'signups',coalesce(sd.signups,0)) ORDER BY days.day)
      FROM days LEFT JOIN ad USING(day) LEFT JOIN md USING(day) LEFT JOIN sd USING(day)),
    'top_channels',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.messages DESC,t.channel_id),'[]'::jsonb)
      FROM (SELECT f.channel_id,coalesce(c.label,'Forum / removed channel') label,count(*) messages,
        count(DISTINCT f.actor_key) senders FROM facts f LEFT JOIN public.channels c ON c.id=f.channel_id
        WHERE f.scope='channel' AND f.sent_at>=now()-interval '7 days'
        GROUP BY f.channel_id,c.label ORDER BY count(*) DESC,f.channel_id LIMIT 8) t)
  ) INTO result;
  RETURN result;
END;
$function$;

-- Exact unread counts use deleted=false, unlike the older coalesce-based index.
CREATE INDEX IF NOT EXISTS messages_unread_channel_created_idx
  ON public.messages(channel_id,created_at DESC) INCLUDE(sender,owner_preview)
  WHERE deleted=false;

NOTIFY pgrst, 'reload schema';
