-- Copy/paste this whole file in the SQL editor. No chat content is modified.
BEGIN;

-- A membership fingerprint can repeat after remove/reinvite. Use a private,
-- server-generated epoch so previously authorized sockets never regain a topic.
CREATE TABLE private.chat_voice_room_epochs (
  dm_id uuid PRIMARY KEY REFERENCES public.dms(id) ON DELETE CASCADE,
  epoch uuid NOT NULL DEFAULT gen_random_uuid()
);
ALTER TABLE private.chat_voice_room_epochs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.chat_voice_room_epochs FROM PUBLIC, anon, authenticated;
INSERT INTO private.chat_voice_room_epochs(dm_id) SELECT id FROM public.dms;

CREATE FUNCTION private.chat_rotate_voice_room() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.participants IS DISTINCT FROM OLD.participants THEN
    INSERT INTO private.chat_voice_room_epochs(dm_id) VALUES(NEW.id)
    ON CONFLICT(dm_id) DO UPDATE SET epoch=gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_rotate_voice_room() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER chat_rotate_voice_room AFTER INSERT OR UPDATE OF participants ON public.dms
FOR EACH ROW EXECUTE FUNCTION private.chat_rotate_voice_room();

CREATE OR REPLACE FUNCTION private.chat_private_voice_room(p_dm_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor text:=private.chat_username(); v_dm public.dms%rowtype; v_epoch uuid;
BEGIN
  IF v_actor IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_dm FROM public.dms WHERE id=p_dm_id;
  IF v_dm.id IS NULL OR NOT coalesce(v_actor=ANY(v_dm.participants),false)
    OR cardinality(v_dm.participants)<2 OR EXISTS(SELECT 1 FROM unnest(v_dm.participants) name WHERE lower(name)='luna')
    OR EXISTS(SELECT 1 FROM public.dm_blocks b WHERE
      (b.blocker=v_actor AND b.blocked=ANY(v_dm.participants)) OR
      (b.blocked=v_actor AND b.blocker=ANY(v_dm.participants)))
    OR EXISTS(SELECT 1 FROM public.app_settings WHERE key IN ('app_enabled','dms_enabled') AND value='false')
  THEN RETURN NULL; END IF;
  SELECT epoch INTO v_epoch FROM private.chat_voice_room_epochs WHERE dm_id=p_dm_id;
  IF v_epoch IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('topic','liminal-private-voice:'||v_dm.id::text||':'||replace(v_epoch::text,'-',''),
    'members',to_jsonb(v_dm.participants));
END;
$$;
REVOKE ALL ON FUNCTION private.chat_private_voice_room(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.chat_private_voice_room(uuid) TO authenticated;

-- Reject substring matches before LIMIT: 50 newer @alice2 posts must not hide
-- a real @alice mention. Retain the indexed ILIKE prefilter and visibility rules.
CREATE OR REPLACE FUNCTION public.chat_list_mentions(p_limit integer DEFAULT 50)
RETURNS TABLE(
  id uuid,
  channel_id text,
  sender text,
  content text,
  type text,
  created_at timestamptz,
  deleted boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT m.id, m.channel_id, m.sender, m.content, m.type, m.created_at, coalesce(m.deleted, false)
  FROM public.messages m
  WHERE private.chat_username() IS NOT NULL
    AND m.sender IS DISTINCT FROM private.chat_username()
    AND m.deleted = false
    AND m.content ILIKE (
      '%@' || replace(replace(replace(private.chat_username(), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%'
    ) ESCAPE E'\\'
    AND EXISTS (SELECT 1 FROM regexp_matches(m.content, '@([A-Za-z0-9_]{1,40})(?![A-Za-z0-9_])', 'gi') token
      WHERE lower(token[1])=lower(private.chat_username()))
    AND (
      m.channel_id !~~ 'forum:%'
      OR NOT EXISTS (
        SELECT 1 FROM public.forum_threads t
        WHERE t.id::text = substring(m.channel_id FROM 7)
          AND t.channel_id = 'following'
      )
      OR EXISTS (
        SELECT 1 FROM public.forum_threads t
        WHERE t.id::text = substring(m.channel_id FROM 7)
          AND t.channel_id = 'following'
          AND (
            t.author = private.chat_username()
            OR EXISTS (
              SELECT 1 FROM public.follows f
              WHERE f.follower = private.chat_username()
                AND f.followee = t.author
            )
          )
      )
    )
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 50);
$function$;

REVOKE ALL ON FUNCTION public.chat_list_mentions(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_list_mentions(integer) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';

COMMIT;
