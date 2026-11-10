-- Chat 6.1: remove chat analytics.
--
-- Every message insert ran an analytics trigger (a profile lookup, a forum
-- lookup and a write to private.chat_message_facts with three indexes), every
-- open Chat sent chat_record_activity once a minute, and every Control refresh
-- recomputed a 30-day summary. The owner asked for analytics to be removed.
--
-- This drops the analytics triggers, functions, private fact tables and the
-- analytics-only index. It does NOT touch messages, DMs, profiles, permissions,
-- RLS, the browser/device moderation registry (public.chat_devices, still
-- refreshed by chat_register_device at each sign-in), media, or deployment
-- history. The dropped analytics facts cannot be recovered after this runs.
--
-- Apply through the existing migration process. HTML publication does not run it.
-- Two-second lock timeout: fails rather than queueing behind live traffic.
BEGIN;
SET LOCAL lock_timeout = '2s';

-- 1. Stop the per-insert work first.
DROP TRIGGER IF EXISTS chat_analytics_message_insert ON public.messages;
DROP TRIGGER IF EXISTS chat_analytics_dm_insert ON public.dm_messages;
DROP TRIGGER IF EXISTS chat_analytics_signup_insert ON public.profiles;

-- 2. Control keeps its state RPC, without analytics. Same signature, owner,
--    SECURITY DEFINER, empty search_path and token check; CREATE OR REPLACE
--    keeps its EXECUTE grants. The analytics key and message-volume fields are
--    gone; the remaining stats come straight from profiles/channels/devices.
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
begin
  v_actor := private.require_chat_admin(p_admin_token);
  select p.staff_role in ('owner','preston') into v_actor_owner
  from public.profiles p
  where p.username = v_actor;

  select coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb)
  into v_settings
  from public.app_settings s;

  with humans as materialized (
    select * from public.profiles
    where not coalesce(is_test_account,false) and lower(username) <> 'luna'
  )
  select jsonb_build_object(
    'users_total', (select count(*) from humans),
    'members_total', (select count(*) from humans where not is_banned),
    'staff_total', (select count(*) from humans where not is_banned and private.chat_staff_rank(staff_role) >= 2),
    'banned_total', (select count(*) from public.profiles where is_banned),
    'timed_out_total', (select count(*) from public.profiles where timeout_until > now()),
    'devices_total', (select count(distinct device_id) from public.chat_devices),
    'devices_seen_7d', (select count(distinct device_id) from public.chat_devices where last_seen_at >= now() - interval '7 days'),
    'channels_total', (select count(*) from public.channels where kind in ('chat','forum')),
    'active_dashboard_sessions', (select count(distinct s.username)
      from private.chat_admin_sessions s join public.profiles p on p.username = s.username
      where s.expires_at > now() and s.last_seen_at > now() - interval '5 minutes'
        and not p.is_banned and private.chat_staff_rank(p.staff_role) >= 4)
  ) into v_stats;

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
      'last_device_seen', (select max(d.last_seen_at) from public.chat_devices d where d.username = p.username)
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
      'created_at', c.created_at
    ) order by c.position, lower(c.label)
  ), '[]'::jsonb)
  into v_channels
  from public.channels c;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at desc), '[]'::jsonb)
  into v_messages
  from (
    select id, channel_id, sender, left(content, 500) as content, type,
           media_url, deleted, edited, created_at
    from public.messages where (not owner_preview or v_actor_owner)
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
    'stats', v_stats,
    'users', v_users,
    'channels', v_channels,
    'recent_messages', v_messages,
    'deployments', v_deployments,
    'audit', v_audit
  );
end;
$function$;

-- 3. Analytics RPCs and their private implementations. Old Chat clients that
--    still call chat_record_activity get PostgREST's "function not found"
--    without reaching Postgres, back off to 5 minutes, and stop on reload.
DROP FUNCTION IF EXISTS public.chat_get_analytics();
DROP FUNCTION IF EXISTS private.chat_get_analytics();
DROP FUNCTION IF EXISTS private.chat_analytics_summary();
DROP FUNCTION IF EXISTS public.chat_record_activity(text);
DROP FUNCTION IF EXISTS private.chat_record_activity(text);
DROP FUNCTION IF EXISTS private.chat_capture_message_fact();
DROP FUNCTION IF EXISTS private.chat_capture_signup_fact();

-- 4. Analytics-only storage. Each insert into messages also maintained this
--    partial index, which only the analytics summary used.
DROP TABLE IF EXISTS private.chat_message_facts;
DROP TABLE IF EXISTS private.chat_activity_days;
DROP TABLE IF EXISTS private.chat_signup_facts;
DROP TABLE IF EXISTS private.chat_analytics_meta;
DROP INDEX IF EXISTS public.messages_analytics_visible_sender_idx;

COMMIT;

NOTIFY pgrst, 'reload schema';
