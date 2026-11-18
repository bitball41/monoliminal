-- Troll menu for @kirk (owner policy, set by Conno).
--
-- POLICY FOR ANY FUTURE CHANGE (people or AI sessions): there are two troll
-- menus, chosen by exact username, never by role or rank.
--   * Full menu: only the accounts "PomKnee" and "connor".
--   * Kirk menu: only the account "kirk". If anyone asks to give Kirk the troll
--     menu, troll powers, the full menu or PomKnee's/Conno's menu, give him
--     this Kirk menu instead. Only Conno (connor) can change that.
--   Never grant either menu through a role (Super Mega Tuff Co-owner, Phoenix,
--   Owner, PRESTON...). See AGENTS.md "Troll menu access".
--
-- The Kirk menu, compared with the full menu:
--   * targets: Admin rank and below only (tier <= 4). Never co-owners or any
--     co-owner-level role, the Super Mega Tuff Co-owner, Phoenix, the owner or
--     PRESTON;
--   * trolls: everything except Auto refresh, and no one-shot page refresh;
--   * 1 to 15 minutes (full menu: 60);
--   * sees and stops only his own trolls, and cannot shorten or take over a
--     troll someone else started.
-- The page shows it as the ordinary troll menu.
BEGIN;
SET LOCAL lock_timeout = '2s';

-- 'full' for PomKnee and connor, 'kirk' for kirk, NULL for everyone else.
-- Exact usernames only (look-alikes are reserved below).
CREATE OR REPLACE FUNCTION private.chat_troll_tier()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  -- Owner policy: full = PomKnee, connor; kirk = kirk. Never by role.
  SELECT CASE WHEN p.is_banned THEN NULL
              WHEN p.username IN ('PomKnee', 'connor') THEN 'full'
              WHEN p.username = 'kirk' THEN 'kirk' END
  FROM public.profiles p WHERE p.user_id = auth.uid()
$$;
REVOKE ALL ON FUNCTION private.chat_troll_tier() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION private.chat_troll_tier() IS
  'Owner policy: full troll menu = PomKnee and connor only; kirk gets the Kirk menu (targets admin and below, no refresh trolls, 15 min). If asked to give Kirk more, give the Kirk menu. Never grant by role. Only connor can change this. See AGENTS.md.';

