-- Phoenix, part 2.
--
--   * Troll protection: nobody can troll Kirk (the Phoenix), PomKnee and Conno
--     included, the same as the owner and PRESTON. Active trolls on him end now.
--     He keeps his own troll menu.
--   * He can lift any timeout on himself, Conno's included. (The Super Mega
--     Tuff Co-owner still can't lift one from Conno.) Only Conno can still time
--     him out in the first place.
-- The 30-second message cooldown is enforced by Chat itself, not the database,
-- so removing it for Kirk is a Chat change.
BEGIN;
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION private.chat_troll_target(p_target text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_target public.profiles%rowtype;
BEGIN
  IF NOT private.chat_can_troll() THEN
    RAISE EXCEPTION 'Only the Super Mega Tuff Co-owner, Phoenix or Conno can troll';
  END IF;
  SELECT * INTO v_target FROM public.profiles WHERE lower(username) = lower(btrim(coalesce(p_target, '')));
  IF v_target.username IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_target.username = private.chat_username() THEN RAISE EXCEPTION 'You cannot troll yourself'; END IF;
  IF v_target.staff_role IN ('owner', 'preston') THEN RAISE EXCEPTION 'The owner and PRESTON cannot be trolled'; END IF;
  IF v_target.staff_role = 'phoenix' THEN RAISE EXCEPTION 'The Phoenix has troll protection'; END IF;
  IF lower(v_target.username) IN ('luna', 'quotebot') THEN RAISE EXCEPTION 'Bots cannot be trolled'; END IF;
  IF v_target.is_banned THEN RAISE EXCEPTION 'That account is banned'; END IF;
  RETURN v_target.username;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_troll_target(text) FROM PUBLIC, anon, authenticated;

-- End any troll already on Kirk and tell his open Chats.
DO $$
DECLARE v_name text;
BEGIN
  FOR v_name IN
    DELETE FROM private.chat_troll_effects t USING public.profiles p
    WHERE p.username = t.target AND p.staff_role = 'phoenix'
    RETURNING t.target
  LOOP
    PERFORM private.chat_troll_broadcast(v_name);
  END LOOP;
END $$;

-- Either role clears anyone's timeout. The Super Mega Tuff Co-owner can't
-- lift one Conno gave it; the Phoenix can.
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

  IF p_minutes = 0 AND v_actor.staff_role IN ('super_mega_tuff_co_owner', 'phoenix') THEN
    SELECT * INTO v_target FROM public.profiles
    WHERE lower(username) = lower(btrim(p_target_username)) FOR UPDATE;
    IF v_target.username IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
    IF v_actor.staff_role = 'super_mega_tuff_co_owner'
       AND v_target.username = v_actor.username AND v_target.timeout_until > now()
       AND lower(coalesce(v_target.timeout_by, '')) = 'connor' THEN
      RAISE EXCEPTION 'Only Conno can lift a timeout from Conno';
    END IF;
    UPDATE public.profiles SET timeout_until = NULL, timeout_by = ''
    WHERE username = v_target.username;
    INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
    VALUES (v_actor.username, 'timeout_cleared_in_chat', v_target.username, jsonb_build_object('minutes', 0));
    RETURN true;
  END IF;

  v_target := private.chat_require_moderation_target(v_actor.username, p_target_username, 2, 'timeout');

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

COMMIT;
