BEGIN;

-- All analytics storage is private. RPCs authenticate identity/role on the server;
-- clients cannot submit usernames, timestamps, counts, or message bodies.
CREATE TABLE private.chat_analytics_meta (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  activity_since timestamptz NOT NULL DEFAULT now(),
  durable_messages_since timestamptz NOT NULL DEFAULT now()
);
INSERT INTO private.chat_analytics_meta DEFAULT VALUES;
CREATE TABLE private.chat_activity_days (
  day date NOT NULL,
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (day, user_id, device_id)
);
CREATE INDEX chat_activity_user_day ON private.chat_activity_days (user_id, day);
CREATE INDEX chat_activity_recent ON private.chat_activity_days (last_seen_at DESC);

-- Metadata only: no text, attachment URL, DM ID, or group membership is copied.
-- No cascading FK: removing content/accounts must not rewrite historical totals.
CREATE TABLE private.chat_message_facts (
  scope text NOT NULL CHECK (scope IN ('channel','dm')),
  message_id uuid NOT NULL,
  actor_key text NOT NULL,
  channel_id text,
  kind text NOT NULL,
  sent_at timestamptz NOT NULL,
  excluded boolean NOT NULL,
  PRIMARY KEY (scope, message_id)
);
CREATE INDEX chat_message_facts_sent ON private.chat_message_facts (sent_at DESC) WHERE NOT excluded;
CREATE INDEX chat_message_facts_actor ON private.chat_message_facts (actor_key,sent_at DESC)
  WHERE NOT excluded AND scope='channel';
CREATE INDEX chat_message_facts_channel ON private.chat_message_facts (channel_id,sent_at DESC)
  WHERE NOT excluded AND scope='channel';
CREATE TABLE private.chat_signup_facts (
  user_id uuid PRIMARY KEY,
  signed_up_at timestamptz NOT NULL,
  excluded boolean NOT NULL
);
ALTER TABLE private.chat_analytics_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.chat_activity_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.chat_message_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.chat_signup_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.chat_analytics_meta, private.chat_activity_days,
  private.chat_message_facts, private.chat_signup_facts FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.chat_capture_message_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.profiles%rowtype;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE username = NEW.sender;
  INSERT INTO private.chat_message_facts(scope,message_id,actor_key,channel_id,kind,sent_at,excluded)
  VALUES (CASE WHEN TG_TABLE_NAME = 'messages' THEN 'channel' ELSE 'dm' END,
    NEW.id, coalesce(p.user_id::text, 'legacy:' || lower(NEW.sender)),
    CASE WHEN TG_TABLE_NAME = 'messages' THEN coalesce((
      SELECT ft.channel_id FROM public.forum_threads ft
      WHERE 'forum:'||ft.id::text=to_jsonb(NEW)->>'channel_id'
    ),to_jsonb(NEW)->>'channel_id') END,
    coalesce(NEW.type,'text'), now(),
    coalesce(p.is_test_account,false) OR lower(NEW.sender) = 'luna' OR coalesce(NEW.type,'') = 'system')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE FUNCTION private.chat_capture_signup_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    INSERT INTO private.chat_signup_facts VALUES
      (NEW.user_id,now(),coalesce(NEW.is_test_account,false) OR lower(NEW.username)='luna')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_analytics_message_insert AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION private.chat_capture_message_fact();
CREATE TRIGGER chat_analytics_dm_insert AFTER INSERT ON public.dm_messages
  FOR EACH ROW EXECUTE FUNCTION private.chat_capture_message_fact();
CREATE TRIGGER chat_analytics_signup_insert AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.chat_capture_signup_fact();

-- Backfill only surviving rows. Earlier hard-deleted history cannot be recovered.
INSERT INTO private.chat_message_facts
SELECT 'channel',m.id,coalesce(p.user_id::text,'legacy:'||lower(m.sender)),coalesce(ft.channel_id,m.channel_id),
  coalesce(m.type,'text'),m.created_at,
  coalesce(p.is_test_account,false) OR lower(m.sender)='luna' OR coalesce(m.type,'')='system'
FROM public.messages m LEFT JOIN public.profiles p ON p.username=m.sender
LEFT JOIN public.forum_threads ft ON 'forum:'||ft.id::text=m.channel_id
WHERE m.created_at IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO private.chat_message_facts
SELECT 'dm',m.id,coalesce(p.user_id::text,'legacy:'||lower(m.sender)),NULL,
  coalesce(m.type,'text'),m.created_at,
  coalesce(p.is_test_account,false) OR lower(m.sender)='luna' OR coalesce(m.type,'')='system'
