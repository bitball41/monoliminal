-- Phoenix Chat: clear timeouts by the rank of whoever gave the timeout.
--
-- Run this once in the Phoenix Chat Supabase project (SQL Editor → New query →
-- paste → Run). NOT the Supabase plugin connected to Claude: that is a
-- different database.
--
-- Rule: staff can clear a timeout only when the person who gave it was the same
-- rank as them or lower (Owner 4 > Right Hands 3 > Operators 2 > Coordinators 1).
-- Automatic spam timeouts count as rank 0, so any staff member can clear them.
-- Timeouts given before this update have no recorded rank; they are treated as
-- owner-given (only the owner can clear them) and expire within 24 hours anyway.
--
-- Safe to run more than once.

begin;

-- 1. Remember who gave each timeout and their rank at that moment.
alter table public.app_users
  add column if not exists timeout_by_user_id uuid,
  add column if not exists timeout_by_rank smallint;

-- 2. Staff rank used by every moderation check (same numbers as timeout_user).
create schema if not exists phoenix_private;

create or replace function phoenix_private.staff_rank(p_is_owner boolean, p_role text)
returns integer
language sql
immutable
set search_path to ''
as $$
  select case when coalesce(p_is_owner,false) then 4
              when p_role='co-owner' then 3
              when p_role='admin' then 2
              when p_role='manager' then 1
              else 0 end
$$;

-- Returns null when the actor may clear the target's timeout, otherwise the reason.
create or replace function phoenix_private.timeout_clear_block(
  p_actor_id uuid, p_actor_is_owner boolean, p_actor_role text,
  p_target_id uuid, p_target_is_owner boolean, p_target_role text,
  p_timeout_until timestamptz, p_by_rank smallint, p_by_username text)
returns text
language plpgsql
stable
set search_path to ''
as $$
declare v_actor_rank integer; v_issuer_rank integer;
begin
  if p_timeout_until is null or p_timeout_until<=now() then return 'This member is not timed out.'; end if;
  if p_target_id=p_actor_id then return 'You cannot clear your own timeout.'; end if;
  if coalesce(p_target_is_owner,false) then return 'The server owner cannot be moderated.'; end if;
  if not coalesce(p_actor_is_owner,false) and coalesce(p_actor_role,'') not in ('co-owner','admin','manager') then
    return 'Your role does not have permission to clear timeouts.';
  end if;
  v_actor_rank:=phoenix_private.staff_rank(p_actor_is_owner,p_actor_role);
  if v_actor_rank<=phoenix_private.staff_rank(p_target_is_owner,p_target_role) then
    return 'You can only moderate users with a lower role than yours.';
  end if;
  v_issuer_rank:=coalesce(p_by_rank::integer, case when p_by_username='Spam protection' then 0 end, 4);
  if v_issuer_rank>v_actor_rank then
    return 'This timeout was given by someone with a higher rank than you.';
  end if;
  return null;
end;
$$;

revoke all on function phoenix_private.staff_rank(boolean,text) from public;
revoke all on function phoenix_private.timeout_clear_block(uuid,boolean,text,uuid,boolean,text,timestamptz,smallint,text) from public;
revoke all on function phoenix_private.staff_rank(boolean,text) from anon, authenticated;
revoke all on function phoenix_private.timeout_clear_block(uuid,boolean,text,uuid,boolean,text,timestamptz,smallint,text) from anon, authenticated;

