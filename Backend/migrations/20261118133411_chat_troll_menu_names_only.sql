-- Troll menu: @PomKnee and @connor only.
--
-- The troll menu (applying trolls, the one-shot refresh, and seeing or stopping
-- active trolls) now depends on who you are, not on a role or staff rank:
-- only the exact accounts "PomKnee" and "connor" can use it. A role, rank or
-- other permission (Super Mega Tuff Co-owner, Phoenix, Owner, PRESTON) does not
-- unlock it on its own. Conno can use it whatever his role; PomKnee keeps it
-- even if their role changes. A banned account cannot use it.
--
-- Usernames are case-sensitive, so look-alikes ("pomknee", "CONNOR") are
-- reserved: no other account can be created with, or renamed to, either name
-- in any capitalisation.
--
-- Targets are unchanged: never yourself, the owner, PRESTON, the bots or a
-- banned account.
BEGIN;
SET LOCAL lock_timeout = '2s';

-- Exact usernames; no lower() so a look-alike can never match.
CREATE OR REPLACE FUNCTION private.chat_can_troll()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT NOT p.is_banned AND p.username IN ('PomKnee', 'connor')
    FROM public.profiles p WHERE p.user_id = auth.uid()), false)
$$;
REVOKE ALL ON FUNCTION private.chat_can_troll() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.chat_troll_target(p_target text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_target public.profiles%rowtype;
BEGIN
  IF NOT private.chat_can_troll() THEN
    RAISE EXCEPTION 'Only @PomKnee and @connor can use the troll menu';
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

-- Seeing and stopping trolls: the same two accounts.
CREATE OR REPLACE FUNCTION public.chat_troll_clear(p_target text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_target text;
BEGIN
  IF NOT private.chat_can_troll() THEN
    RAISE EXCEPTION 'Only @PomKnee and @connor can use the troll menu';
  END IF;
  SELECT username INTO v_target FROM public.profiles WHERE lower(username) = lower(btrim(coalesce(p_target, '')));
  IF v_target IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  DELETE FROM private.chat_troll_effects WHERE target = v_target;
  INSERT INTO private.chat_admin_audit (actor_username, action, target)
  VALUES (private.chat_username(), 'troll_cleared', v_target);
  PERFORM private.chat_troll_broadcast(v_target);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_troll_list()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT private.chat_can_troll() THEN
    RAISE EXCEPTION 'Only @PomKnee and @connor can use the troll menu';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('target', x.target, 'effects', x.effects) ORDER BY lower(x.target))
    FROM (SELECT t.target, jsonb_agg(jsonb_build_object('effect', t.effect, 'expires_at', t.expires_at) ORDER BY t.effect) effects
          FROM private.chat_troll_effects t WHERE t.expires_at > now() GROUP BY t.target) x
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.chat_troll_clear(text), public.chat_troll_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_troll_clear(text), public.chat_troll_list() TO authenticated;

-- Reserve look-alikes of the two names.
CREATE OR REPLACE FUNCTION private.chat_reserve_troll_names()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF lower(NEW.username) IN ('pomknee', 'connor') AND NEW.username NOT IN ('PomKnee', 'connor') THEN
    RAISE EXCEPTION 'That username is reserved';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_reserve_troll_names() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS chat_reserve_troll_names ON public.profiles;
CREATE TRIGGER chat_reserve_troll_names BEFORE INSERT OR UPDATE OF username ON public.profiles
FOR EACH ROW EXECUTE FUNCTION private.chat_reserve_troll_names();

COMMIT;
