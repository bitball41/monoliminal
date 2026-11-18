-- Phoenix (@kirk) sits directly below the Super Mega Tuff Co-owner (@PomKnee).
--
-- 20261118032602_chat_phoenix_role tied the two roles at the top of the staff
-- ladder. Conno wants the Super Mega Tuff Co-owner above Phoenix:
--   Owner > Super Mega Tuff Co-owner > Phoenix > every other staff role.
-- Reordering or creating roles keeps that order. Nothing else about either
-- role changes: only Conno can moderate either holder, and neither can
-- moderate the other. The troll menu is still chosen by exact username (see
-- AGENTS.md "Troll menu access"); Kirk has the Kirk menu.
--
-- Where Phoenix is stored: the role is the row slug = 'phoenix' in
-- public.chat_staff_roles (label, badge 'phoenix', tier 5, power); Kirk holds
-- it through public.profiles.staff_role = 'phoenix' on username 'kirk'; his
-- check mark is app_settings.phoenix_check.
BEGIN;
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION private.chat_staff_apply_ladder(p_order text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_expected text[];
  v_given text[];
  v_order text[];
  v_top text[];
  v_slug text;
  v_old integer;
  v_prev_old integer;
  v_power integer := 600;
BEGIN
  PERFORM 1 FROM public.chat_staff_roles WHERE slug NOT IN ('member', 'owner', 'preston') FOR UPDATE;
  SELECT array_agg(slug ORDER BY slug) INTO v_expected FROM public.chat_staff_roles WHERE slug NOT IN ('member', 'owner', 'preston');
  SELECT array_agg(s ORDER BY s) INTO v_given FROM (SELECT DISTINCT lower(s) s FROM unnest(p_order) s) x;
  IF p_order IS NULL OR v_given IS DISTINCT FROM v_expected OR cardinality(p_order) <> cardinality(v_expected) THEN
    RAISE EXCEPTION 'Send every staff role exactly once';
  END IF;
  IF cardinality(p_order) > 498 THEN RAISE EXCEPTION 'Too many roles'; END IF;
  SELECT array_agg(lower(s) ORDER BY i) INTO v_order FROM unnest(p_order) WITH ORDINALITY u(s, i);
  -- Fixed top, in this order: Super Mega Tuff Co-owner, then Phoenix.
  SELECT coalesce(array_agg(t ORDER BY n), '{}') INTO v_top
  FROM unnest(ARRAY['super_mega_tuff_co_owner', 'phoenix']) WITH ORDINALITY u(t, n) WHERE t = ANY (v_order);
  FOREACH v_slug IN ARRAY v_top LOOP
    v_power := v_power - 1;
    UPDATE public.chat_staff_roles SET power = v_power, updated_at = now() WHERE slug = v_slug;
  END LOOP;
  -- Everything else below them, in the order given; neighbours that were tied stay tied.
  FOREACH v_slug IN ARRAY v_order LOOP
    CONTINUE WHEN v_slug = ANY (v_top);
    SELECT power INTO v_old FROM public.chat_staff_roles WHERE slug = v_slug;
    IF v_prev_old IS NULL OR v_old IS DISTINCT FROM v_prev_old THEN v_power := v_power - 1; END IF;
    v_prev_old := v_old;
    UPDATE public.chat_staff_roles SET power = v_power, updated_at = now() WHERE slug = v_slug;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_staff_apply_ladder(text[]) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_order text[];
BEGIN
  SELECT array_agg(slug ORDER BY power DESC, slug) INTO v_order
  FROM public.chat_staff_roles WHERE slug NOT IN ('member', 'owner', 'preston');
  PERFORM private.chat_staff_apply_ladder(v_order);
END $$;

COMMIT;