FROM public.dm_messages m LEFT JOIN public.profiles p ON p.username=m.sender
WHERE m.created_at IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO private.chat_signup_facts
SELECT user_id,created_at,coalesce(is_test_account,false) OR lower(username)='luna'
FROM public.profiles WHERE user_id IS NOT NULL AND created_at IS NOT NULL ON CONFLICT DO NOTHING;

CREATE FUNCTION private.chat_record_activity(p_device_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_username text := private.chat_username();
  v_now timestamptz := now();
BEGIN
  IF v_user IS NULL OR v_username IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_device_id IS NULL OR char_length(p_device_id) NOT BETWEEN 16 AND 200 THEN
    RAISE EXCEPTION 'Invalid browser identifier';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_devices WHERE username=v_username AND device_id=p_device_id) THEN
    RAISE EXCEPTION 'Register this browser first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE user_id=v_user
      AND (is_test_account OR lower(username)='luna')) THEN RETURN false; END IF;
  INSERT INTO private.chat_activity_days AS a(day,user_id,device_id,first_seen_at,last_seen_at)
  VALUES ((v_now AT TIME ZONE 'America/Chicago')::date,v_user,p_device_id,v_now,v_now)
  ON CONFLICT (day,user_id,device_id) DO UPDATE SET last_seen_at=excluded.last_seen_at
  WHERE a.last_seen_at <= v_now - interval '60 seconds';
  -- The moderation registry remains fresh without a second client write.
  UPDATE public.chat_devices SET last_seen_at=v_now
  WHERE username=v_username AND device_id=p_device_id AND last_seen_at < v_now - interval '60 seconds';
  RETURN true;
END;
$$;
CREATE FUNCTION public.chat_record_activity(p_device_id text) RETURNS boolean
-- Narrow bridge avoids granting callers USAGE on the legacy private schema.
-- The private implementation validates auth.uid() before any write.
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.chat_record_activity(p_device_id)
$$;

CREATE FUNCTION private.chat_analytics_summary() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d date := (now() AT TIME ZONE 'America/Chicago')::date;
  result jsonb;
