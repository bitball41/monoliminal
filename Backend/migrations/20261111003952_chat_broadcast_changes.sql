-- Chat 6.1: deliver database changes as private Realtime broadcasts.
--
-- Chat used 13 postgres_changes listeners per client. Realtime then decoded
-- every change and evaluated row security once per listening client, and each
-- join created and deleted 13 subscription rows (about 75k since Oct 20).
-- Here each change is sent once, from the database, to a private topic:
--
--   chat:live              rows every signed-in, unbanned member can read
--   chat:user:<username>   rows only that member can read (DMs, groups,
--                          invites, read cursors, owner-only and follower-only
--                          posts)
--
-- Who receives a row mirrors the SELECT policies of its table, decided when the
-- change is sent. Joining a topic is authorized by the policies below; browsers
-- get no INSERT policy, so they cannot publish to these topics. Additive: old
-- clients keep their postgres_changes listeners; nothing is unpublished here.
-- A failed send never blocks the write (realtime.send only warns); clients
-- still reconcile over HTTP.
BEGIN;
SET LOCAL lock_timeout = '2s';

-- Joining. Same unbanned-account test as the existing presence topic.
DROP POLICY IF EXISTS chat_live_read ON realtime.messages;
CREATE POLICY chat_live_read ON realtime.messages FOR SELECT TO authenticated
USING (
  extension = 'broadcast'
  AND (SELECT realtime.topic()) = 'chat:live'
  AND (SELECT private.chat_username()) IS NOT NULL
);
DROP POLICY IF EXISTS chat_user_read ON realtime.messages;
CREATE POLICY chat_user_read ON realtime.messages FOR SELECT TO authenticated
USING (
  extension = 'broadcast'
  AND (SELECT realtime.topic()) = 'chat:user:' || (SELECT private.chat_username())
);

