-- Chat 6.1 part 3: custom staff roles, editable rules, cloud sticker favorites.
--
-- Roles: staff roles move from hard-coded lists to public.chat_staff_roles.
-- Each role has a permission level (tier) and a position (power):
--   tier 1 member, 2 mod, 3 manager, 4 admin, 5 co-owner, 6 owner, 7 PRESTON.
--   power = tier * 100 + position (0-99), so a role always ranks inside its tier.
-- Every permission threshold still compares tiers (private.chat_staff_rank),
-- exactly as before. "May act on this person" now compares power, so the owner
-- can place roles above or below each other. The built-in roles are seeded with
-- their current tiers; admin, super_mega_tuff_admin and dusty keep equal power,
-- so nothing changes until the owner creates or reorders roles. Tier-specific
-- rules keep their behaviour: admin-level roles cannot ban, mod-level timeouts
-- stop at two hours. Owner and PRESTON stay fixed and cannot be created.
--
-- Rules: app_settings.community_rules, owner-only through
-- chat_owner_set_app_setting, validated JSON [{title, body}].
--
-- Sticker favorites: public.user_fav_stickers, one row per account, readable
-- and writable only by its owner (same model as user_fav_gifs).
BEGIN;
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------- roles table
CREATE TABLE IF NOT EXISTS public.chat_staff_roles (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9_]{2,40}$'),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 32),
  color text CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
  badge text NOT NULL DEFAULT '' CHECK (badge ~ '^[a-z-]{0,32}$'),
  tier smallint NOT NULL CHECK (tier BETWEEN 1 AND 7),
  power integer NOT NULL,
  builtin boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_staff_roles_power_in_tier CHECK (power BETWEEN tier * 100 AND tier * 100 + 99)
);
INSERT INTO public.chat_staff_roles (slug, label, badge, tier, power, builtin) VALUES
  ('member', 'Member', '', 1, 150, true),
  ('mod', 'Mod', 'mod', 2, 250, true),
  ('manager', 'Manager', 'manager', 3, 350, true),
  ('admin', 'Admin', 'admin', 4, 450, true),
  ('super_mega_tuff_admin', 'Super Mega Tuff Admin', 'super-mega-tuff', 4, 450, true),
  ('dusty', 'Dusty', 'super-mega-tuff', 4, 450, true),
  ('co_owner', 'Co-owner', 'co-owner', 5, 550, true),
  ('owner', 'Owner', 'owner', 6, 650, true),
  ('preston', 'Preston', 'preston', 7, 750, true)
ON CONFLICT (slug) DO NOTHING;
ALTER TABLE public.chat_staff_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_staff_roles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.chat_staff_roles TO authenticated;
DROP POLICY IF EXISTS chat_staff_roles_read ON public.chat_staff_roles;
CREATE POLICY chat_staff_roles_read ON public.chat_staff_roles FOR SELECT TO authenticated
USING ((SELECT private.chat_username()) IS NOT NULL);

-- Tier (permission level). Unknown roles are members.
CREATE OR REPLACE FUNCTION private.chat_staff_rank(p_role text)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT r.tier::integer FROM public.chat_staff_roles r
    WHERE r.slug = lower(coalesce(p_role, 'member'))), 1)
$$;
-- Position for "may act on this person" comparisons.
CREATE OR REPLACE FUNCTION private.chat_staff_power(p_role text)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT r.power FROM public.chat_staff_roles r
    WHERE r.slug = lower(coalesce(p_role, 'member'))), 100)
$$;
REVOKE ALL ON FUNCTION private.chat_staff_power(text) FROM PUBLIC, anon, authenticated;

