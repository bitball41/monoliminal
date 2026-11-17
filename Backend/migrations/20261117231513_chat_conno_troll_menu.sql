-- Troll menu for Conno too.
--
-- The owner account "connor" can now use the troll menu (apply trolls and the
-- one-shot refresh) like the Super Mega Tuff Co-owner. Nobody else can. Targets
-- are unchanged: never yourself, the owner, PRESTON, the bots or a banned
-- account, so Conno can troll PomKnee but PomKnee still can't troll Conno.
-- Listing and stopping trolls already allowed the owner.
BEGIN;
SET LOCAL lock_timeout = '2s';

-- True for the signed-in, unbanned Super Mega Tuff Co-owner or Conno.
CREATE OR REPLACE FUNCTION private.chat_can_troll()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT NOT p.is_banned AND (p.staff_role = 'super_mega_tuff_co_owner'
      OR (lower(p.username) = 'connor' AND p.staff_role = 'owner'))
    FROM public.profiles p WHERE p.user_id = auth.uid()), false)
$$;
REVOKE ALL ON FUNCTION private.chat_can_troll() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.chat_troll_target(p_target text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_target public.profiles%rowtype;
BEGIN
  IF NOT private.chat_can_troll() THEN
    RAISE EXCEPTION 'Only the Super Mega Tuff Co-owner or Conno can troll';
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

COMMIT;
