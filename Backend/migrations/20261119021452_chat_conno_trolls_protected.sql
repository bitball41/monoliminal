-- Conno (@connor) can troll PomKnee and Kirk.
--
-- The Super Mega Tuff Co-owner (PomKnee) and the Phoenix (kirk) keep their
-- troll protection against everyone else, each other included. Only the
-- connor account gets past it, for trolls and the one-shot refresh.
BEGIN;
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION private.chat_troll_target(p_target text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tier text := private.chat_troll_tier();
  v_conno boolean := private.chat_username() IS NOT DISTINCT FROM 'connor';
  v_target public.profiles%rowtype;
BEGIN
  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'The troll menu is not available on this account';
  END IF;
  SELECT * INTO v_target FROM public.profiles WHERE lower(username) = lower(btrim(coalesce(p_target, '')));
  IF v_target.username IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_target.username = private.chat_username() THEN RAISE EXCEPTION 'You cannot troll yourself'; END IF;
  IF v_target.staff_role IN ('owner', 'preston') THEN RAISE EXCEPTION 'The owner and PRESTON cannot be trolled'; END IF;
  -- Troll protection, except for Conno.
  IF v_target.staff_role = 'phoenix' AND NOT v_conno THEN RAISE EXCEPTION 'The Phoenix has troll protection'; END IF;
  IF v_target.staff_role = 'super_mega_tuff_co_owner' AND NOT v_conno THEN RAISE EXCEPTION 'The Super Mega Tuff Co-owner has troll protection'; END IF;
  IF lower(v_target.username) IN ('luna', 'quotebot') THEN RAISE EXCEPTION 'Bots cannot be trolled'; END IF;
  IF v_target.is_banned THEN RAISE EXCEPTION 'That account is banned'; END IF;
  -- Limited menu: Admin rank and below only.
  IF v_tier = 'limited' AND private.chat_staff_rank(v_target.staff_role) > 4 THEN
    RAISE EXCEPTION 'You can''t troll that account';
  END IF;
  RETURN v_target.username;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_troll_target(text) FROM PUBLIC, anon, authenticated;

COMMIT;
