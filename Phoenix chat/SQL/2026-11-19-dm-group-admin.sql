-- Phoenix Chat: delete group DMs, and let the owner see every group DM.
--
-- Run this once in the Phoenix Chat Supabase project (SQL Editor → New query →
-- paste → Run). NOT the Supabase plugin connected to Claude: that is a
-- different database.
--
-- Adds public.phoenix_dm_group_admin(p_session_token, p_action, p_thread):
--   'delete'   → the person who made the group, or the server owner, deletes the
--                group with its members and messages.
--   'list_all' → server owner only: every group with its name, who made it,
--                member count and dates (no message contents).
-- The existing phoenix_dm_groups function is not changed.
--
-- Safe to run more than once.

begin;

create or replace function public.phoenix_dm_group_admin(p_session_token text, p_action text, p_thread uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  viewer uuid;
  viewer_is_owner boolean;
  t phoenix_private.dm_group_threads%rowtype;
  result jsonb;
begin
  viewer := phoenix_private.social_viewer(p_session_token);
  select coalesce(u.is_owner,false) into viewer_is_owner from public.app_users u where u.id=viewer;

  if p_action = 'list_all' then
    if not viewer_is_owner then raise exception 'Only the owner can see every group DM.' using errcode='42501'; end if;
    select coalesce(jsonb_agg(jsonb_build_object(
             'id',g.id,'name',g.name,'owner_id',g.owner_id,
             'owner_username',u.username,'owner_display_name',coalesce(nullif(u.display_name,''),u.username),
             'member_count',(select count(*) from phoenix_private.dm_group_members m where m.thread_id=g.id),
             'message_count',(select count(*) from phoenix_private.dm_group_messages x where x.thread_id=g.id),
             'created_at',g.created_at,'updated_at',g.updated_at
           ) order by g.created_at desc),'[]'::jsonb)
      into result
    from phoenix_private.dm_group_threads g
    left join public.app_users u on u.id=g.owner_id;
    return result;
  end if;

  if p_action = 'delete' then
    if p_thread is null then raise exception 'Choose a group to delete.'; end if;
    select * into t from phoenix_private.dm_group_threads where id=p_thread for update;
    if not found then raise exception 'That group no longer exists.'; end if;
    if t.owner_id is distinct from viewer and not viewer_is_owner then
      raise exception 'Only the person who made this group or the server owner can delete it.' using errcode='42501';
    end if;
    delete from phoenix_private.dm_group_messages where thread_id=t.id;
    delete from phoenix_private.dm_group_members where thread_id=t.id;
    delete from phoenix_private.dm_group_threads where id=t.id;
    return jsonb_build_object('ok',true,'deleted_id',t.id,'name',t.name);
  end if;

  raise exception 'Unknown group DM admin action.';
end
$function$;

revoke all on function public.phoenix_dm_group_admin(text,text,uuid) from public;
grant execute on function public.phoenix_dm_group_admin(text,text,uuid) to anon, authenticated;

commit;
