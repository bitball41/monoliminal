-- Phoenix (@kirk) and the Super Mega Tuff Co-owner (@PomKnee) are equals.
-- Owner decision by Conno, final: "same rank ... don't make it less or above,
-- they are equals." Replaces 20261118135935 (Phoenix below the Super Mega Tuff
-- Co-owner).
--
--   * Ladder: Owner and PRESTON, then Phoenix and Super Mega Tuff Co-owner
--     tied on one step, then every other role. Reordering or creating roles
--     keeps them tied on top. Neither can moderate the other (only Conno can
--     moderate either).
--   * Troll menus are unchanged here: 20261118142342 already gives Kirk the
--     full menu, the same as PomKnee and Conno, and Kirk keeps troll protection.
BEGIN;
SET LOCAL lock_timeout = '2s';

-- ------------------------------------------------ ladder: equals on top
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
  -- Owner decision: Phoenix and the Super Mega Tuff Co-owner are equals. Both
  -- share the top step; never put one above the other.
  SELECT coalesce(array_agg(t), '{}') INTO v_top
  FROM unnest(ARRAY['super_mega_tuff_co_owner', 'phoenix']) t WHERE t = ANY (v_order);
  IF cardinality(v_top) > 0 THEN
    v_power := 599;
    UPDATE public.chat_staff_roles SET power = v_power, updated_at = now() WHERE slug = ANY (v_top);
  END IF;
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
