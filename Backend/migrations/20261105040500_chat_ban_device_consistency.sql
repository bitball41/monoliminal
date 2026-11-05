-- Keep in-chat moderation consistent with Control and repair existing bans.
create or replace function public.chat_ban_user(
  p_actor_username text, p_actor_password_hash text,
  p_target_username text, p_reason text default ''::text
) returns boolean language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
begin
  v_actor := private.require_chat_staff_min_rank(3);
  if v_actor.staff_role in ('admin', 'super_mega_tuff_admin', 'dusty') then
    raise exception 'Admins cannot ban accounts. Use delete account, or ask a manager, co-owner, owner, or PRESTON.';
  end if;
  v_target := private.chat_require_moderation_target(v_actor.username, p_target_username, 3, 'ban');

  update public.profiles
  set is_banned = true, ban_reason = coalesce(p_reason, ''), banned_by = v_actor.username
  where username = v_target.username;

  insert into public.bans (username, reason, banned_by)
  values (v_target.username, coalesce(p_reason, ''), v_actor.username);

  insert into public.chat_device_bans (device_id, username, reason, banned_by)
  select d.device_id, v_target.username, coalesce(p_reason, ''), v_actor.username
  from public.chat_devices d
  where d.username = v_target.username
  on conflict (device_id) do update
  set username = excluded.username, reason = excluded.reason,
      banned_by = excluded.banned_by, created_at = pg_catalog.now();

  insert into private.chat_admin_audit (actor_username, action, target, details)
  values (v_actor.username, 'user_banned_in_chat', v_target.username,
          pg_catalog.jsonb_build_object('reason', coalesce(p_reason, '')));
  return true;
end;
$function$;

-- Preserve existing device bans if a device has more than one banned account.
insert into public.chat_device_bans (device_id, username, reason, banned_by)
select distinct on (d.device_id)
  d.device_id, p.username, coalesce(p.ban_reason, ''), coalesce(p.banned_by, '')
from public.chat_devices d
join public.profiles p on p.username = d.username
where p.is_banned
order by d.device_id, d.last_seen_at desc nulls last, p.username
on conflict (device_id) do nothing;