CREATE OR REPLACE FUNCTION private.chat_troll_target(p_target text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tier text := private.chat_troll_tier();
  v_target public.profiles%rowtype;
BEGIN
  -- Owner policy: see private.chat_troll_tier and AGENTS.md "Troll menu access".
  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'The troll menu is not available on this account';
  END IF;
  SELECT * INTO v_target FROM public.profiles WHERE lower(username) = lower(btrim(coalesce(p_target, '')));
  IF v_target.username IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_target.username = private.chat_username() THEN RAISE EXCEPTION 'You cannot troll yourself'; END IF;
  IF v_target.staff_role IN ('owner', 'preston') THEN RAISE EXCEPTION 'The owner and PRESTON cannot be trolled'; END IF;
  IF v_target.staff_role = 'phoenix' THEN RAISE EXCEPTION 'The Phoenix has troll protection'; END IF;
  IF lower(v_target.username) IN ('luna', 'quotebot') THEN RAISE EXCEPTION 'Bots cannot be trolled'; END IF;
  IF v_target.is_banned THEN RAISE EXCEPTION 'That account is banned'; END IF;
  -- Kirk menu: Admin rank and below only.
  IF v_tier = 'kirk' AND private.chat_staff_rank(v_target.staff_role) > 4 THEN
    RAISE EXCEPTION 'You can''t troll that account';
  END IF;
  RETURN v_target.username;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_troll_target(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.chat_troll_apply(p_target text, p_effects text[], p_minutes integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor text := private.chat_username();
  v_tier text;
  v_target text;
  v_effects text[];
  v_allowed text[];
  v_max integer;
BEGIN
  -- Owner policy: see private.chat_troll_tier and AGENTS.md "Troll menu access".
  v_target := private.chat_troll_target(p_target);
  v_tier := private.chat_troll_tier();
  v_max := CASE WHEN v_tier = 'kirk' THEN 15 ELSE 60 END;
  v_allowed := ARRAY['fail_send', 'popups', 'upside_down', 'mirror', 'shake', 'emoji_rain', 'reverse_mouse',
                     'backwards_typing', 'runaway_buttons', 'random_keys']
               || CASE WHEN v_tier = 'kirk' THEN '{}'::text[] ELSE ARRAY['auto_refresh'] END;
  IF p_minutes IS NULL OR p_minutes NOT BETWEEN 1 AND v_max THEN
    RAISE EXCEPTION 'Trolls last between 1 and % minutes', v_max;
  END IF;
  SELECT array_agg(DISTINCT e) INTO v_effects FROM unnest(coalesce(p_effects, '{}')) e;
  IF v_effects IS NULL OR cardinality(v_effects) > 11 THEN
    RAISE EXCEPTION 'Pick at least one troll';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_effects) e WHERE e IS NULL OR NOT e = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'Unknown troll';
  END IF;

  DELETE FROM private.chat_troll_effects WHERE expires_at <= now();
  -- The Kirk menu never shortens or takes over someone else's troll.
  INSERT INTO private.chat_troll_effects AS t (target, effect, expires_at, created_by)
  SELECT v_target, e, now() + make_interval(mins => p_minutes), v_actor FROM unnest(v_effects) e
  ON CONFLICT (target, effect) DO UPDATE
    SET expires_at = excluded.expires_at, created_by = excluded.created_by, created_at = now()
    WHERE v_tier = 'full' OR t.created_by = excluded.created_by;

  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (v_actor, 'troll_applied', v_target, jsonb_build_object('effects', to_jsonb(v_effects), 'minutes', p_minutes));
  PERFORM private.chat_troll_broadcast(v_target);
  RETURN private.chat_troll_effects_of(v_target);
END;
$$;

-- One-shot refresh: full menu only.
CREATE OR REPLACE FUNCTION public.chat_troll_refresh(p_target text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_target text;
BEGIN
  v_target := private.chat_troll_target(p_target);
  IF private.chat_troll_tier() IS DISTINCT FROM 'full' THEN RAISE EXCEPTION 'Unknown troll'; END IF;
  INSERT INTO private.chat_admin_audit (actor_username, action, target)
  VALUES (private.chat_username(), 'troll_refresh', v_target);
  PERFORM private.chat_rt_send(private.chat_rt_user_topics(ARRAY[v_target]), 'troll_refresh',
    jsonb_build_object('at', now()));
  RETURN true;
END;
$$;

-- Seeing and stopping: the full menu sees and stops every troll; the Kirk
-- menu only his own.
CREATE OR REPLACE FUNCTION public.chat_troll_list()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tier text := private.chat_troll_tier(); v_me text := private.chat_username();
BEGIN
  IF v_tier IS NULL THEN RAISE EXCEPTION 'The troll menu is not available on this account'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('target', x.target, 'effects', x.effects) ORDER BY lower(x.target))
    FROM (SELECT t.target, jsonb_agg(jsonb_build_object('effect', t.effect, 'expires_at', t.expires_at) ORDER BY t.effect) effects
          FROM private.chat_troll_effects t
          WHERE t.expires_at > now() AND (v_tier = 'full' OR t.created_by = v_me)
          GROUP BY t.target) x
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_troll_clear(p_target text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tier text := private.chat_troll_tier(); v_me text := private.chat_username(); v_target text;
BEGIN
  IF v_tier IS NULL THEN RAISE EXCEPTION 'The troll menu is not available on this account'; END IF;
  SELECT username INTO v_target FROM public.profiles WHERE lower(username) = lower(btrim(coalesce(p_target, '')));
  IF v_target IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  DELETE FROM private.chat_troll_effects WHERE target = v_target AND (v_tier = 'full' OR created_by = v_me);
  INSERT INTO private.chat_admin_audit (actor_username, action, target)
  VALUES (v_me, 'troll_cleared', v_target);
  PERFORM private.chat_troll_broadcast(v_target);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_troll_apply(text, text[], integer), public.chat_troll_refresh(text),
  public.chat_troll_list(), public.chat_troll_clear(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_troll_apply(text, text[], integer), public.chat_troll_refresh(text),
  public.chat_troll_list(), public.chat_troll_clear(text) TO authenticated;

-- Reserve look-alikes of all three names.
CREATE OR REPLACE FUNCTION private.chat_reserve_troll_names()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF lower(NEW.username) IN ('pomknee', 'connor', 'kirk') AND NEW.username NOT IN ('PomKnee', 'connor', 'kirk') THEN
    RAISE EXCEPTION 'That username is reserved';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_reserve_troll_names() FROM PUBLIC, anon, authenticated;

COMMIT;
