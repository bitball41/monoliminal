-- Authorization is enforced here for current clients, older HTML copies, and direct API requests.
-- Public launcher keys and client flags are never permissions.
BEGIN;

CREATE OR REPLACE FUNCTION private.chat_has_rank(p_min_rank integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND NOT p.is_banned
      AND private.chat_staff_rank(p.staff_role) >= p_min_rank
  );
$function$;

CREATE OR REPLACE FUNCTION private.chat_require_moderation_target(
  p_actor_username text, p_target_username text, p_min_rank integer, p_action text
)
RETURNS public.profiles LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
BEGIN
  -- p_actor_username comes only from a verified session in the calling RPC.
  SELECT * INTO v_actor FROM public.profiles
  WHERE username = p_actor_username AND NOT is_banned FOR UPDATE;
  IF v_actor.username IS NULL OR private.chat_staff_rank(v_actor.staff_role) < p_min_rank THEN
    RAISE EXCEPTION 'Insufficient staff permission';
  END IF;
  IF p_action IN ('ban', 'unban') AND v_actor.staff_role IN ('admin', 'super_mega_tuff_admin', 'dusty') THEN
    RAISE EXCEPTION 'Admins cannot manage bans';
  END IF;
  SELECT * INTO v_target FROM public.profiles
  WHERE lower(username) = lower(btrim(p_target_username)) FOR UPDATE;
  IF v_target.username IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_target.username = v_actor.username OR v_target.staff_role IN ('owner', 'preston')
     OR private.chat_staff_rank(v_actor.staff_role) <= private.chat_staff_rank(v_target.staff_role) THEN
    RAISE EXCEPTION 'You can only moderate another account below your rank';
  END IF;
  IF p_action = 'timeout' AND lower(v_target.username) = 'luna' THEN
    RAISE EXCEPTION 'Luna cannot be timed out';
  END IF;
  RETURN v_target;
END;
$function$;