BEGIN
  -- Called only by the authenticated staff RPC or the validated dashboard state.
  WITH humans AS MATERIALIZED (
    SELECT * FROM public.profiles WHERE NOT coalesce(is_test_account,false) AND lower(username)<>'luna'
  ), facts AS MATERIALIZED (
    SELECT * FROM private.chat_message_facts WHERE NOT excluded
  ), activity AS MATERIALIZED (
    SELECT * FROM private.chat_activity_days WHERE day >= d-29
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
    'messages_total',(SELECT count(*) FROM facts WHERE scope='channel'),
    'messages_24h',(SELECT count(*) FROM facts WHERE scope='channel' AND sent_at>=now()-interval '24 hours'),
    'messages_previous_24h',(SELECT count(*) FROM facts WHERE scope='channel'
      AND sent_at>=now()-interval '48 hours' AND sent_at<now()-interval '24 hours'),
    'messages_7d',(SELECT count(*) FROM facts WHERE scope='channel' AND sent_at>=now()-interval '7 days'),
    'active_senders_7d',(SELECT count(DISTINCT actor_key) FROM facts WHERE scope='channel' AND sent_at>=now()-interval '7 days'),
    'dm_messages_total',(SELECT count(*) FROM facts WHERE scope='dm'),
    'dm_messages_24h',(SELECT count(*) FROM facts WHERE scope='dm' AND sent_at>=now()-interval '24 hours'),
    'visible_messages',(SELECT count(*) FROM public.messages m LEFT JOIN public.profiles p ON p.username=m.sender
      WHERE NOT coalesce(m.deleted,false) AND NOT coalesce(p.is_test_account,false)
      AND lower(m.sender)<>'luna' AND coalesce(m.type,'')<>'system'),
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
$$;
CREATE FUNCTION private.chat_get_analytics() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT private.chat_is_staff(false) THEN RAISE EXCEPTION 'Staff access required'; END IF;
  RETURN private.chat_analytics_summary();
END;
$$;
CREATE FUNCTION public.chat_get_analytics() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.chat_get_analytics()
$$;
REVOKE ALL ON FUNCTION private.chat_capture_message_fact(), private.chat_capture_signup_fact(),
  private.chat_record_activity(text), private.chat_analytics_summary(),private.chat_get_analytics(),
  public.chat_record_activity(text),public.chat_get_analytics() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.chat_record_activity(text),public.chat_get_analytics() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_dashboard_get_state(p_admin_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor text;
  v_actor_owner boolean;
  v_settings jsonb;
  v_stats jsonb;
  v_users jsonb;
  v_channels jsonb;
  v_messages jsonb;
  v_deployments jsonb;
  v_audit jsonb;
  v_analytics jsonb;
begin
  v_actor := private.require_chat_admin(p_admin_token);
  select p.staff_role in ('owner','preston') into v_actor_owner
  from public.profiles p
  where p.username = v_actor;

  select coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb)
  into v_settings
  from public.app_settings s;

  v_analytics := private.chat_analytics_summary();
  v_stats := (v_analytics - 'daily' - 'top_channels') || jsonb_build_object(
    'users_total',v_analytics->'accounts_total',
    'active_dashboard_sessions',(select count(distinct s.username)
      from private.chat_admin_sessions s join public.profiles p on p.username=s.username
      where s.expires_at>now() and s.last_seen_at>now()-interval '5 minutes'
        and not p.is_banned and private.chat_staff_rank(p.staff_role)>=4)
  );

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'username', p.username,
      'display_name', p.display_name,
      'is_admin', p.is_admin,
      'is_owner', p.is_owner,
      'is_banned', p.is_banned,
      'ban_reason', p.ban_reason,
      'banned_by', p.banned_by,
      'timeout_until', p.timeout_until,
      'timeout_by', p.timeout_by,
      'kicked_at', p.kicked_at,
      'is_test_account', p.is_test_account,
      'created_at', p.created_at,
      'device_count', (select count(distinct d.device_id) from public.chat_devices d where d.username = p.username),
      'last_device_seen', (select max(d.last_seen_at) from public.chat_devices d where d.username = p.username),
      'message_count', (select count(*) from private.chat_message_facts m where m.scope='channel' and not m.excluded and m.actor_key=coalesce(p.user_id::text,'legacy:'||lower(p.username))),
      'last_message_at', (select max(m.sent_at) from private.chat_message_facts m where m.scope='channel' and not m.excluded and m.actor_key=coalesce(p.user_id::text,'legacy:'||lower(p.username)))
    ) order by p.is_owner desc, p.is_admin desc, lower(p.username)
  ), '[]'::jsonb)
  into v_users
  from public.profiles p;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', c.id,
      'label', c.label,
      'icon', c.icon,
      'topic', c.topic,
      'position', c.position,
      'is_system', c.is_system,
      'created_at', c.created_at,
      'message_count', (select count(*) from private.chat_message_facts m where m.scope='channel' and not m.excluded and m.channel_id = c.id),
      'messages_24h', (
        select count(*) from private.chat_message_facts m
        where m.scope='channel' and not m.excluded and m.channel_id = c.id and m.sent_at >= now() - interval '24 hours'
      ),
      'last_message_at', (select max(m.sent_at) from private.chat_message_facts m where m.scope='channel' and not m.excluded and m.channel_id = c.id)
    ) order by c.position, lower(c.label)
  ), '[]'::jsonb)
  into v_channels
  from public.channels c;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at desc), '[]'::jsonb)
  into v_messages
  from (
    select id, channel_id, sender, left(content, 500) as content, type,
           media_url, deleted, edited, created_at
    from public.messages
    order by created_at desc
    limit 75
  ) m;

  select coalesce(jsonb_agg(to_jsonb(d) order by d.deployed_at desc), '[]'::jsonb)
  into v_deployments
  from (
    select id, app, version, notes, storage_path, size_bytes, sha256,
           deployed_by, deployed_at, is_rollback
    from (
      select r.*, row_number() over (partition by r.app order by r.deployed_at desc) as rn
      from private.chat_deployments r
    ) ranked
    where rn <= 25
  ) d;

  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc), '[]'::jsonb)
  into v_audit
  from (
    select id, actor_username, action, target, details, created_at
    from private.chat_admin_audit
    order by created_at desc
    limit 100
  ) a;

  return jsonb_build_object(
    'actor', v_actor,
    'actor_is_owner', v_actor_owner,
    'generated_at', now(),
    'settings', v_settings,
    'analytics', v_analytics,
    'stats', v_stats,
    'users', v_users,
    'channels', v_channels,
    'recent_messages', v_messages,
    'deployments', v_deployments,
    'audit', v_audit
  );
end;
$function$;


COMMIT;
