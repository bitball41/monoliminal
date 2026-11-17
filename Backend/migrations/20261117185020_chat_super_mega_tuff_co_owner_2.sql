-- Super Mega Tuff Co-owner, part 2.
--
--   * The role is pinned to the top of the staff ladder, above every custom
--     role (God Tier included). Only Owner and PRESTON sit above it. Reordering
--     or creating roles keeps it first.
--   * Its holder can style their own check mark (any short emoji or text,
--     1-4 colours, an animation). Stored in app_settings.smt_check, which every
--     member already reads, so everyone sees it.
--   * Trolls: rainbow, comic_sans, blur and no_cursor are replaced by
--     reverse_mouse, backwards_typing, auto_refresh and runaway_buttons, and a
--     one-shot "refresh their page now".
-- Clearing their own timeout already works through chat_staff_timeout_user
-- (the role clears anyone's timeout, itself included).
BEGIN;
SET LOCAL lock_timeout = '2s';

-- ------------------------------------------------------ top of the ladder
CREATE OR REPLACE FUNCTION private.chat_staff_apply_ladder(p_order text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_expected text[];
  v_given text[];
  v_order text[];
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
  -- The Super Mega Tuff Co-owner always comes first.
  SELECT array_agg(lower(s) ORDER BY i) INTO v_order FROM unnest(p_order) WITH ORDINALITY u(s, i);
  IF 'super_mega_tuff_co_owner' = ANY (v_order) THEN
    v_order := ARRAY['super_mega_tuff_co_owner'] || array_remove(v_order, 'super_mega_tuff_co_owner');
  END IF;
  FOREACH v_slug IN ARRAY v_order LOOP
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

-- ------------------------------------------------------- custom check mark
CREATE OR REPLACE FUNCTION public.chat_set_smt_check(p_symbol text, p_colors text[], p_animation text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_symbol text := btrim(coalesce(p_symbol, ''));
  v_colors text[];
  v_value text;
BEGIN
  IF NOT private.chat_is_super_mega_tuff() THEN
    RAISE EXCEPTION 'Only the Super Mega Tuff Co-owner can change this check mark';
  END IF;
  IF p_colors IS NULL AND p_symbol IS NULL AND p_animation IS NULL THEN
    v_value := '';
  ELSE
    IF char_length(v_symbol) > 8 OR v_symbol ~ '[<>&"''`\\[:cntrl:]]' THEN
      RAISE EXCEPTION 'Use up to 8 characters, like an emoji';
    END IF;
    SELECT array_agg(lower(c) ORDER BY i) INTO v_colors FROM unnest(coalesce(p_colors, '{}')) WITH ORDINALITY u(c, i);
    IF v_colors IS NULL OR cardinality(v_colors) NOT BETWEEN 1 AND 4
       OR EXISTS (SELECT 1 FROM unnest(v_colors) c WHERE c IS NULL OR c !~ '^#[0-9a-f]{6}$') THEN
      RAISE EXCEPTION 'Pick 1 to 4 colours like #a855f7';
    END IF;
    IF coalesce(p_animation, '') NOT IN ('spin', 'pulse', 'bounce', 'none') THEN
      RAISE EXCEPTION 'Choose spin, pulse, bounce or none';
    END IF;
    v_value := jsonb_build_object('symbol', v_symbol, 'colors', to_jsonb(v_colors), 'animation', p_animation)::text;
  END IF;
  INSERT INTO public.app_settings (key, value, updated_at) VALUES ('smt_check', v_value, now())
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (private.chat_username(), 'smt_check_updated', 'smt_check', jsonb_build_object('length', char_length(v_value)));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_set_smt_check(text, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_set_smt_check(text, text[], text) TO authenticated;

-- ------------------------------------------------------------- new trolls
DELETE FROM private.chat_troll_effects WHERE effect IN ('rainbow', 'comic_sans', 'blur', 'no_cursor');
ALTER TABLE private.chat_troll_effects DROP CONSTRAINT IF EXISTS chat_troll_effects_effect_check;
ALTER TABLE private.chat_troll_effects ADD CONSTRAINT chat_troll_effects_effect_check CHECK (effect IN (
  'fail_send', 'popups', 'upside_down', 'mirror', 'shake', 'emoji_rain',
  'reverse_mouse', 'backwards_typing', 'auto_refresh', 'runaway_buttons'));

-- Who may be trolled: anyone but yourself, the owner, PRESTON, bots and banned accounts.
CREATE OR REPLACE FUNCTION private.chat_troll_target(p_target text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_target public.profiles%rowtype;
BEGIN
  IF NOT private.chat_is_super_mega_tuff() THEN
    RAISE EXCEPTION 'Only the Super Mega Tuff Co-owner can troll';
  END IF;
  SELECT * INTO v_target FROM public.profiles WHERE lower(username) = lower(btrim(coalesce(p_target, '')));
  IF v_target.username IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_target.username = private.chat_username() THEN RAISE EXCEPTION 'You cannot troll yourself'; END IF;
  IF v_target.staff_role IN ('owner', 'preston') THEN RAISE EXCEPTION 'The owner and PRESTON cannot be trolled'; END IF;
  IF lower(v_target.username) IN ('luna', 'quotebot') THEN RAISE EXCEPTION 'Bots cannot be trolled'; END IF;
  IF v_target.is_banned THEN RAISE EXCEPTION 'That account is banned'; END IF;
  RETURN v_target.username;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_troll_target(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.chat_troll_apply(p_target text, p_effects text[], p_minutes integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor text := private.chat_username();
  v_target text;
  v_effects text[];
BEGIN
  v_target := private.chat_troll_target(p_target);
  IF p_minutes IS NULL OR p_minutes NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Trolls last between 1 and 60 minutes';
  END IF;
  SELECT array_agg(DISTINCT e) INTO v_effects FROM unnest(coalesce(p_effects, '{}')) e;
  IF v_effects IS NULL OR cardinality(v_effects) > 10 THEN
    RAISE EXCEPTION 'Pick at least one troll';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_effects) e WHERE e IS NULL OR e NOT IN ('fail_send', 'popups', 'upside_down',
      'mirror', 'shake', 'emoji_rain', 'reverse_mouse', 'backwards_typing', 'auto_refresh', 'runaway_buttons')) THEN
    RAISE EXCEPTION 'Unknown troll';
  END IF;

  DELETE FROM private.chat_troll_effects WHERE expires_at <= now();
  INSERT INTO private.chat_troll_effects (target, effect, expires_at, created_by)
  SELECT v_target, e, now() + make_interval(mins => p_minutes), v_actor FROM unnest(v_effects) e
  ON CONFLICT (target, effect) DO UPDATE
    SET expires_at = excluded.expires_at, created_by = excluded.created_by, created_at = now();

  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (v_actor, 'troll_applied', v_target, jsonb_build_object('effects', to_jsonb(v_effects), 'minutes', p_minutes));
  PERFORM private.chat_troll_broadcast(v_target);
  RETURN private.chat_troll_effects_of(v_target);
END;
$$;

-- One-shot: reload the target's Chat right now.
CREATE OR REPLACE FUNCTION public.chat_troll_refresh(p_target text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_target text;
BEGIN
  v_target := private.chat_troll_target(p_target);
  INSERT INTO private.chat_admin_audit (actor_username, action, target)
  VALUES (private.chat_username(), 'troll_refresh', v_target);
  PERFORM private.chat_rt_send(private.chat_rt_user_topics(ARRAY[v_target]), 'troll_refresh',
    jsonb_build_object('at', now()));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_troll_refresh(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_troll_refresh(text) TO authenticated;

COMMIT;
