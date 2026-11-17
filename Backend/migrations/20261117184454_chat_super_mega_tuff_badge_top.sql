-- Super Mega Tuff Co-owner, part 2.
--
-- * Top of the staff ladder: the role always sits above every other staff
--   role (God Tier included), below Owner and PRESTON. Any reorder keeps it
--   first, so a later custom role cannot be placed above it.
-- * Custom check mark: the role holder (or the owner) picks the badge's
--   symbol (an emoji or up to a few characters), its two colours and whether
--   it spins. Stored on the role row, so every Chat updates live through the
--   existing catalog broadcast. Rendered as text, never HTML.
-- * Clearing their own timeout already works through chat_staff_timeout_user
--   (part 1); Chat now shows the button.
BEGIN;
SET LOCAL lock_timeout = '2s';

-- ------------------------------------------------------------ badge style
ALTER TABLE public.chat_staff_roles
  ADD COLUMN IF NOT EXISTS icon text,
  ADD COLUMN IF NOT EXISTS color2 text,
  ADD COLUMN IF NOT EXISTS badge_spin boolean NOT NULL DEFAULT true;
ALTER TABLE public.chat_staff_roles DROP CONSTRAINT IF EXISTS chat_staff_roles_icon_check;
ALTER TABLE public.chat_staff_roles ADD CONSTRAINT chat_staff_roles_icon_check CHECK (
  icon IS NULL OR (char_length(icon) BETWEEN 1 AND 8 AND octet_length(icon) <= 32
    AND icon !~ '[<>&"''`\\[:cntrl:][:space:]]'));
ALTER TABLE public.chat_staff_roles DROP CONSTRAINT IF EXISTS chat_staff_roles_color2_check;
ALTER TABLE public.chat_staff_roles ADD CONSTRAINT chat_staff_roles_color2_check CHECK (
  color2 IS NULL OR color2 ~ '^#[0-9a-f]{6}$');

CREATE OR REPLACE FUNCTION public.chat_set_super_mega_tuff_badge(p_icon text, p_color text, p_color2 text, p_spin boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_icon text := nullif(btrim(coalesce(p_icon, '')), '');
  v_color text := lower(nullif(btrim(coalesce(p_color, '')), ''));
  v_color2 text := lower(nullif(btrim(coalesce(p_color2, '')), ''));
  v_role public.chat_staff_roles%rowtype;
BEGIN
  IF NOT (private.chat_is_super_mega_tuff() OR private.chat_is_staff(true)) THEN
    RAISE EXCEPTION 'Only the Super Mega Tuff Co-owner can change this check mark';
  END IF;
  IF v_icon IS NOT NULL AND (char_length(v_icon) > 8 OR octet_length(v_icon) > 32
     OR v_icon ~ '[<>&"''`\\[:cntrl:][:space:]]') THEN
    RAISE EXCEPTION 'Use an emoji or up to a few characters, without spaces or < > & quotes';
  END IF;
  IF (v_color IS NOT NULL AND v_color !~ '^#[0-9a-f]{6}$') OR (v_color2 IS NOT NULL AND v_color2 !~ '^#[0-9a-f]{6}$') THEN
    RAISE EXCEPTION 'Choose colours like #a855f7';
  END IF;
  UPDATE public.chat_staff_roles
  SET icon = v_icon, color = v_color, color2 = v_color2, badge_spin = coalesce(p_spin, true), updated_at = now()
  WHERE slug = 'super_mega_tuff_co_owner' RETURNING * INTO v_role;
  IF v_role.slug IS NULL THEN RAISE EXCEPTION 'Role not found'; END IF;
  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (private.chat_username(), 'staff_badge_styled', v_role.slug,
          jsonb_build_object('icon', v_icon, 'color', v_color, 'color2', v_color2, 'spin', v_role.badge_spin));
  RETURN to_jsonb(v_role);
END;
$$;
REVOKE ALL ON FUNCTION public.chat_set_super_mega_tuff_badge(text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_set_super_mega_tuff_badge(text, text, text, boolean) TO authenticated;

-- ------------------------------------------------------- always on top
-- Same as before, except the Super Mega Tuff Co-owner is moved to the front
-- of any order and never ties with the role below it.
CREATE OR REPLACE FUNCTION private.chat_staff_apply_ladder(p_order text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_expected text[];
  v_given text[];
  v_slug text;
  v_old integer;
  v_prev_old integer;
  v_power integer := 600;
  v_top constant text := 'super_mega_tuff_co_owner';
BEGIN
  PERFORM 1 FROM public.chat_staff_roles WHERE slug NOT IN ('member', 'owner', 'preston') FOR UPDATE;
  SELECT array_agg(slug ORDER BY slug) INTO v_expected FROM public.chat_staff_roles WHERE slug NOT IN ('member', 'owner', 'preston');
  SELECT array_agg(s ORDER BY s) INTO v_given FROM (SELECT DISTINCT lower(s) s FROM unnest(p_order) s) x;
  IF p_order IS NULL OR v_given IS DISTINCT FROM v_expected OR cardinality(p_order) <> cardinality(v_expected) THEN
    RAISE EXCEPTION 'Send every staff role exactly once';
  END IF;
  IF cardinality(p_order) > 498 THEN RAISE EXCEPTION 'Too many roles'; END IF;
  IF v_top = ANY (v_expected) THEN
    SELECT ARRAY[v_top] || coalesce(array_agg(s ORDER BY i), '{}') INTO p_order
    FROM unnest(p_order) WITH ORDINALITY u(s, i) WHERE lower(s) <> v_top;
  END IF;
  FOREACH v_slug IN ARRAY p_order LOOP
    SELECT power INTO v_old FROM public.chat_staff_roles WHERE slug = lower(v_slug);
    IF v_prev_old IS NULL OR v_old IS DISTINCT FROM v_prev_old THEN v_power := v_power - 1; END IF;
    -- Nothing ties with the top role.
    v_prev_old := CASE WHEN lower(v_slug) = v_top THEN NULL ELSE v_old END;
    UPDATE public.chat_staff_roles SET power = v_power, updated_at = now() WHERE slug = lower(v_slug);
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION private.chat_staff_apply_ladder(text[]) FROM PUBLIC, anon, authenticated;

-- Move it to the top now, keeping everyone else's order and ties.
DO $$
DECLARE v_order text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chat_staff_roles WHERE slug = 'super_mega_tuff_co_owner') THEN RETURN; END IF;
  SELECT array_agg(slug ORDER BY power DESC, slug) INTO v_order
  FROM public.chat_staff_roles WHERE slug NOT IN ('member', 'owner', 'preston');
  PERFORM private.chat_staff_apply_ladder(v_order);
END $$;

COMMIT;