-- Any catalogued role is valid; the catalog replaces the fixed list.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_staff_role_check;
UPDATE public.profiles SET staff_role = 'member'
WHERE staff_role IS NULL OR staff_role NOT IN (SELECT slug FROM public.chat_staff_roles);
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_staff_role_fkey;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_staff_role_fkey
  FOREIGN KEY (staff_role) REFERENCES public.chat_staff_roles(slug) ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION private.chat_sync_legacy_staff_flags()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'UPDATE'
     and new.staff_role is not distinct from old.staff_role
     and (new.is_owner is distinct from old.is_owner or new.is_admin is distinct from old.is_admin) then
    if new.is_owner then
      new.staff_role := 'owner';
    elsif new.is_admin and private.chat_staff_rank(coalesce(old.staff_role, 'member')) < 4 then
      new.staff_role := 'admin';
    elsif not new.is_admin and private.chat_staff_rank(coalesce(old.staff_role, 'member')) >= 4 then
      new.staff_role := 'member';
    end if;
  end if;

  new.staff_role := lower(coalesce(nullif(pg_catalog.btrim(new.staff_role), ''), 'member'));
  if not exists (select 1 from public.chat_staff_roles r where r.slug = new.staff_role) then
    new.staff_role := 'member';
  end if;
  new.is_owner := (new.staff_role in ('owner', 'preston'));
  new.is_admin := (private.chat_staff_rank(new.staff_role) >= 4);
  return new;
end;
$function$;

-- --------------------------------------------------- role-specific checks
CREATE OR REPLACE FUNCTION private.chat_require_moderation_target(p_actor_username text, p_target_username text, p_min_rank integer, p_action text)
 RETURNS profiles
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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
  IF p_action IN ('ban', 'unban') AND private.chat_staff_rank(v_actor.staff_role) = 4 THEN
    RAISE EXCEPTION 'Admins cannot manage bans';
  END IF;
  SELECT * INTO v_target FROM public.profiles
  WHERE lower(username) = lower(btrim(p_target_username)) FOR UPDATE;
  IF v_target.username IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_target.username = v_actor.username OR v_target.staff_role IN ('owner', 'preston')
     OR private.chat_staff_power(v_actor.staff_role) <= private.chat_staff_power(v_target.staff_role) THEN
    RAISE EXCEPTION 'You can only moderate another account below your rank';
  END IF;
  IF p_action = 'timeout' AND lower(v_target.username) = 'luna' THEN
    RAISE EXCEPTION 'Luna cannot be timed out';
  END IF;
  RETURN v_target;
END;
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
  if private.chat_staff_rank(v_actor.staff_role) = 4 then
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
  if private.chat_staff_rank(v_actor.staff_role) = 4 then
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

  insert into private.chat_admin_audit (actor_username, action, target)
  values (v_actor.username, 'user_unbanned_in_chat', v_target);

  return true;
end;
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

  -- Mod-level roles max 2 hours. Manager level and above any duration (within 7d).
  v_max := CASE WHEN private.chat_staff_rank(v_actor.staff_role) = 2 THEN 120 ELSE 10080 END;
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

