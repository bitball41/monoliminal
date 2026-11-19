-- Badge styles: the Owner role can restyle its badge too, with more effects
-- and shapes for everyone who has the editor.
--
-- Who can style which badge (each in its own app_settings key, shown to
-- everyone live):
--   * Super Mega Tuff Co-owner -> smt_check
--   * Phoenix                  -> phoenix_check
--   * Owner                    -> owner_check
-- Options: symbol (emoji or up to 8 characters), 1-4 colours, an effect and a
-- shape. chat_set_smt_check (symbol, colours, effect) still works for pages
-- that haven't updated; it keeps the badge's current shape.
BEGIN;
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION public.chat_set_badge_style(p_symbol text, p_colors text[], p_animation text, p_shape text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_me public.profiles%rowtype;
  v_symbol text := btrim(coalesce(p_symbol, ''));
  v_colors text[];
  v_value text;
  v_key text;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE user_id = auth.uid();
  IF v_me.username IS NULL OR v_me.is_banned THEN RAISE EXCEPTION 'Active account required'; END IF;
  v_key := CASE v_me.staff_role WHEN 'super_mega_tuff_co_owner' THEN 'smt_check'
                                WHEN 'phoenix' THEN 'phoenix_check'
                                WHEN 'owner' THEN 'owner_check' END;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Only the Owner, the Super Mega Tuff Co-owner or Phoenix can change this badge';
  END IF;
  IF p_colors IS NULL AND p_symbol IS NULL AND p_animation IS NULL AND p_shape IS NULL THEN
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
    IF coalesce(p_animation, '') NOT IN ('none', 'spin', 'pulse', 'bounce', 'shake', 'wobble', 'flip',
        'float', 'heartbeat', 'glow', 'rainbow', 'blink') THEN
      RAISE EXCEPTION 'Unknown badge effect';
    END IF;
    IF coalesce(p_shape, 'burst') NOT IN ('burst', 'circle', 'square', 'star', 'heart', 'diamond',
        'shield', 'hexagon', 'plain') THEN
      RAISE EXCEPTION 'Unknown badge shape';
    END IF;
    v_value := jsonb_build_object('symbol', v_symbol, 'colors', to_jsonb(v_colors),
      'animation', p_animation, 'shape', coalesce(p_shape, 'burst'))::text;
  END IF;
  INSERT INTO public.app_settings (key, value, updated_at) VALUES (v_key, v_value, now())
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (v_me.username, 'badge_style_updated', v_key, jsonb_build_object('length', char_length(v_value)));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_set_badge_style(text, text[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_set_badge_style(text, text[], text, text) TO authenticated;

-- Older pages: same as before, keeping the badge's current shape.
CREATE OR REPLACE FUNCTION public.chat_set_smt_check(p_symbol text, p_colors text[], p_animation text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_key text; v_shape text;
BEGIN
  SELECT CASE p.staff_role WHEN 'super_mega_tuff_co_owner' THEN 'smt_check' WHEN 'phoenix' THEN 'phoenix_check'
         WHEN 'owner' THEN 'owner_check' END INTO v_key
  FROM public.profiles p WHERE p.user_id = auth.uid();
  IF v_key IS NOT NULL AND (p_symbol IS NOT NULL OR p_colors IS NOT NULL OR p_animation IS NOT NULL) THEN
    BEGIN
      SELECT nullif(value, '')::jsonb ->> 'shape' INTO v_shape FROM public.app_settings WHERE key = v_key;
    EXCEPTION WHEN others THEN v_shape := NULL;
    END;
  END IF;
  RETURN public.chat_set_badge_style(p_symbol, p_colors, p_animation, v_shape);
END;
$$;
REVOKE ALL ON FUNCTION public.chat_set_smt_check(text, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_set_smt_check(text, text[], text) TO authenticated;

COMMIT;
