-- Retire the troll feature for all accounts, including cached chat clients.
-- Preserve audit history, reserved usernames and unrelated staff permissions.
BEGIN;

CREATE OR REPLACE FUNCTION private.chat_troll_tier()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT NULL::text $$;

CREATE OR REPLACE FUNCTION private.chat_can_troll()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION private.chat_troll_effects_of(p_username text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT '[]'::jsonb $$;

-- Clear any effects in already-open clients before retiring the write APIs.
DO $$
DECLARE v_target text;
BEGIN
  FOR v_target IN SELECT DISTINCT target FROM private.chat_troll_effects WHERE expires_at > now() LOOP
    PERFORM private.chat_troll_broadcast(v_target);
  END LOOP;
END;
$$;
UPDATE private.chat_troll_effects SET expires_at = now() WHERE expires_at > now();

REVOKE ALL ON FUNCTION public.chat_troll_apply(text, text[], integer),
  public.chat_troll_refresh(text), public.chat_troll_clear(text),
  public.chat_troll_list() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.chat_troll_tier(), private.chat_can_troll(),
  private.chat_troll_effects_of(text) FROM PUBLIC, anon, authenticated;
-- chat_my_troll_effects remains an empty read for cached clients on reconnect.
NOTIFY pgrst, 'reload schema';
COMMIT;