CREATE OR REPLACE FUNCTION public.chat_set_staff_role(p_actor_username text, p_actor_password_hash text, p_target_username text, p_role text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_role text := lower(pg_catalog.btrim(coalesce(p_role, 'member')));
  v_old text;
  v_registry text;
BEGIN
  v_actor := private.require_chat_staff_min_rank(5);

  -- Any catalogued role up to co-owner level; owner and PRESTON are never assignable.
  IF NOT EXISTS (SELECT 1 FROM public.chat_staff_roles r WHERE r.slug = v_role AND r.tier <= 5) THEN
    RAISE EXCEPTION 'Invalid staff role';
  END IF;

  -- Lock the actor and target while checking and changing privileges.
  SELECT * INTO v_actor FROM public.profiles
  WHERE username = v_actor.username FOR UPDATE;
  IF coalesce(v_actor.is_banned, false) OR private.chat_staff_rank(v_actor.staff_role) < 5 THEN
    RAISE EXCEPTION 'Insufficient staff permission';
  END IF;

  SELECT * INTO v_target FROM public.profiles
  WHERE lower(username) = lower(pg_catalog.btrim(p_target_username)) FOR UPDATE;

  IF v_target.username IS NULL OR v_target.username = v_actor.username
     OR v_target.staff_role IN ('owner', 'preston') OR coalesce(v_target.is_owner, false) THEN
    RAISE EXCEPTION 'That staff role cannot be changed';
  END IF;
  IF private.chat_staff_power(v_actor.staff_role) <= private.chat_staff_power(v_target.staff_role)
     OR private.chat_staff_power(v_actor.staff_role) <= private.chat_staff_power(v_role) THEN
    RAISE EXCEPTION 'You can only change roles below your rank';
  END IF;

  v_old := v_target.staff_role;
  UPDATE public.profiles SET staff_role = v_role WHERE username = v_target.username;

  -- Keep the registry for older clients, but native staff_role is authoritative.
  PERFORM 1 FROM public.app_settings WHERE key = 'co_owners' FOR UPDATE;
  SELECT coalesce(jsonb_agg(lower(username) ORDER BY lower(username)), '[]'::jsonb)::text
  INTO v_registry FROM public.profiles WHERE staff_role = 'co_owner';
  INSERT INTO public.app_settings (key, value, updated_at)
  VALUES ('co_owners', v_registry, now())
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

  IF v_role = 'member' THEN
    DELETE FROM private.chat_admin_sessions WHERE username = v_target.username;
  END IF;

  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (v_actor.username, 'staff_role_set_in_chat', v_target.username,
          jsonb_build_object('from', v_old, 'to', v_role));
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION private.liminal_drive_rank()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((
    select case
      when p.is_owner or p.is_admin or private.chat_staff_rank(p.staff_role) >= 4 then 3
      when private.chat_staff_rank(p.staff_role) >= 2 then 2
      else 1
    end
    from public.profiles p
    where p.username = (select private.chat_username())
      and not p.is_banned
  ), 0)
$function$;

-- Sticker uploads: admin level and above, by tier instead of a name list.
DROP POLICY IF EXISTS liminal_stickers_staff_insert ON storage.objects;
CREATE POLICY liminal_stickers_staff_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'liminal-stickers'
  AND (storage.foldername(name))[1] = ANY (ARRAY['sticker', 'emoji'])
  AND (storage.foldername(name))[2] = ((SELECT auth.uid()))::text
  AND char_length(name) <= 300
  AND (SELECT private.chat_has_rank(4))
);