-- 3. timeout_user: unchanged rules, now also records who gave the timeout.
create or replace function public.timeout_user(p_session_token text, p_user_id uuid, p_duration_seconds integer, p_reason text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_actor public.app_users%rowtype; v_target public.app_users%rowtype; v_actor_rank integer; v_target_rank integer;
begin
 if p_duration_seconds is null or p_duration_seconds<1 or p_duration_seconds>86400 then raise exception 'Timeout must be between 1 second and 24 hours.'; end if;
 select u.* into v_actor from public.sessions s join public.app_users u on u.id=s.user_id where s.token::text=p_session_token and (s.expires_at is null or s.expires_at>now()) limit 1;
 if v_actor.id is null then raise exception 'Invalid or expired session.'; end if;
 select * into v_target from public.app_users where id=p_user_id;
 if v_target.id is null then raise exception 'User not found.'; end if;
 if v_target.id=v_actor.id then raise exception 'You cannot timeout yourself.'; end if;
 if coalesce(v_target.is_owner,false) then raise exception 'The server owner cannot be timed out.'; end if;
 if not coalesce(v_actor.is_owner,false) and v_actor.role not in ('co-owner','admin','manager') then raise exception 'Your role does not have permission to timeout members.'; end if;
 v_actor_rank:=phoenix_private.staff_rank(v_actor.is_owner,v_actor.role);
 v_target_rank:=phoenix_private.staff_rank(v_target.is_owner,v_target.role);
 if v_actor_rank<=v_target_rank then raise exception 'You can only moderate users with a lower role than yours.'; end if;
 update public.app_users
   set timeout_until=now()+make_interval(secs=>p_duration_seconds),
       timeout_reason=nullif(trim(coalesce(p_reason,'')),''),
       timeout_by_username=coalesce(v_actor.display_name,v_actor.username),
       timeout_by_user_id=v_actor.id,
       timeout_by_rank=v_actor_rank
 where id=p_user_id;
end; $function$;

-- 4. Spam protection: unchanged, now records rank 0 so any staff member can clear it.
create or replace function public.phoenix_guard_message_rate_and_timeout()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_owner boolean := false;
  v_timeout_until timestamptz;
  v_recent_count integer := 0;
begin
  if new.user_id is null or lower(coalesce(new.role, '')) in ('ai', 'system', 'owner-ai') then
    return new;
  end if;

  select coalesce(u.is_owner, false), u.timeout_until
    into v_is_owner, v_timeout_until
  from public.app_users u
  where u.id = new.user_id
  for update;

  if not found or v_is_owner then
    return new;
  end if;

  if v_timeout_until is not null and v_timeout_until > now() then
    raise exception 'You are timed out until %', v_timeout_until;
  end if;

  select count(*)::integer into v_recent_count
  from public.messages m
  where m.user_id = new.user_id
    and m.created_at >= now() - interval '2 seconds'
    and lower(coalesce(m.role, '')) not in ('ai', 'system', 'owner-ai');

  if v_recent_count >= 4 then
    update public.app_users
       set timeout_until = now() + interval '30 seconds',
           timeout_reason = 'Automatic spam timeout: 5 messages in 2 seconds',
           timeout_by_username = 'Spam protection',
           timeout_by_user_id = null,
           timeout_by_rank = 0
     where id = new.user_id;
  end if;

  return new;
end;
$function$;

-- 5. clear_timeout_user: now follows the rank of whoever gave the timeout.
create or replace function public.clear_timeout_user(p_session_token text, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_actor public.app_users%rowtype; v_target public.app_users%rowtype; v_block text;
begin
  select u.* into v_actor from public.sessions s join public.app_users u on u.id=s.user_id
  where s.token::text=p_session_token and (s.expires_at is null or s.expires_at>now()) limit 1;
  if v_actor.id is null then raise exception 'Invalid or expired session.'; end if;
  if coalesce(v_actor.is_banned,false) then raise exception 'This account is banned.'; end if;
  select * into v_target from public.app_users where id=p_user_id for update;
  if v_target.id is null then raise exception 'User not found.'; end if;
  v_block:=phoenix_private.timeout_clear_block(v_actor.id,v_actor.is_owner,v_actor.role,v_target.id,v_target.is_owner,v_target.role,
                                               v_target.timeout_until,v_target.timeout_by_rank,v_target.timeout_by_username);
  if v_block is not null then raise exception '%', v_block; end if;
  update public.app_users
     set timeout_until=null, timeout_reason=null, timeout_by_username=null, timeout_by_user_id=null, timeout_by_rank=null
   where id=p_user_id;
end;
$function$;

-- 6. One member's timeout, for the profile popup (staff only).
create or replace function public.phoenix_timeout_status(p_session_token text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_actor public.app_users%rowtype; v_target public.app_users%rowtype; v_block text;
begin
  select u.* into v_actor from public.sessions s join public.app_users u on u.id=s.user_id
  where s.token::text=p_session_token and (s.expires_at is null or s.expires_at>now()) limit 1;
  if v_actor.id is null then raise exception 'Invalid or expired session.'; end if;
  if coalesce(v_actor.is_banned,false) then raise exception 'This account is banned.'; end if;
  if not coalesce(v_actor.is_owner,false) and coalesce(v_actor.role,'') not in ('co-owner','admin','manager') then
    raise exception 'Your role does not have permission to view timeouts.';
  end if;
  select * into v_target from public.app_users where id=p_user_id;
  if v_target.id is null then raise exception 'User not found.'; end if;
  if v_target.timeout_until is null or v_target.timeout_until<=now() then
    return jsonb_build_object('timed_out',false);
  end if;
  v_block:=phoenix_private.timeout_clear_block(v_actor.id,v_actor.is_owner,v_actor.role,v_target.id,v_target.is_owner,v_target.role,
                                               v_target.timeout_until,v_target.timeout_by_rank,v_target.timeout_by_username);
  return jsonb_build_object('timed_out',true,'timeout_until',v_target.timeout_until,'timeout_reason',v_target.timeout_reason,
                            'timeout_by',v_target.timeout_by_username,'can_clear',v_block is null,'clear_blocked_reason',v_block);
end;
$function$;

-- 7. Every active timeout, for the staff Members tab (staff only).
create or replace function public.phoenix_active_timeouts(p_session_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_actor public.app_users%rowtype; v_result jsonb;
begin
  select u.* into v_actor from public.sessions s join public.app_users u on u.id=s.user_id
  where s.token::text=p_session_token and (s.expires_at is null or s.expires_at>now()) limit 1;
  if v_actor.id is null then raise exception 'Invalid or expired session.'; end if;
  if coalesce(v_actor.is_banned,false) then raise exception 'This account is banned.'; end if;
  if not coalesce(v_actor.is_owner,false) and coalesce(v_actor.role,'') not in ('co-owner','admin','manager') then
    raise exception 'Your role does not have permission to view timeouts.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',t.id,'username',t.username,'display_name',coalesce(t.display_name,t.username),
           'timeout_until',t.timeout_until,'timeout_reason',t.timeout_reason,'timeout_by',t.timeout_by_username,
           'can_clear',t.block is null,'clear_blocked_reason',t.block) order by t.timeout_until),'[]'::jsonb)
    into v_result
  from (
    select u.*, phoenix_private.timeout_clear_block(v_actor.id,v_actor.is_owner,v_actor.role,u.id,u.is_owner,u.role,
                                                    u.timeout_until,u.timeout_by_rank,u.timeout_by_username) as block
    from public.app_users u
    where u.timeout_until is not null and u.timeout_until>now()
  ) t;
  return v_result;
end;
$function$;

grant execute on function public.clear_timeout_user(text,uuid) to anon, authenticated;
grant execute on function public.phoenix_timeout_status(text,uuid) to anon, authenticated;
grant execute on function public.phoenix_active_timeouts(text) to anon, authenticated;

commit;
