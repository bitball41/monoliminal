-- Staff can mute a lower rank in voice. The row is the source of truth:
-- the muted client is told to drop its mic, and everyone else stops playback.
BEGIN;

CREATE TABLE public.voice_server_mutes (
  username text PRIMARY KEY REFERENCES public.profiles(username) ON DELETE CASCADE,
  muted_by text NOT NULL,
  muted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.voice_server_mutes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_server_mutes FROM PUBLIC, anon;
GRANT SELECT ON public.voice_server_mutes TO authenticated, service_role;
GRANT ALL ON public.voice_server_mutes TO service_role;

CREATE POLICY voice_server_mutes_read ON public.voice_server_mutes
  FOR SELECT TO authenticated
  USING ((SELECT private.chat_username()) IS NOT NULL);

CREATE FUNCTION public.chat_set_voice_mute(p_username text, p_muted boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
BEGIN
  v_actor := private.require_chat_staff_min_rank(2);
  v_target := private.chat_require_moderation_target(v_actor.username, p_username, 2, 'voice_mute');
  IF coalesce(p_muted, false) THEN
    INSERT INTO public.voice_server_mutes (username, muted_by, muted_at)
    VALUES (v_target.username, v_actor.username, now())
    ON CONFLICT (username) DO UPDATE
      SET muted_by = excluded.muted_by, muted_at = excluded.muted_at;
  ELSE
    DELETE FROM public.voice_server_mutes WHERE username = v_target.username;
  END IF;
  INSERT INTO private.chat_admin_audit (actor_username, action, target)
  VALUES (
    v_actor.username,
    CASE WHEN coalesce(p_muted, false) THEN 'voice_muted' ELSE 'voice_unmuted' END,
    v_target.username
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_set_voice_mute(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_set_voice_mute(text, boolean) TO authenticated, service_role;

DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'voice_server_mutes'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.voice_server_mutes;
    END IF;
  END IF;
END;
$pub$;

NOTIFY pgrst, 'reload schema';
COMMIT;