-- ------------------------------------------------- owner role management
-- Put a role at the top of its level and shift the others down, keeping ties
-- (equal power) tied.
CREATE OR REPLACE FUNCTION private.chat_staff_role_to_top(p_slug text, p_tier integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_power integer := p_tier * 100 + 99;
BEGIN
  UPDATE public.chat_staff_roles r SET power = p_tier * 100 + 99 - x.place
  FROM (SELECT slug, dense_rank() OVER (ORDER BY power DESC) AS place
        FROM public.chat_staff_roles WHERE tier = p_tier AND slug <> p_slug) x
  WHERE r.slug = x.slug;
  UPDATE public.chat_staff_roles SET power = v_power WHERE slug = p_slug;
  RETURN v_power;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_staff_role_to_top(text, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.chat_save_staff_role(p_slug text, p_label text, p_color text, p_tier integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor public.profiles%rowtype;
  v_label text := btrim(coalesce(p_label, ''));
  v_color text := lower(nullif(btrim(coalesce(p_color, '')), ''));
  v_slug text := lower(nullif(btrim(coalesce(p_slug, '')), ''));
  v_role public.chat_staff_roles%rowtype;
BEGIN
  v_actor := private.require_chat_staff_min_rank(6);
  IF char_length(v_label) NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'Role names are 1 to 32 characters'; END IF;
  IF v_color IS NOT NULL AND v_color !~ '^#[0-9a-f]{6}$' THEN RAISE EXCEPTION 'Choose a colour like #a855f7'; END IF;

  IF v_slug IS NULL THEN
    IF p_tier IS NULL OR p_tier NOT BETWEEN 2 AND 5 THEN
      RAISE EXCEPTION 'Choose Mod, Manager, Admin or Co-owner permissions';
    END IF;
    IF (SELECT count(*) FROM public.chat_staff_roles WHERE NOT builtin) >= 40 THEN
      RAISE EXCEPTION 'You can create up to 40 roles';
    END IF;
    IF EXISTS (SELECT 1 FROM public.chat_staff_roles WHERE lower(label) = lower(v_label)) THEN
      RAISE EXCEPTION 'A role with that name already exists';
    END IF;
    -- New roles start at the top of their level.
    INSERT INTO public.chat_staff_roles (slug, label, color, tier, power, builtin, created_by)
    VALUES ('r_' || substr(md5(gen_random_uuid()::text), 1, 12), v_label, v_color, p_tier, p_tier * 100, false, v_actor.username)
    RETURNING * INTO v_role;
    PERFORM private.chat_staff_role_to_top(v_role.slug, p_tier);
    SELECT * INTO v_role FROM public.chat_staff_roles WHERE slug = v_role.slug;
  ELSE
    SELECT * INTO v_role FROM public.chat_staff_roles WHERE slug = v_slug FOR UPDATE;
    IF v_role.slug IS NULL THEN RAISE EXCEPTION 'Role not found'; END IF;
    IF v_role.slug IN ('owner', 'preston', 'member') THEN RAISE EXCEPTION 'That role cannot be edited'; END IF;
    IF EXISTS (SELECT 1 FROM public.chat_staff_roles WHERE lower(label) = lower(v_label) AND slug <> v_role.slug) THEN
      RAISE EXCEPTION 'A role with that name already exists';
    END IF;
    IF p_tier IS NOT NULL AND p_tier <> v_role.tier THEN
      IF v_role.builtin THEN RAISE EXCEPTION 'Built-in roles keep their permission level'; END IF;
      IF p_tier NOT BETWEEN 2 AND 5 THEN RAISE EXCEPTION 'Choose Mod, Manager, Admin or Co-owner permissions'; END IF;
      UPDATE public.chat_staff_roles SET tier = p_tier, power = p_tier * 100 WHERE slug = v_role.slug;
      PERFORM private.chat_staff_role_to_top(v_role.slug, p_tier);
    END IF;
    UPDATE public.chat_staff_roles SET label = v_label, color = v_color, updated_at = now()
    WHERE slug = v_role.slug RETURNING * INTO v_role;
    -- Legacy admin flags follow the new level.
    UPDATE public.profiles SET staff_role = staff_role WHERE staff_role = v_role.slug;
  END IF;

  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (v_actor.username, 'staff_role_saved', v_role.slug,
          jsonb_build_object('label', v_role.label, 'tier', v_role.tier, 'power', v_role.power));
  RETURN to_jsonb(v_role);
END;
$$;

-- Order every mod..co-owner role, highest first. Levels must stay grouped and
-- descending; positions inside each level follow the given order.
CREATE OR REPLACE FUNCTION public.chat_reorder_staff_roles(p_slugs text[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor public.profiles%rowtype;
  v_expected text[];
  v_tier integer;
  v_prev integer := 99;
  v_index integer := 0;
  v_slug text;
BEGIN
  v_actor := private.require_chat_staff_min_rank(6);
  PERFORM 1 FROM public.chat_staff_roles WHERE tier BETWEEN 2 AND 5 FOR UPDATE;
  SELECT array_agg(slug ORDER BY slug) INTO v_expected FROM public.chat_staff_roles WHERE tier BETWEEN 2 AND 5;
  IF p_slugs IS NULL OR (SELECT array_agg(s ORDER BY s) FROM (SELECT DISTINCT lower(s) s FROM unnest(p_slugs) s) x) IS DISTINCT FROM v_expected
     OR cardinality(p_slugs) <> cardinality(v_expected) THEN
    RAISE EXCEPTION 'Send every staff role exactly once';
  END IF;
  FOREACH v_slug IN ARRAY p_slugs LOOP
    SELECT tier INTO v_tier FROM public.chat_staff_roles WHERE slug = lower(v_slug);
    IF v_tier > v_prev THEN RAISE EXCEPTION 'Keep higher permission levels above lower ones'; END IF;
    IF v_tier < v_prev THEN v_index := 0; v_prev := v_tier; END IF;
    UPDATE public.chat_staff_roles SET power = v_tier * 100 + 99 - v_index, updated_at = now() WHERE slug = lower(v_slug);
    v_index := v_index + 1;
  END LOOP;
  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (v_actor.username, 'staff_roles_reordered', 'roles', jsonb_build_object('order', to_jsonb(p_slugs)));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_delete_staff_role(p_slug text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor public.profiles%rowtype;
  v_role public.chat_staff_roles%rowtype;
  v_holders integer;
BEGIN
  v_actor := private.require_chat_staff_min_rank(6);
  SELECT * INTO v_role FROM public.chat_staff_roles WHERE slug = lower(btrim(coalesce(p_slug, ''))) FOR UPDATE;
  IF v_role.slug IS NULL THEN RAISE EXCEPTION 'Role not found'; END IF;
  IF v_role.builtin THEN RAISE EXCEPTION 'Built-in roles cannot be deleted'; END IF;
  -- Holders become members and lose any dashboard session.
  DELETE FROM private.chat_admin_sessions WHERE username IN (SELECT username FROM public.profiles WHERE staff_role = v_role.slug);
  UPDATE public.profiles SET staff_role = 'member' WHERE staff_role = v_role.slug;
  GET DIAGNOSTICS v_holders = ROW_COUNT;
  DELETE FROM public.chat_staff_roles WHERE slug = v_role.slug;
  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (v_actor.username, 'staff_role_deleted', v_role.slug, jsonb_build_object('label', v_role.label, 'holders', v_holders));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_save_staff_role(text, text, text, integer), public.chat_reorder_staff_roles(text[]),
  public.chat_delete_staff_role(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_save_staff_role(text, text, text, integer), public.chat_reorder_staff_roles(text[]),
  public.chat_delete_staff_role(text) TO authenticated;

-- Live role catalog updates reach every member.
DO $rt$
BEGIN
  IF to_regprocedure('private.chat_rt_public_row()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS zz_chat_rt_broadcast ON public.chat_staff_roles;
    CREATE TRIGGER zz_chat_rt_broadcast AFTER INSERT OR UPDATE OR DELETE ON public.chat_staff_roles
      FOR EACH ROW EXECUTE FUNCTION private.chat_rt_public_row();
  END IF;
END;
$rt$;

-- ------------------------------------------------------------------ rules
CREATE OR REPLACE FUNCTION public.chat_owner_set_app_setting(p_key text, p_value text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor text;
  v_value text := coalesce(p_value, '');
  v_json jsonb;
begin
  if not private.chat_is_staff(true) then
    raise exception 'Owner access is required';
  end if;

  if p_key not in ('app_enabled', 'announcement', 'whats_new', 'co_owners', 'community_rules') then
    raise exception 'Unsupported owner setting';
  end if;

  if p_key = 'app_enabled' and v_value not in ('true', 'false') then
    raise exception 'App enabled must be true or false';
  elsif p_key = 'announcement' and char_length(v_value) > 300 then
    raise exception 'Announcement is too long';
  elsif p_key = 'whats_new' and char_length(v_value) > 4000 then
    raise exception 'What''s new is too long';
  elsif p_key = 'community_rules' then
    -- An empty value restores the built-in rules in Chat.
    if v_value <> '' then
      if char_length(v_value) > 30000 then raise exception 'The rules are too long'; end if;
      begin
        v_json := v_value::jsonb;
      exception when others then
        raise exception 'Rules must be a list';
      end;
      if jsonb_typeof(v_json) <> 'array' or jsonb_array_length(v_json) NOT BETWEEN 1 AND 30 then
        raise exception 'Add between 1 and 30 rules';
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_json) item
        where jsonb_typeof(item) <> 'object'
           or jsonb_typeof(item->'title') is distinct from 'string'
           or jsonb_typeof(item->'body') is distinct from 'string'
           or char_length(btrim(item->>'title')) NOT BETWEEN 1 AND 80
           or char_length(btrim(item->>'body')) NOT BETWEEN 1 AND 1000
      ) then
        raise exception 'Each rule needs a title (up to 80 characters) and text (up to 1000)';
      end if;
      select jsonb_agg(jsonb_build_object('title', btrim(e.item->>'title'), 'body', btrim(e.item->>'body')) order by e.ord)::text
      into v_value
      from jsonb_array_elements(v_json) with ordinality e(item, ord);
    end if;
  elsif p_key = 'co_owners' then
    if char_length(v_value) > 10000 then
      raise exception 'Co-owner registry is too large';
    end if;
    begin
      v_json := v_value::jsonb;
    exception when others then
      raise exception 'Co-owner registry must be valid JSON';
    end;
    if jsonb_typeof(v_json) <> 'array'
       or exists (
         select 1
         from jsonb_array_elements(v_json) item
         where jsonb_typeof(item) <> 'string'
            or trim(both '"' from item::text) !~ '^[A-Za-z0-9_]{1,40}$'
       ) then
      raise exception 'Co-owner registry must be an array of usernames';
    end if;
    select coalesce(jsonb_agg(distinct lower(value) order by lower(value)), '[]'::jsonb)::text
    into v_value
    from jsonb_array_elements_text(v_json) entry(value);
  end if;

  v_actor := private.chat_username();

  insert into public.app_settings (key, value, updated_at)
  values (p_key, v_value, now())
  on conflict (key) do update
    set value = excluded.value,
        updated_at = excluded.updated_at;

  insert into private.chat_admin_audit (actor_username, action, target, details)
  values (v_actor, 'owner_setting_updated', p_key, jsonb_build_object('length', char_length(v_value)));

  return true;
end;
$function$;

-- ------------------------------------------------------ sticker favorites
CREATE TABLE IF NOT EXISTS public.user_fav_stickers (
  username text PRIMARY KEY REFERENCES public.profiles(username) ON UPDATE CASCADE ON DELETE CASCADE,
  stickers jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(stickers) = 'array' AND jsonb_array_length(stickers) <= 300 AND pg_column_size(stickers) <= 65536),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_fav_stickers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_fav_stickers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_fav_stickers TO authenticated;
DROP POLICY IF EXISTS fav_stickers_self_read ON public.user_fav_stickers;
DROP POLICY IF EXISTS fav_stickers_self_insert ON public.user_fav_stickers;
DROP POLICY IF EXISTS fav_stickers_self_update ON public.user_fav_stickers;
CREATE POLICY fav_stickers_self_read ON public.user_fav_stickers FOR SELECT TO authenticated
  USING (username = (SELECT private.chat_username()));
CREATE POLICY fav_stickers_self_insert ON public.user_fav_stickers FOR INSERT TO authenticated
  WITH CHECK (username = (SELECT private.chat_username()));
CREATE POLICY fav_stickers_self_update ON public.user_fav_stickers FOR UPDATE TO authenticated
  USING (username = (SELECT private.chat_username())) WITH CHECK (username = (SELECT private.chat_username()));

COMMIT;
NOTIFY pgrst, 'reload schema';