CREATE OR REPLACE FUNCTION private.chat_rt_send(p_topics text[], p_event text, p_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_topic text;
BEGIN
  FOR v_topic IN SELECT DISTINCT t FROM unnest(p_topics) t WHERE t IS NOT NULL LOOP
    PERFORM realtime.send(p_payload, p_event, v_topic, true);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.chat_rt_user_topics(p_usernames text[])
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(array_agg('chat:user:' || u), '{}') FROM (SELECT DISTINCT u FROM unnest(p_usernames) u WHERE u IS NOT NULL) x
$$;

-- Owners (rank 6+, unbanned): the audience of owner-preview rows.
CREATE OR REPLACE FUNCTION private.chat_rt_owner_topics()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.chat_rt_user_topics(array_agg(p.username))
  FROM public.profiles p WHERE NOT p.is_banned AND private.chat_staff_rank(p.staff_role) >= 6
$$;

-- Following-feed threads: their author and the author's followers.
CREATE OR REPLACE FUNCTION private.chat_rt_follower_topics(p_author text)
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.chat_rt_user_topics(array_append(
    coalesce((SELECT array_agg(f.follower) FROM public.follows f WHERE f.followee = p_author), '{}'), p_author))
$$;

-- Audience of a channel message, mirroring messages_read_members and
-- messages_noelle_owner_preview. NULL means every member (chat:live).
CREATE OR REPLACE FUNCTION private.chat_rt_message_topics(p_channel_id text, p_owner_preview boolean)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_author text;
BEGIN
  IF coalesce(p_owner_preview, false) THEN RETURN private.chat_rt_owner_topics(); END IF;
  IF p_channel_id LIKE 'forum:%' THEN
    SELECT t.author INTO v_author FROM public.forum_threads t
    WHERE t.id::text = substring(p_channel_id FROM 7) AND t.channel_id = 'following';
    IF FOUND THEN RETURN private.chat_rt_follower_topics(v_author); END IF;
  END IF;
  RETURN ARRAY['chat:live'];
END;
$$;

CREATE OR REPLACE FUNCTION private.chat_rt_messages() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_new jsonb; v_old jsonb; v_topics text[];
BEGIN
  IF TG_OP <> 'DELETE' THEN
    -- Soft-deleted rows carry no content.
    v_new := CASE WHEN NEW.deleted THEN jsonb_build_object('id', NEW.id, 'channel_id', NEW.channel_id, 'deleted', true)
      ELSE jsonb_build_object('id', NEW.id, 'channel_id', NEW.channel_id, 'sender', NEW.sender, 'content', NEW.content,
        'type', NEW.type, 'media_url', NEW.media_url, 'reply_to', NEW.reply_to, 'reactions', NEW.reactions,
        'deleted', NEW.deleted, 'edited', NEW.edited, 'created_at', NEW.created_at, 'pinned', NEW.pinned,
        'owner_preview', NEW.owner_preview) END;
    v_topics := private.chat_rt_message_topics(NEW.channel_id, NEW.owner_preview);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    v_old := jsonb_build_object('id', OLD.id, 'channel_id', OLD.channel_id);
    v_topics := coalesce(v_topics, private.chat_rt_message_topics(OLD.channel_id, OLD.owner_preview));
  END IF;
  PERFORM private.chat_rt_send(v_topics, 'messages', jsonb_build_object('op', TG_OP, 'new', v_new, 'old', v_old));
  RETURN NULL;
END;
$$;

-- DMs and groups: the conversation's current participants.
CREATE OR REPLACE FUNCTION private.chat_rt_dm_messages() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_new jsonb; v_old jsonb; v_dm uuid;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    v_dm := NEW.dm_id;
    v_new := CASE WHEN NEW.deleted THEN jsonb_build_object('id', NEW.id, 'dm_id', NEW.dm_id, 'deleted', true)
      ELSE jsonb_build_object('id', NEW.id, 'dm_id', NEW.dm_id, 'sender', NEW.sender, 'content', NEW.content,
        'type', NEW.type, 'media_url', NEW.media_url, 'reply_to', NEW.reply_to, 'reactions', NEW.reactions,
        'deleted', NEW.deleted, 'edited', NEW.edited, 'created_at', NEW.created_at) END;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    v_dm := coalesce(v_dm, OLD.dm_id);
    v_old := jsonb_build_object('id', OLD.id, 'dm_id', OLD.dm_id);
  END IF;
  PERFORM private.chat_rt_send(
    (SELECT private.chat_rt_user_topics(d.participants) FROM public.dms d WHERE d.id = v_dm),
    'dm_messages', jsonb_build_object('op', TG_OP, 'new', v_new, 'old', v_old));
  RETURN NULL;
END;
$$;

-- Conversation membership changed: tell old and new members, without data
-- (removed members must not see the new member list or title).
CREATE OR REPLACE FUNCTION private.chat_rt_dms() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_people text[] := '{}';
BEGIN
  IF TG_OP <> 'DELETE' THEN v_id := NEW.id; v_people := v_people || coalesce(NEW.participants, '{}'); END IF;
  IF TG_OP <> 'INSERT' THEN v_id := OLD.id; v_people := v_people || coalesce(OLD.participants, '{}'); END IF;
  PERFORM private.chat_rt_send(private.chat_rt_user_topics(v_people), 'dms',
    jsonb_build_object('op', TG_OP, 'new', CASE WHEN TG_OP <> 'DELETE' THEN jsonb_build_object('id', v_id) END,
      'old', jsonb_build_object('id', v_id)));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.chat_rt_dm_reads() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.chat_rt_send(private.chat_rt_user_topics(ARRAY[CASE WHEN TG_OP = 'DELETE' THEN OLD.username ELSE NEW.username END]),
    'dm_reads', jsonb_build_object('op', TG_OP,
      'new', CASE WHEN TG_OP <> 'DELETE' THEN jsonb_build_object('dm_id', NEW.dm_id, 'username', NEW.username, 'last_read_at', NEW.last_read_at) END,
      'old', CASE WHEN TG_OP <> 'INSERT' THEN jsonb_build_object('dm_id', OLD.dm_id, 'username', OLD.username) END));
  RETURN NULL;
END;
$$;

-- Invitations: the invitee and the group's owner (group_invites_read), no data.
CREATE OR REPLACE FUNCTION private.chat_rt_group_invites() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_group uuid; v_people text[] := '{}';
BEGIN
  IF TG_OP <> 'DELETE' THEN v_group := NEW.group_id; v_people := v_people || NEW.invitee; END IF;
  IF TG_OP <> 'INSERT' THEN v_group := coalesce(v_group, OLD.group_id); v_people := v_people || OLD.invitee; END IF;
  v_people := v_people || (SELECT d.group_owner FROM public.dms d WHERE d.id = v_group);
  PERFORM private.chat_rt_send(private.chat_rt_user_topics(v_people), 'chat_group_invites',
    jsonb_build_object('op', TG_OP, 'new', NULL, 'old', jsonb_build_object('group_id', v_group)));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.chat_rt_forum_threads() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.forum_threads; v_topics text[];
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  v_topics := CASE WHEN r.channel_id = 'following' THEN private.chat_rt_follower_topics(r.author) ELSE ARRAY['chat:live'] END;
  PERFORM private.chat_rt_send(v_topics, 'forum_threads', jsonb_build_object('op', TG_OP,
    'new', CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
    'old', CASE WHEN TG_OP <> 'INSERT' THEN jsonb_build_object('id', OLD.id, 'channel_id', OLD.channel_id, 'author', OLD.author) END));
  RETURN NULL;
END;
$$;

-- Polls follow their message (polls_member_read): chat channels only, and
-- owner-preview polls reach owners only.
CREATE OR REPLACE FUNCTION private.chat_rt_polls() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_message uuid; v_topics text[];
BEGIN
  v_message := CASE WHEN TG_OP = 'DELETE' THEN OLD.message_id ELSE NEW.message_id END;
  SELECT CASE WHEN m.owner_preview THEN private.chat_rt_owner_topics() ELSE ARRAY['chat:live'] END INTO v_topics
  FROM public.messages m JOIN public.channels c ON c.id = m.channel_id
  WHERE m.id = v_message AND NOT m.deleted AND c.kind = 'chat';
  IF v_topics IS NULL THEN RETURN NULL; END IF;
  PERFORM private.chat_rt_send(v_topics, 'polls', jsonb_build_object('op', TG_OP,
    'new', CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
    'old', jsonb_build_object('message_id', v_message)));
  RETURN NULL;
END;
$$;

-- Tables every signed-in member can read in full. Profiles never carry the
-- legacy password column.
CREATE OR REPLACE FUNCTION private.chat_rt_public_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_new jsonb; v_old jsonb;
BEGIN
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW) - 'password_hash'; END IF;
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD) - 'password_hash'; END IF;
  PERFORM private.chat_rt_send(ARRAY['chat:live'], TG_TABLE_NAME, jsonb_build_object('op', TG_OP, 'new', v_new, 'old', v_old));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.chat_rt_send(text[],text,jsonb), private.chat_rt_user_topics(text[]),
  private.chat_rt_owner_topics(), private.chat_rt_follower_topics(text), private.chat_rt_message_topics(text,boolean),
  private.chat_rt_messages(), private.chat_rt_dm_messages(), private.chat_rt_dms(), private.chat_rt_dm_reads(),
  private.chat_rt_group_invites(), private.chat_rt_forum_threads(), private.chat_rt_polls(), private.chat_rt_public_row()
  FROM PUBLIC, anon, authenticated;

-- AFTER triggers named zz_ so they run after every guard and audit trigger.
DO $triggers$
DECLARE pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['messages','chat_rt_messages'], ['dm_messages','chat_rt_dm_messages'], ['dms','chat_rt_dms'],
    ['dm_reads','chat_rt_dm_reads'], ['chat_group_invites','chat_rt_group_invites'],
    ['forum_threads','chat_rt_forum_threads'], ['polls','chat_rt_polls'],
    ['profiles','chat_rt_public_row'], ['app_settings','chat_rt_public_row'], ['channels','chat_rt_public_row'],
    ['chat_subroles','chat_rt_public_row'], ['public_stickers','chat_rt_public_row'], ['follows','chat_rt_public_row'],
    ['voice_server_mutes','chat_rt_public_row']
  ] LOOP
    CONTINUE WHEN to_regclass('public.' || pair[1]) IS NULL;
    EXECUTE format('DROP TRIGGER IF EXISTS zz_chat_rt_broadcast ON public.%I', pair[1]);
    EXECUTE format('CREATE TRIGGER zz_chat_rt_broadcast AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION private.%I()', pair[1], pair[2]);
  END LOOP;
END;
$triggers$;

COMMIT;
