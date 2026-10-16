-- Accepted DM/group members only. A changed member list changes the topic so
-- previously authorized sockets cannot follow the replacement call.
BEGIN;
CREATE FUNCTION private.chat_private_voice_room(p_dm_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor text:=private.chat_username(); v_dm public.dms%rowtype;
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
  RETURN jsonb_build_object('topic','liminal-private-voice:'||v_dm.id::text||':'||md5(array_to_string(v_dm.participants,',')),
    'members',to_jsonb(v_dm.participants));
END;
$$;
REVOKE ALL ON FUNCTION private.chat_private_voice_room(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.chat_private_voice_room(uuid) TO authenticated;

CREATE FUNCTION public.chat_private_voice_room(p_dm_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_room jsonb:=private.chat_private_voice_room(p_dm_id);
BEGIN
  IF v_room IS NULL THEN RAISE EXCEPTION 'This private call is unavailable. Check membership, blocks, or whether private chats are paused.'; END IF;
  RETURN v_room;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_private_voice_room(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.chat_private_voice_room(uuid) TO authenticated;

CREATE FUNCTION private.chat_private_voice_topic_allowed(p_topic text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_topic !~ '^liminal-private-voice:[0-9a-f-]{36}:[0-9a-f]{32}$' THEN RETURN false; END IF;
  BEGIN v_id:=split_part(p_topic,':',2)::uuid; EXCEPTION WHEN invalid_text_representation THEN RETURN false; END;
  RETURN coalesce(private.chat_private_voice_room(v_id)->>'topic'=p_topic,false);
END;
$$;
REVOKE ALL ON FUNCTION private.chat_private_voice_topic_allowed(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.chat_private_voice_topic_allowed(text) TO authenticated;

CREATE POLICY chat_private_voice_read ON realtime.messages FOR SELECT TO authenticated
USING(extension='broadcast' AND private.chat_private_voice_topic_allowed((SELECT realtime.topic())));
CREATE POLICY chat_private_voice_write ON realtime.messages FOR INSERT TO authenticated
WITH CHECK(extension='broadcast' AND private.chat_private_voice_topic_allowed((SELECT realtime.topic())));
NOTIFY pgrst,'reload schema';
COMMIT;