-- Reaction arrays may change only the caller's identity, even on their own posts.
CREATE OR REPLACE FUNCTION private.chat_assert_reaction_change(p_old jsonb, p_new jsonb, p_actor text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_key text;
  v_before jsonb;
  v_after jsonb;
  v_others_before jsonb;
  v_others_after jsonb;
BEGIN
  IF p_new IS NOT DISTINCT FROM p_old THEN RETURN; END IF;
  IF p_actor IS NULL THEN RAISE EXCEPTION 'Active account required'; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE username = p_actor AND timeout_until > now()) THEN
    RAISE EXCEPTION 'You are timed out';
  END IF;
  p_old := coalesce(p_old, '{}'::jsonb);
  p_new := coalesce(p_new, '{}'::jsonb);
  IF jsonb_typeof(p_old) <> 'object' OR jsonb_typeof(p_new) <> 'object' THEN
    RAISE EXCEPTION 'Reactions must be an object';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_new)) >
     greatest(40, (SELECT count(*) FROM jsonb_object_keys(p_old))) THEN
    RAISE EXCEPTION 'Too many different reactions';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_old) UNION SELECT jsonb_object_keys(p_new) LOOP
    v_before := coalesce(p_old -> v_key, '[]'::jsonb);
    v_after := coalesce(p_new -> v_key, '[]'::jsonb);
    IF v_before IS NOT DISTINCT FROM v_after THEN CONTINUE; END IF;
    IF char_length(v_key) NOT BETWEEN 1 AND 32
       OR jsonb_typeof(v_before) <> 'array' OR jsonb_typeof(v_after) <> 'array' THEN
      RAISE EXCEPTION 'Invalid reaction';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_after) u WHERE jsonb_typeof(u) <> 'string')
       OR (SELECT count(*) FROM jsonb_array_elements_text(v_after) u WHERE u = p_actor) > 1 THEN
      RAISE EXCEPTION 'Invalid reaction identities';
    END IF;
    SELECT coalesce(jsonb_agg(u ORDER BY ord), '[]'::jsonb) INTO v_others_before
      FROM jsonb_array_elements(v_before) WITH ORDINALITY AS e(u,ord) WHERE u <> to_jsonb(p_actor);
    SELECT coalesce(jsonb_agg(u ORDER BY ord), '[]'::jsonb) INTO v_others_after
      FROM jsonb_array_elements(v_after) WITH ORDINALITY AS e(u,ord) WHERE u <> to_jsonb(p_actor);
    IF v_others_before IS DISTINCT FROM v_others_after THEN
      RAISE EXCEPTION 'You can only change your own reactions';
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION private.chat_reply_snapshot(p_kind text, p_destination text, p_reply jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_id uuid;
  v_sender text;
  v_content text;
  v_type text;
BEGIN
  IF p_reply IS NULL THEN RETURN null; END IF;
  BEGIN
    IF jsonb_typeof(p_reply) = 'string' THEN p_reply := (p_reply #>> '{}')::jsonb; END IF;
    v_id := (p_reply->>'id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RETURN null;
  END;
  IF p_kind = 'dm' THEN
    SELECT sender,content,type INTO v_sender,v_content,v_type FROM public.dm_messages
    WHERE id=v_id AND dm_id::text=p_destination AND NOT coalesce(deleted,false);
  ELSE
    SELECT sender,content,type INTO v_sender,v_content,v_type FROM public.messages
    WHERE id=v_id AND channel_id=p_destination AND NOT coalesce(deleted,false);
  END IF;
  IF v_sender IS NULL THEN RETURN null; END IF;
  RETURN jsonb_build_object('id',v_id,'sender',v_sender,
    'snippet',left(coalesce(nullif(v_content,''),'['||coalesce(v_type,'text')||']'),90));
END;
$function$;
REVOKE ALL ON FUNCTION private.chat_reply_snapshot(text,text,jsonb) FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION private.chat_assert_forum_post_allowed(p_sender text, p_body text, p_title text, p_insert boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_max integer := 2000;
  v_words jsonb;
  v_word text;
  v_slow integer := 0;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE username = p_sender;
  IF v_actor.username IS NULL OR v_actor.is_banned THEN RAISE EXCEPTION 'Active account required'; END IF;
  IF v_actor.timeout_until > now() THEN RAISE EXCEPTION 'This account is timed out'; END IF;
  IF EXISTS (SELECT 1 FROM public.app_settings WHERE key = 'app_enabled' AND value = 'false')
     AND v_actor.staff_role NOT IN ('owner', 'preston') THEN
    RAISE EXCEPTION 'Liminal Chat is currently disabled';
  END IF;
  IF p_insert AND EXISTS (SELECT 1 FROM public.app_settings WHERE key = 'messages_enabled' AND value = 'false')
     AND private.chat_staff_rank(v_actor.staff_role) < 4 THEN
    RAISE EXCEPTION 'Sending messages is currently disabled';
  END IF;
  BEGIN
    SELECT coalesce((SELECT value::integer FROM public.app_settings WHERE key = 'max_message_length'),2000) INTO v_max;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN v_max := 2000;
  END;
  IF char_length(coalesce(p_body,'')) > greatest(100,least(v_max,4000)) THEN
    RAISE EXCEPTION 'Post exceeds the current length limit';
  END IF;
  BEGIN
    SELECT value::jsonb INTO v_words FROM public.app_settings WHERE key = 'banned_words';
  EXCEPTION WHEN invalid_text_representation THEN v_words := '[]'::jsonb;
  END;
  FOR v_word IN SELECT jsonb_array_elements_text(coalesce(v_words,'[]'::jsonb)) LOOP
    IF v_word <> '' AND position(lower(v_word) IN lower(coalesce(p_body,'') || ' ' || coalesce(p_title,''))) > 0 THEN
      RAISE EXCEPTION 'Post contains a blocked word';
    END IF;
  END LOOP;
  IF p_insert AND private.chat_staff_rank(v_actor.staff_role) < 4 THEN
    BEGIN
      SELECT coalesce((SELECT value::integer FROM public.app_settings WHERE key = 'slow_mode_seconds'),0) INTO v_slow;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN v_slow := 0;
    END;
    IF v_slow > 0 AND EXISTS (
      SELECT 1 FROM public.forum_threads WHERE author = p_sender AND body <> ''
      AND created_at > now() - make_interval(secs => v_slow)
    ) THEN RAISE EXCEPTION 'Slow mode is active. Please wait before posting again'; END IF;
  END IF;
END;
$function$;

ALTER POLICY channels_staff_insert ON public.channels WITH CHECK (private.chat_has_rank(4));
ALTER POLICY channels_staff_update ON public.channels USING (private.chat_has_rank(4)) WITH CHECK (private.chat_has_rank(4));
ALTER POLICY channels_staff_delete ON public.channels USING (private.chat_has_rank(4));

-- Banned and missing profiles cannot write to any of Liminal's upload buckets.
CREATE POLICY liminal_active_account_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (bucket_id NOT IN ('liminal-media','liminal-pfp','liminal-avatars','liminal-stickers')
            OR private.chat_username() IS NOT NULL);
CREATE POLICY liminal_active_account_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
USING (bucket_id NOT IN ('liminal-media','liminal-pfp','liminal-avatars','liminal-stickers')
       OR private.chat_username() IS NOT NULL)
WITH CHECK (bucket_id NOT IN ('liminal-media','liminal-pfp','liminal-avatars','liminal-stickers')
            OR private.chat_username() IS NOT NULL);
CREATE POLICY liminal_active_account_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
USING (bucket_id NOT IN ('liminal-media','liminal-pfp','liminal-avatars','liminal-stickers')
       OR private.chat_username() IS NOT NULL);

-- RLS does not govern TRUNCATE. Browser roles never need DDL or table administration.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE ALL ON FUNCTION private.chat_has_rank(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.chat_has_rank(integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION private.chat_require_moderation_target(text,text,integer,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.chat_assert_reaction_change(jsonb,jsonb,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.chat_assert_forum_post_allowed(text,text,text,boolean) FROM PUBLIC, anon, authenticated;



CREATE OR REPLACE FUNCTION public.chat_admin_set_setting(p_actor_username text, p_actor_password_hash text, p_key text, p_value text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_value text := coalesce(p_value, '');
  v_words jsonb;
BEGIN
  IF p_key NOT IN ('app_enabled', 'announcement', 'whats_new', 'banned_words') THEN
    RAISE EXCEPTION 'Unsupported in-app setting';
  END IF;

  IF p_key IN ('app_enabled', 'announcement', 'whats_new') THEN
    v_actor := private.require_chat_staff_min_rank(6); -- owner and PRESTON only
  ELSE
    v_actor := private.require_chat_staff_min_rank(4); -- admin+ for banned words
  END IF;

  IF p_key = 'app_enabled' AND v_value NOT IN ('true', 'false') THEN
    RAISE EXCEPTION 'Feature flags must be true or false';
  ELSIF p_key = 'announcement' AND char_length(v_value) > 300 THEN
    RAISE EXCEPTION 'Announcement is too long';
  ELSIF p_key = 'whats_new' AND char_length(v_value) > 4000 THEN
    RAISE EXCEPTION 'What''s new is too long';
  ELSIF p_key = 'banned_words' THEN
    BEGIN
      SELECT coalesce(jsonb_agg(word ORDER BY word), '[]'::jsonb)
      INTO v_words
      FROM (
        SELECT DISTINCT lower(pg_catalog.btrim(value)) AS word
        FROM jsonb_array_elements_text(v_value::jsonb)
        WHERE char_length(pg_catalog.btrim(value)) BETWEEN 1 AND 40
        LIMIT 200
      ) words;
      v_value := v_words::text;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Banned words must be a JSON array';
    END;
  END IF;

  INSERT INTO public.app_settings (key, value, updated_at)
  VALUES (p_key, v_value, now())
  ON CONFLICT (key) DO UPDATE
  SET value = excluded.value, updated_at = excluded.updated_at;

  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (
    v_actor.username,
    'in_app_setting_updated',
    p_key,
    jsonb_build_object(
      'value',
      CASE WHEN p_key = 'banned_words' THEN '[redacted list]' ELSE v_value END
    )
  );

  RETURN true;
END;
$function$;


CREATE OR REPLACE FUNCTION public.chat_protect_profile_privileges()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if (
      coalesce(new.staff_role, 'member') <> 'member'
      or coalesce(new.is_admin, false)
      or coalesce(new.is_owner, false)
      or coalesce(new.is_banned, false)
      or coalesce(new.is_test_account, false)
      or coalesce(new.ban_reason, '') <> ''
      or coalesce(new.banned_by, '') <> ''
      or new.timeout_until is not null
      or coalesce(new.timeout_by, '') <> ''
      or new.kicked_at is not null
    ) then
      raise exception 'Privileged profile fields require an authorized RPC';
    end if;
    return new;
  end if;

  if new.username is distinct from old.username
    or new.user_id is distinct from old.user_id
    or new.created_at is distinct from old.created_at
    or new.password_hash is distinct from old.password_hash
    or new.staff_role is distinct from old.staff_role
    or new.is_admin is distinct from old.is_admin
    or new.is_owner is distinct from old.is_owner
    or new.is_banned is distinct from old.is_banned
    or new.is_test_account is distinct from old.is_test_account
    or new.ban_reason is distinct from old.ban_reason
    or new.banned_by is distinct from old.banned_by
    or new.timeout_until is distinct from old.timeout_until
    or new.timeout_by is distinct from old.timeout_by
    or new.kicked_at is distinct from old.kicked_at
  then
    raise exception 'Privileged profile fields require an authorized RPC';
  end if;

  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION private.require_chat_admin(p_admin_token text, p_owner_only boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_username text;
  v_is_owner boolean;
begin
  if p_admin_token is null or char_length(p_admin_token) < 32 then
    raise exception 'Invalid or expired administrator session';
  end if;

  select s.username, p.staff_role in ('owner', 'preston')
  into v_username, v_is_owner
  from private.chat_admin_sessions s
  join public.profiles p on p.username = s.username
  where s.token_hash = extensions.digest(p_admin_token, 'sha256')
    and s.expires_at > now()
    and not p.is_banned
    and private.chat_staff_rank(p.staff_role) >= 4;

  if v_username is null then
    raise exception 'Invalid or expired administrator session';
  end if;

  if p_owner_only and not v_is_owner then
    raise exception 'Owner access is required';
  end if;

  update private.chat_admin_sessions
  set last_seen_at = now()
  where token_hash = extensions.digest(p_admin_token, 'sha256');

  return v_username;
end;
$function$;


CREATE OR REPLACE FUNCTION public.chat_ban_user(p_actor_username text, p_actor_password_hash text, p_target_username text, p_reason text DEFAULT ''::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  set is_banned = true,
      ban_reason = coalesce(p_reason, ''),
      banned_by = v_actor.username
  where username = v_target.username;

  insert into public.bans (username, reason, banned_by)
  values (v_target.username, coalesce(p_reason, ''), v_actor.username);

  insert into private.chat_admin_audit (
    actor_username,
    action,
    target,
    details
  )
  values (
    v_actor.username,
    'user_banned_in_chat',
    v_target.username,
    jsonb_build_object('reason', coalesce(p_reason, ''))
  );

  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.chat_staff_kick_user(p_actor_username text, p_actor_password_hash text, p_target_username text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
BEGIN
  v_actor := private.require_chat_staff_min_rank(2);
  v_target := private.chat_require_moderation_target(v_actor.username, p_target_username, 2, 'kick');

  UPDATE public.profiles SET kicked_at = now() WHERE username = v_target.username;
  INSERT INTO private.chat_admin_audit (actor_username, action, target)
  VALUES (v_actor.username, 'user_kicked_in_chat', v_target.username);
  RETURN true;
END;
$function$;


CREATE OR REPLACE FUNCTION public.chat_staff_timeout_user(p_actor_username text, p_actor_password_hash text, p_target_username text, p_minutes integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_until timestamptz;
  v_max integer;
BEGIN
  IF p_minutes NOT BETWEEN 0 AND 10080 THEN
    RAISE EXCEPTION 'Timeout must be between 0 minutes and 7 days';
  END IF;

  v_actor := private.require_chat_staff_min_rank(2);
  v_target := private.chat_require_moderation_target(v_actor.username, p_target_username, 2, 'timeout');

  -- Mods max 2 hours. Manager+ any duration (within 7d).
  v_max := CASE WHEN v_actor.staff_role = 'mod' THEN 120 ELSE 10080 END;
  IF p_minutes > v_max THEN
    RAISE EXCEPTION 'Your rank can only timeout up to % minutes', v_max;
  END IF;

  v_until := CASE WHEN p_minutes = 0 THEN NULL ELSE now() + pg_catalog.make_interval(mins => p_minutes) END;

  UPDATE public.profiles
  SET timeout_until = v_until,
      timeout_by = CASE WHEN v_until IS NULL THEN '' ELSE v_actor.username END
  WHERE username = v_target.username;

  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (
    v_actor.username,
    CASE WHEN v_until IS NULL THEN 'timeout_cleared_in_chat' ELSE 'user_timed_out_in_chat' END,
    v_target.username,
    jsonb_build_object('minutes', p_minutes)
  );
  RETURN true;
END;
$function$;


CREATE OR REPLACE FUNCTION public.chat_staff_delete_account(p_actor_username text, p_actor_password_hash text, p_target_username text, p_confirm text DEFAULT ''::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
begin
  v_actor := private.require_chat_staff_min_rank(4);

  if lower(pg_catalog.btrim(coalesce(p_confirm, ''))) <> 'delete' then
    raise exception 'Confirmation required';
  end if;

  v_target := private.chat_require_moderation_target(v_actor.username, p_target_username, 4, 'delete');

  perform public.chat_delete_account_data(v_target.user_id);

  insert into private.chat_admin_audit (actor_username, action, target)
  values (v_actor.username, 'account_deleted_in_chat', v_target.username);

  -- The old implementation deleted only the profile, so the auth identity
  -- remained and blocked that username from being re-created.
  delete from auth.users where id = v_target.user_id;
  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.admin_dashboard_ban_user(p_admin_token text, p_target_username text, p_reason text DEFAULT ''::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor text;
  v_actor_owner boolean;
  v_target public.profiles%rowtype;
  v_reason text := left(coalesce(pg_catalog.btrim(p_reason), ''), 1000);
begin
  v_actor := private.require_chat_admin(p_admin_token);
  select is_owner into v_actor_owner from public.profiles where username = v_actor;
  v_target := private.chat_require_moderation_target(v_actor, p_target_username, 3, 'ban');

  update public.profiles
  set is_banned = true, ban_reason = v_reason, banned_by = v_actor
  where username = v_target.username;

  insert into public.bans (username, reason, banned_by)
  values (v_target.username, v_reason, v_actor);

  insert into public.chat_device_bans (device_id, username, reason, banned_by)
  select d.device_id, v_target.username, v_reason, v_actor
  from public.chat_devices d
  where d.username = v_target.username
  on conflict (device_id) do update
  set username = excluded.username,
      reason = excluded.reason,
      banned_by = excluded.banned_by,
      created_at = now();

  insert into private.chat_admin_audit (actor_username, action, target, details)
  values (v_actor, 'user_banned', v_target.username, jsonb_build_object('reason', v_reason));
  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.admin_dashboard_kick_user(p_admin_token text, p_target_username text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor text;
  v_actor_owner boolean;
  v_target public.profiles%rowtype;
begin
  v_actor := private.require_chat_admin(p_admin_token);
  select p.is_owner into v_actor_owner from public.profiles p where p.username = v_actor;
  v_target := private.chat_require_moderation_target(v_actor, p_target_username, 2, 'kick');

  update public.profiles
  set kicked_at = now()
  where username = v_target.username;

  insert into private.chat_admin_audit (actor_username, action, target)
  values (v_actor, 'user_kicked', v_target.username);
  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.admin_dashboard_timeout_user(p_admin_token text, p_target_username text, p_minutes integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor text;
  v_actor_owner boolean;
  v_target public.profiles%rowtype;
  v_until timestamptz;
begin
  if p_minutes not between 1 and 10080 then
    raise exception 'Timeout must be between 1 minute and 7 days';
  end if;
  v_actor := private.require_chat_admin(p_admin_token);
  select is_owner into v_actor_owner from public.profiles where username = v_actor;
  v_target := private.chat_require_moderation_target(v_actor, p_target_username, 2, 'timeout');

  v_until := now() + pg_catalog.make_interval(mins => p_minutes);
  update public.profiles
  set timeout_until = v_until, timeout_by = v_actor
  where username = v_target.username;

  insert into private.chat_admin_audit (actor_username, action, target, details)
  values (v_actor, 'user_timed_out', v_target.username, jsonb_build_object('minutes', p_minutes));
  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.admin_dashboard_clear_timeout(p_admin_token text, p_target_username text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor text;
  v_target text;
  v_profile public.profiles%rowtype;
begin
  v_actor := private.require_chat_admin(p_admin_token);
  v_profile := private.chat_require_moderation_target(v_actor, p_target_username, 2, 'timeout');
  v_target := v_profile.username;

  update public.profiles
  set timeout_until = null, timeout_by = ''
  where username = v_target;

  insert into private.chat_admin_audit (actor_username, action, target)
  values (v_actor, 'timeout_cleared', v_target);
  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.admin_dashboard_unban_user(p_admin_token text, p_target_username text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor text;
  v_target text;
  v_profile public.profiles%rowtype;
begin
  v_actor := private.require_chat_admin(p_admin_token);
  v_profile := private.chat_require_moderation_target(v_actor, p_target_username, 3, 'unban');
  v_target := v_profile.username;

  update public.profiles
  set is_banned = false, ban_reason = '', banned_by = ''
  where username = v_target;
  delete from public.chat_device_bans where username = v_target;

  insert into private.chat_admin_audit (actor_username, action, target)
  values (v_actor, 'user_unbanned', v_target);
  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.chat_unban_user(p_actor_username text, p_actor_password_hash text, p_target_username text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor public.profiles%rowtype;
  v_target text;
  v_profile public.profiles%rowtype;
begin
  v_actor := private.require_chat_staff_min_rank(3);
  if v_actor.staff_role in ('admin', 'super_mega_tuff_admin', 'dusty') then
    raise exception 'Admins cannot manage bans.';
  end if;

  v_profile := private.chat_require_moderation_target(v_actor.username, p_target_username, 3, 'unban');
  v_target := v_profile.username;

  update public.profiles
  set is_banned = false,
      ban_reason = '',
      banned_by = ''
  where username = v_target;

  delete from public.chat_device_bans
  where username = v_target;

  insert into private.chat_admin_audit (
    actor_username,
    action,
    target
  )
  values (
    v_actor.username,
    'user_unbanned_in_chat',
    v_target
  );

  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.chat_guard_message_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor text := private.chat_username();
  v_staff boolean := private.chat_is_staff(false);
  v_thread public.forum_threads%rowtype;
  v_channel_id text;
  v_min text;
  v_role text;
  v_new jsonb;
  v_old jsonb;
begin
  if current_setting('app.chat_account_delete', true) = 'true'
     or current_setting('app.chat_admin_delete', true) = 'true' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'INSERT'
     and new.sender = 'Luna'
     and current_setting('app.luna_reply_insert', true) = 'true' then
    return new;
  end if;

  if v_actor is null then raise exception 'Authentication required'; end if;
  if new.type = 'system' and (tg_op = 'INSERT' or new.type is distinct from old.type) then
    raise exception 'System messages require a server operation';
  end if;

  if tg_op = 'DELETE' then
    if old.sender = v_actor or v_staff then return old; end if;
    raise exception 'You cannot delete this message';
  end if;

  if tg_op = 'INSERT' then
    if new.sender <> v_actor then raise exception 'Sender must match the signed-in user'; end if;
    new.created_at := pg_catalog.now();
    new.reply_to := private.chat_reply_snapshot('channel',new.channel_id,new.reply_to);
    if new.pinned and not v_staff then raise exception 'Only staff can pin messages'; end if;
    if coalesce(new.reactions, '{}'::jsonb) <> '{}'::jsonb
       or new.deleted or new.deleted_at is not null or new.deleted_by is not null then
      raise exception 'New messages cannot contain forged moderation or reaction metadata';
    end if;
    if new.channel_id like 'forum:%' then
      begin
        select * into v_thread
        from public.forum_threads
        where id = substring(new.channel_id from 7)::uuid
          and not deleted;
      exception when invalid_text_representation then
        raise exception 'Invalid forum thread';
      end;
      if v_thread.id is null then raise exception 'Forum thread not found'; end if;
      if v_thread.locked and not v_staff then raise exception 'This post is locked'; end if;
      if v_thread.channel_id = 'following' and v_thread.author <> v_actor then
        raise exception 'Only the feed owner can post here';
      end if;
      v_channel_id := v_thread.channel_id;
    else
      if not exists (select 1 from public.channels c where c.id = new.channel_id) then
        raise exception 'Channel not found';
      end if;
      v_channel_id := new.channel_id;
    end if;

    select c.min_speak_role into v_min from public.channels c where c.id = v_channel_id;
    select p.staff_role into v_role from public.profiles p where p.username = v_actor;
    if private.chat_staff_rank(coalesce(v_role, 'member'))
       < private.chat_staff_rank(coalesce(v_min, 'member')) then
      raise exception 'You cannot send messages in this channel';
    end if;
    return new;
  end if;

  if row(new.id,new.sender,new.channel_id,new.created_at) is distinct from row(old.id,old.sender,old.channel_id,old.created_at) then
    raise exception 'Message ownership fields are immutable';
  end if;
  if new.reply_to is distinct from old.reply_to then raise exception 'Reply identity is immutable'; end if;
  if new.deleted_at is distinct from old.deleted_at or new.deleted_by is distinct from old.deleted_by then
    raise exception 'Deletion metadata is assigned by the server';
  end if;
  perform private.chat_assert_reaction_change(old.reactions, new.reactions, v_actor);
  if old.deleted and new.deleted is distinct from old.deleted then
    raise exception 'Deleted messages cannot be restored through a client update';
  end if;
  if v_staff and old.sender <> v_actor then
    if (to_jsonb(new) - array['pinned','deleted','reactions','search_tsv'])
       is distinct from (to_jsonb(old) - array['pinned','deleted','reactions','search_tsv']) then
      raise exception 'Staff can moderate messages but cannot rewrite another user''s content';
    end if;
    return new;
  end if;
  if old.sender = v_actor then
    if not v_staff and new.pinned is distinct from old.pinned then raise exception 'Only staff can pin messages'; end if;
    return new;
  end if;

  -- search_tsv is generated and can look changed inside this trigger even when
  -- the only real edit is the reaction list.
  v_new := to_jsonb(new) - 'reactions' - 'search_tsv';
  v_old := to_jsonb(old) - 'reactions' - 'search_tsv';
  if v_new is distinct from v_old then
    raise exception 'Only reactions may be changed on another user''s message';
  end if;
  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION public.chat_guard_dm_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor text := private.chat_username();
  v_new jsonb;
  v_old jsonb;
begin
  if current_setting('app.chat_account_delete', true) = 'true'
     or current_setting('app.chat_admin_delete', true) = 'true' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'INSERT'
     and new.sender = 'Luna'
     and current_setting('app.luna_reply_insert', true) = 'true' then
    return new;
  end if;
  if tg_op = 'INSERT'
     and coalesce(current_setting('app.luna_import_user', true), '') <> ''
     and (new.sender = 'Luna' or new.sender = current_setting('app.luna_import_user', true)) then
    return new;
  end if;
  if v_actor is null then raise exception 'Authentication required'; end if;
  if new.type = 'system' and (tg_op = 'INSERT' or new.type is distinct from old.type) then
    raise exception 'System messages require a server operation';
  end if;

  if tg_op = 'DELETE' then
    if old.sender = v_actor or private.chat_is_staff(false) then return old; end if;
    raise exception 'You cannot delete this message';
  end if;

  if tg_op = 'INSERT' then
    if new.sender <> v_actor then raise exception 'Sender must match the signed-in user'; end if;
    new.created_at := pg_catalog.now();
    new.reply_to := private.chat_reply_snapshot('dm',new.dm_id::text,new.reply_to);
    if coalesce(new.reactions, '{}'::jsonb) <> '{}'::jsonb
       or new.deleted or new.deleted_at is not null or new.deleted_by is not null
       or coalesce(new.read_by, array[]::text[]) not in (array[]::text[], array[v_actor]) then
      raise exception 'New messages cannot contain forged moderation, reactions or read receipts';
    end if;
    return new;
  end if;
  if row(new.id,new.sender,new.dm_id,new.created_at) is distinct from row(old.id,old.sender,old.dm_id,old.created_at) then
    raise exception 'DM ownership fields are immutable';
  end if;
  if new.reply_to is distinct from old.reply_to then raise exception 'Reply identity is immutable'; end if;
  if new.deleted_at is distinct from old.deleted_at or new.deleted_by is distinct from old.deleted_by then
    raise exception 'Deletion metadata is assigned by the server';
  end if;
  perform private.chat_assert_reaction_change(old.reactions, new.reactions, v_actor);
  if old.deleted and new.deleted is distinct from old.deleted then
    raise exception 'Deleted messages cannot be restored through a client update';
  end if;
  if private.chat_is_staff(false)
     and new.deleted
     and (to_jsonb(new) - 'deleted' - 'deleted_at' - 'deleted_by' - 'reactions' - 'search_tsv')
         is not distinct from
         (to_jsonb(old) - 'deleted' - 'deleted_at' - 'deleted_by' - 'reactions' - 'search_tsv') then
    return new;
  end if;
  if old.sender = v_actor then
    if new.read_by is distinct from old.read_by then
      raise exception 'Senders cannot forge read receipts';
    end if;
    return new;
  end if;
  v_new := to_jsonb(new) - 'read_by' - 'reactions' - 'search_tsv';
  v_old := to_jsonb(old) - 'read_by' - 'reactions' - 'search_tsv';
  if v_new is distinct from v_old
     or (
       new.read_by is distinct from old.read_by
       and new.read_by is distinct from pg_catalog.array_append(coalesce(old.read_by, array[]::text[]), v_actor)
     ) then
    raise exception 'Only your own read receipt may be added';
  end if;
  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION public.chat_guard_forum_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor text := private.chat_username();
  v_staff boolean := private.chat_is_staff(false);
  v_channel public.channels%rowtype;
  v_role text;
BEGIN
  -- Only the server's follows trigger can create an empty feed for another account.
  IF tg_op = 'INSERT' AND pg_trigger_depth() > 1 AND new.channel_id = 'following'
     AND new.body = '' AND coalesce(new.reactions,'{}'::jsonb) = '{}'::jsonb
     AND NOT new.pinned AND NOT new.locked AND NOT new.deleted
     AND EXISTS (SELECT 1 FROM public.follows f WHERE f.followee = new.author) THEN RETURN new; END IF;
  IF tg_op = 'UPDATE' THEN
    IF row(new.id,new.author,new.channel_id,new.created_at) IS DISTINCT FROM row(old.id,old.author,old.channel_id,old.created_at) THEN
      RAISE EXCEPTION 'Forum ownership fields are immutable';
    END IF;
    IF pg_trigger_depth() > 1 AND (to_jsonb(new) - array['reply_count','last_activity_at'])
       IS NOT DISTINCT FROM (to_jsonb(old) - array['reply_count','last_activity_at']) THEN RETURN new; END IF;
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF tg_op = 'INSERT' THEN
    IF new.author <> v_actor THEN RAISE EXCEPTION 'Author must match the signed-in user'; END IF;
    IF (new.pinned OR new.locked) AND NOT v_staff THEN RAISE EXCEPTION 'Only staff can create pinned or locked posts'; END IF;
    IF coalesce(new.reactions,'{}'::jsonb) <> '{}'::jsonb OR new.deleted
       OR new.reply_count <> 0 THEN RAISE EXCEPTION 'New posts cannot contain forged metadata'; END IF;
    SELECT * INTO v_channel FROM public.channels WHERE id = new.channel_id;
    IF v_channel.id IS NULL OR v_channel.kind <> 'forum' THEN RAISE EXCEPTION 'Forum channel not found'; END IF;
    SELECT staff_role INTO v_role FROM public.profiles WHERE username = v_actor;
    IF private.chat_staff_rank(v_role) < private.chat_staff_rank(v_channel.min_speak_role) THEN
      RAISE EXCEPTION 'You cannot post in this channel';
    END IF;
    new.created_at := pg_catalog.now();
    new.last_activity_at := new.created_at;
    PERFORM private.chat_assert_forum_post_allowed(v_actor,new.body,new.title,true);
    RETURN new;
  END IF;
  IF new.reply_count IS DISTINCT FROM old.reply_count OR new.last_activity_at IS DISTINCT FROM old.last_activity_at THEN
    RAISE EXCEPTION 'Forum activity is assigned by the server';
  END IF;
  PERFORM private.chat_assert_reaction_change(old.reactions,new.reactions,v_actor);
  IF old.channel_id = 'following' AND old.author <> v_actor AND NOT v_staff
     AND NOT EXISTS (SELECT 1 FROM public.follows WHERE follower=v_actor AND followee=old.author) THEN
    RAISE EXCEPTION 'Post not found';
  END IF;
  IF old.author = v_actor THEN
    IF NOT v_staff AND (new.pinned IS DISTINCT FROM old.pinned OR new.locked IS DISTINCT FROM old.locked) THEN
      RAISE EXCEPTION 'Only staff can pin or lock posts';
    END IF;
    IF row(new.body,new.title,new.tags) IS DISTINCT FROM row(old.body,old.title,old.tags) THEN
      IF old.locked AND NOT v_staff THEN RAISE EXCEPTION 'This post is locked'; END IF;
      SELECT c.* INTO v_channel FROM public.channels c WHERE c.id = old.channel_id;
      SELECT staff_role INTO v_role FROM public.profiles WHERE username=v_actor;
      IF private.chat_staff_rank(v_role) < private.chat_staff_rank(v_channel.min_speak_role) THEN
        RAISE EXCEPTION 'You cannot post in this channel';
      END IF;
      PERFORM private.chat_assert_forum_post_allowed(v_actor,new.body,new.title,false);
    END IF;
    RETURN new;
  END IF;
  IF v_staff THEN
    IF row(new.body,new.title,new.tags) IS DISTINCT FROM row(old.body,old.title,old.tags) THEN
      SELECT c.* INTO v_channel FROM public.channels c WHERE c.id = old.channel_id;
      SELECT staff_role INTO v_role FROM public.profiles WHERE username=v_actor;
      IF private.chat_staff_rank(v_role) < private.chat_staff_rank(v_channel.min_speak_role) THEN
        RAISE EXCEPTION 'You cannot post in this channel';
      END IF;
      PERFORM private.chat_assert_forum_post_allowed(v_actor,new.body,new.title,false);
    END IF;
    RETURN new;
  END IF;
  IF (to_jsonb(new) - 'reactions') IS DISTINCT FROM (to_jsonb(old) - 'reactions') THEN
    RAISE EXCEPTION 'Only your own reactions may change on another user''s post';
  END IF;
  RETURN new;
END;
$function$;

CREATE OR REPLACE FUNCTION private.chat_stamp_soft_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'UPDATE' and new.deleted and not old.deleted then
    new.deleted_at := pg_catalog.now();
    new.deleted_by := coalesce(private.chat_username(), 'system');
  end if;
  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION public.lc_ensure_following_thread()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (
    select 1 from public.forum_threads
    where channel_id = 'following' and author = NEW.followee and deleted = false
  ) then
    insert into public.forum_threads (channel_id, title, author, body)
    values (
      'following',
      coalesce(
        (select nullif(btrim(display_name), '') from public.profiles where username = NEW.followee),
        NEW.followee
      ),
      NEW.followee,
      ''
    );
  end if;
  return NEW;
end $function$;


CREATE OR REPLACE FUNCTION public.lc_forum_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare tid uuid;
begin
  if NEW.channel_id like 'forum:%' then
    begin
      tid := substring(NEW.channel_id from 7)::uuid;
    exception when others then
      return NEW;
    end;
    update public.forum_threads
      set reply_count = reply_count + 1, last_activity_at = now()
      where id = tid;
  end if;
  return NEW;
end $function$;


CREATE POLICY profiles_active_update ON public.profiles AS RESTRICTIVE FOR UPDATE TO authenticated
USING (private.chat_username() IS NOT NULL) WITH CHECK (private.chat_username() IS NOT NULL);
CREATE OR REPLACE FUNCTION public.chat_authorize_password_reset(p_actor_user_id uuid, p_target_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
BEGIN
  -- Service-role-only: the Edge Function obtains this ID from Auth.getUser().
  SELECT * INTO v_actor FROM public.profiles WHERE user_id = p_actor_user_id AND NOT is_banned FOR UPDATE;
  SELECT * INTO v_target FROM public.profiles WHERE user_id = p_target_user_id;
  IF v_actor.username IS NULL OR v_target.username IS NULL THEN RAISE EXCEPTION 'Active account required'; END IF;
  v_target := private.chat_require_moderation_target(v_actor.username,v_target.username,4,'password_reset');
  INSERT INTO private.chat_admin_audit(actor_username,action,target,details)
  VALUES (v_actor.username,'password_reset_authorized',v_target.username,jsonb_build_object('handler','chat-auth'));
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.chat_authorize_password_reset(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_authorize_password_reset(uuid,uuid) TO service_role;

COMMIT;

