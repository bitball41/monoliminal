-- Subroles stay cosmetic. Co-owners and owners edit the catalog (name and color).
-- Anyone signed in can wear one that already exists. Neither path changes staff rank.
BEGIN;

CREATE TABLE IF NOT EXISTS public.chat_subroles (
  slug text PRIMARY KEY,
  label text NOT NULL,
  color text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT chat_subroles_slug_check CHECK (slug ~ '^[a-z0-9_]{1,32}$'),
  CONSTRAINT chat_subroles_label_check CHECK (char_length(btrim(label)) BETWEEN 1 AND 24),
  CONSTRAINT chat_subroles_color_check CHECK (color ~ '^#[0-9a-f]{6}$')
);

INSERT INTO public.chat_subroles (slug, label, color, position)
VALUES
  ('developer', 'Developer', '#22d3ee', 1),
  ('artist', 'Artist', '#f472b6', 2),
  ('musician', 'Musician', '#a78bfa', 3),
  ('writer', 'Writer', '#fbbf24', 4),
  ('creator', 'Creator', '#fb923c', 5),
  ('translator', 'Translator', '#38bdf8', 6),
  ('bug_hunter', 'Bug Hunter', '#4ade80', 7),
  ('event_host', 'Event Host', '#fb7185', 8)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_sub_role_check;

ALTER TABLE public.chat_subroles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.chat_subroles TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.chat_subroles FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS chat_subroles_read ON public.chat_subroles;
CREATE POLICY chat_subroles_read ON public.chat_subroles
  FOR SELECT TO authenticated
  USING ((SELECT private.chat_username()) IS NOT NULL);

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
  v_actor := private.require_chat_staff_min_rank(2);
  IF v_role <> '' AND NOT EXISTS (SELECT 1 FROM public.chat_subroles WHERE slug = v_role) THEN
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

CREATE OR REPLACE FUNCTION public.chat_set_own_subrole(p_sub_role text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor text := private.chat_username();
  v_role text := lower(pg_catalog.btrim(coalesce(p_sub_role, '')));
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Active account required';
  END IF;
  IF v_role <> '' AND NOT EXISTS (SELECT 1 FROM public.chat_subroles WHERE slug = v_role) THEN
    RAISE EXCEPTION 'That subrole does not exist';
  END IF;
  UPDATE public.profiles SET sub_role = v_role WHERE username = v_actor;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.chat_save_subrole(p_slug text, p_label text, p_color text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_slug text := lower(pg_catalog.btrim(coalesce(p_slug, '')));
  v_label text := pg_catalog.btrim(coalesce(p_label, ''));
  v_color text := lower(pg_catalog.btrim(coalesce(p_color, '')));
  v_base text;
  v_n integer := 2;
  v_position integer;
BEGIN
  v_actor := private.require_chat_staff_min_rank(5);
  IF char_length(v_label) < 1 OR char_length(v_label) > 24 THEN
    RAISE EXCEPTION 'Subrole names are 1 to 24 characters';
  END IF;
  IF v_color !~ '^#[0-9a-f]{6}$' THEN
    RAISE EXCEPTION 'Pick a hex color';
  END IF;

  IF v_slug <> '' THEN
    IF v_slug !~ '^[a-z0-9_]{1,32}$' OR NOT EXISTS (SELECT 1 FROM public.chat_subroles WHERE slug = v_slug) THEN
      RAISE EXCEPTION 'That subrole does not exist';
    END IF;
    UPDATE public.chat_subroles SET label = v_label, color = v_color WHERE slug = v_slug;
  ELSE
    v_slug := pg_catalog.btrim(pg_catalog.regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g'), '_');
    v_slug := left(v_slug, 32);
    IF v_slug = '' OR v_slug !~ '^[a-z0-9_]{1,32}$' THEN
      RAISE EXCEPTION 'Pick a name with letters or numbers';
    END IF;
    v_base := v_slug;
    WHILE EXISTS (SELECT 1 FROM public.chat_subroles WHERE slug = v_slug) LOOP
      v_slug := left(v_base, 28) || '_' || v_n::text;
      v_n := v_n + 1;
      IF v_n > 50 THEN
        RAISE EXCEPTION 'Too many subroles with that name';
      END IF;
    END LOOP;
    SELECT coalesce(max(position), 0) + 1 INTO v_position FROM public.chat_subroles;
    INSERT INTO public.chat_subroles (slug, label, color, position, created_by)
    VALUES (v_slug, v_label, v_color, v_position, v_actor.username);
  END IF;

  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (
    v_actor.username,
    'subrole_catalog_saved',
    v_slug,
    pg_catalog.jsonb_build_object('label', v_label, 'color', v_color)
  );
  RETURN v_slug;
END;
$function$;

CREATE OR REPLACE FUNCTION public.chat_delete_subrole(p_slug text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_slug text := lower(pg_catalog.btrim(coalesce(p_slug, '')));
BEGIN
  v_actor := private.require_chat_staff_min_rank(5);
  IF v_slug = '' OR NOT EXISTS (SELECT 1 FROM public.chat_subroles WHERE slug = v_slug) THEN
    RAISE EXCEPTION 'That subrole does not exist';
  END IF;
  UPDATE public.profiles SET sub_role = '' WHERE sub_role = v_slug;
  DELETE FROM public.chat_subroles WHERE slug = v_slug;
  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (v_actor.username, 'subrole_catalog_deleted', v_slug, '{}'::jsonb);
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.chat_set_own_subrole(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_save_subrole(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_delete_subrole(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_set_own_subrole(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_save_subrole(text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_delete_subrole(text) TO authenticated, service_role;

DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_subroles'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_subroles;
  END IF;
END
$pub$;

NOTIFY pgrst, 'reload schema';

COMMIT;
