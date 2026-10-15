-- Voice signaling must name the signed-in account, and school networks need a
-- relay the owner can save. Tickets are HMAC'd with a server-only secret.
-- The voice broadcast topic is private so anonymous clients cannot sit on it.
BEGIN;

CREATE TABLE IF NOT EXISTS private.voice_ticket_secret (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  secret text NOT NULL
);
INSERT INTO private.voice_ticket_secret (secret)
SELECT encode(extensions.gen_random_bytes(32), 'hex')
WHERE NOT EXISTS (SELECT 1 FROM private.voice_ticket_secret);
REVOKE ALL ON private.voice_ticket_secret FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.chat_voice_ticket()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user text := private.chat_username();
  v_secret text;
  v_exp bigint := floor(extract(epoch FROM (now() + interval '12 hours')));
  v_payload text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;
  SELECT secret INTO v_secret FROM private.voice_ticket_secret;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Voice tickets are not configured';
  END IF;
  v_payload := v_user || '.' || v_exp::text;
  RETURN v_payload || '.' || encode(
    extensions.hmac(convert_to(v_payload, 'utf8'), convert_to(v_secret, 'utf8'), 'sha256'),
    'hex'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_voice_verify(p_ticket text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user text;
  v_exp text;
  v_sig text;
  v_payload text;
  v_secret text;
  v_expected text;
BEGIN
  IF private.chat_username() IS NULL THEN
    RETURN NULL;
  END IF;
  v_user := split_part(p_ticket, '.', 1);
  v_exp := split_part(p_ticket, '.', 2);
  v_sig := split_part(p_ticket, '.', 3);
  IF p_ticket IS NULL
    OR split_part(p_ticket, '.', 4) <> ''
    OR v_user !~ '^[A-Za-z0-9_]+$'
    OR length(v_user) > 40
    OR v_exp !~ '^[0-9]+$'
    OR length(v_exp) > 12
    OR v_sig !~ '^[0-9a-f]+$'
    OR length(v_sig) <> 64 THEN
    RETURN NULL;
  END IF;
  IF v_exp::bigint < floor(extract(epoch FROM now())) THEN
    RETURN NULL;
  END IF;
  SELECT secret INTO v_secret FROM private.voice_ticket_secret;
  IF v_secret IS NULL THEN
    RETURN NULL;
  END IF;
  v_payload := v_user || '.' || v_exp;
  v_expected := encode(
    extensions.hmac(convert_to(v_payload, 'utf8'), convert_to(v_secret, 'utf8'), 'sha256'),
    'hex'
  );
  IF v_sig <> v_expected THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.username = v_user AND NOT p.is_banned
  ) THEN
    RETURN NULL;
  END IF;
  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_voice_ticket(), public.chat_voice_verify(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_voice_ticket(), public.chat_voice_verify(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.chat_owner_configure(p_key text, p_value text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor public.profiles%rowtype;
  v_value text := btrim(coalesce(p_value, ''));
  v_number integer;
  v_json jsonb;
BEGIN
  v_actor := private.require_chat_staff_min_rank(6);
  IF p_key IN ('app_enabled', 'registrations_enabled', 'messages_enabled', 'dms_enabled', 'uploads_enabled', 'gifs_enabled') THEN
    IF v_value NOT IN ('true', 'false') THEN
      RAISE EXCEPTION 'Choose enabled or disabled';
    END IF;
  ELSIF p_key IN ('max_message_length', 'slow_mode_seconds') THEN
    IF v_value !~ '^[0-9]{1,4}$' THEN
      RAISE EXCEPTION 'Enter a whole number';
    END IF;
    v_number := v_value::integer;
    IF (p_key = 'max_message_length' AND v_number NOT BETWEEN 100 AND 4000)
      OR (p_key = 'slow_mode_seconds' AND v_number NOT BETWEEN 0 AND 3600) THEN
      RAISE EXCEPTION 'This limit is out of range';
    END IF;
    v_value := v_number::text;
  ELSIF p_key = 'turn_servers' THEN
    IF v_value <> '' THEN
      BEGIN
        v_json := v_value::jsonb;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'TURN servers must be a JSON array';
      END;
      IF jsonb_typeof(v_json) <> 'array'
        OR jsonb_array_length(v_json) < 1
        OR jsonb_array_length(v_json) > 4 THEN
        RAISE EXCEPTION 'Provide 1 to 4 TURN servers';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_json) elem
        WHERE jsonb_typeof(elem) <> 'object'
          OR coalesce(elem->>'urls', '') !~ '^turns?:[^[:space:]]+$'
          OR length(coalesce(elem->>'urls', '')) < 8
          OR length(coalesce(elem->>'urls', '')) > 300
          OR coalesce(elem->>'urls', '') ~* 'javascript:'
          OR (elem ? 'username' AND jsonb_typeof(elem->'username') <> 'string')
          OR (elem ? 'credential' AND jsonb_typeof(elem->'credential') <> 'string')
          OR length(coalesce(elem->>'username', '')) > 200
          OR length(coalesce(elem->>'credential', '')) > 200
      ) THEN
        RAISE EXCEPTION 'Each TURN server needs a turn: or turns: URL';
      END IF;
      v_value := v_json::text;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported owner configuration';
  END IF;
  INSERT INTO public.app_settings (key, value, updated_at)
  VALUES (p_key, v_value, now())
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (v_actor.username, 'owner_setting_updated', p_key, jsonb_build_object('value', CASE WHEN p_key = 'turn_servers' THEN '[redacted]' ELSE v_value END));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_owner_configure(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_owner_configure(text, text) TO authenticated, service_role;

DROP POLICY IF EXISTS chat_voice_signal_read ON realtime.messages;
CREATE POLICY chat_voice_signal_read ON realtime.messages
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND (SELECT realtime.topic()) = 'liminal-voice-signal'
    AND (SELECT private.chat_username()) IS NOT NULL
  );

DROP POLICY IF EXISTS chat_voice_signal_write ON realtime.messages;
CREATE POLICY chat_voice_signal_write ON realtime.messages
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    realtime.messages.extension = 'broadcast'
    AND (SELECT realtime.topic()) = 'liminal-voice-signal'
    AND (SELECT private.chat_username()) IS NOT NULL
  );

NOTIFY pgrst, 'reload schema';
COMMIT;
