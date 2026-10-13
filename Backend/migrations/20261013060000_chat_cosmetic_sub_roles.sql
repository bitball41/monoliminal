-- Cosmetic subroles. They describe a person (developer, artist, and so on)
-- and never change staff rank or permissions. Members cannot write the column
-- themselves yet; mods and above assign it. Self-serve picking can be a later
-- RPC that only updates the caller's own sub_role.
BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS sub_role text NOT NULL DEFAULT '';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_sub_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_sub_role_check CHECK (
    sub_role = ANY (ARRAY[
      ''::text,
      'developer'::text,
      'artist'::text,
      'musician'::text,
      'writer'::text,
      'creator'::text,
      'translator'::text,
      'bug_hunter'::text,
      'event_host'::text
    ])
  );

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
      or coalesce(new.sub_role, '') <> ''
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
    or new.sub_role is distinct from old.sub_role
  then
    raise exception 'Privileged profile fields require an authorized RPC';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.chat_set_sub_role(
  p_actor_username text,
  p_actor_password_hash text,
  p_target_username text,
  p_sub_role text
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_role text := lower(pg_catalog.btrim(coalesce(p_sub_role, '')));
  v_old text;
BEGIN
  -- Username and password arguments are legacy. The signed-in account is the actor.
  v_actor := private.require_chat_staff_min_rank(2);
  IF v_role IN ('none', 'clear') THEN
    v_role := '';
  END IF;
  IF v_role NOT IN (
    '', 'developer', 'artist', 'musician', 'writer', 'creator', 'translator', 'bug_hunter', 'event_host'
  ) THEN
    RAISE EXCEPTION 'Invalid subrole';
  END IF;

  SELECT * INTO v_actor FROM public.profiles
  WHERE username = v_actor.username FOR UPDATE;
  IF coalesce(v_actor.is_banned, false) OR private.chat_staff_rank(v_actor.staff_role) < 2 THEN
    RAISE EXCEPTION 'Insufficient staff permission';
  END IF;

  SELECT * INTO v_target FROM public.profiles
  WHERE lower(username) = lower(pg_catalog.btrim(p_target_username)) FOR UPDATE;
  IF v_target.username IS NULL THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  v_old := coalesce(v_target.sub_role, '');
  IF v_old IS NOT DISTINCT FROM v_role THEN
    RETURN true;
  END IF;

  UPDATE public.profiles SET sub_role = v_role WHERE username = v_target.username;

  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (
    v_actor.username,
    'sub_role_set_in_chat',
    v_target.username,
    pg_catalog.jsonb_build_object('from', v_old, 'to', v_role)
  );
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.chat_set_sub_role(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_set_sub_role(text, text, text, text) TO authenticated, service_role;

COMMIT;
