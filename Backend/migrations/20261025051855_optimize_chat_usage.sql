-- Additive rollout: preserve originals, legacy RPC signatures and historical
-- receipt data. No user content, read cursor or authorization policy is deleted.
SET lock_timeout = '2s';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS pfp_thumbnail text NOT NULL DEFAULT '';
GRANT SELECT (pfp_thumbnail), UPDATE (pfp_thumbnail) ON public.profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_invalidate_avatar_thumbnail() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  -- Old clients don't know about thumbnails. Never display their previous image
  -- after they replace or remove the original avatar.
  IF NEW.pfp IS DISTINCT FROM OLD.pfp AND NEW.pfp_thumbnail IS NOT DISTINCT FROM OLD.pfp_thumbnail THEN
    NEW.pfp_thumbnail := '';
  END IF;
  IF coalesce(NEW.pfp, '') = '' THEN NEW.pfp_thumbnail := ''; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_invalidate_avatar_thumbnail() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS chat_invalidate_avatar_thumbnail ON public.profiles;
CREATE TRIGGER chat_invalidate_avatar_thumbnail BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.chat_invalidate_avatar_thumbnail();

-- A single bounded request replaces one request for each visible channel.
-- SECURITY INVOKER deliberately keeps the existing message/forum RLS policies,
-- including follower-only posts, bans and owner-preview visibility.
CREATE OR REPLACE FUNCTION public.chat_unread_counts(p_read_cursors jsonb)
RETURNS TABLE(channel_id text, unread_count integer, thread_ids uuid[])
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(p_read_cursors) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_read_cursors)) > 64 THEN
    RAISE EXCEPTION 'Expected at most 64 channel cursors';
  END IF;
  RETURN QUERY
  WITH actor AS MATERIALIZED (
    SELECT p.username FROM public.profiles p
    WHERE p.user_id = (SELECT auth.uid()) AND NOT p.is_banned LIMIT 1
  ), requested AS MATERIALIZED (
    SELECT c.id, coalesce(c.kind,'chat') kind, nullif(j.value,'')::timestamptz read_at, a.username
    FROM jsonb_each_text(p_read_cursors) j
    JOIN public.channels c ON c.id = j.key CROSS JOIN actor a
    WHERE coalesce(c.kind,'chat') IN ('chat','forum')
  )
  SELECT r.id,
    CASE WHEN r.kind='forum' THEN (
      SELECT count(*)::integer FROM (
        SELECT t.id FROM public.forum_threads t WHERE t.channel_id=r.id AND t.deleted=false
          AND CASE WHEN r.read_at IS NULL THEN t.author<>r.username ELSE t.last_activity_at>r.read_at END
        LIMIT 100
      ) unread
    ) ELSE (
      SELECT count(*)::integer FROM (
        SELECT m.id FROM public.messages m WHERE m.channel_id=r.id AND m.deleted=false
          AND m.sender<>r.username AND (r.read_at IS NULL OR m.created_at>r.read_at)
        LIMIT 100
      ) unread
    ) END,
    CASE WHEN r.kind='forum' THEN ARRAY(
      SELECT t.id FROM public.forum_threads t WHERE t.channel_id=r.id AND t.deleted=false
      ORDER BY t.last_activity_at DESC LIMIT 200
    ) ELSE ARRAY[]::uuid[] END
  FROM requested r;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_unread_counts(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_unread_counts(jsonb) TO authenticated;

-- Unread position, not a per-message receipt. The caller can only advance its
-- own cursor, only inside a conversation it can read, and never into the future.
CREATE OR REPLACE FUNCTION public.chat_update_dm_read_cursor(p_dm_id uuid, p_read_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_actor text; v_at timestamptz; v_result timestamptz;
BEGIN
  SELECT p.username INTO v_actor FROM public.profiles p
  WHERE p.user_id=(SELECT auth.uid()) AND NOT p.is_banned;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Active account required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dms d WHERE d.id=p_dm_id AND v_actor=ANY(d.participants)) THEN
    RAISE EXCEPTION 'Not a participant of this conversation';
  END IF;
  IF p_read_at IS NULL THEN RAISE EXCEPTION 'Read position required'; END IF;
  v_at := least(p_read_at, pg_catalog.now());
  INSERT INTO public.dm_reads AS r (dm_id,username,last_read_at) VALUES(p_dm_id,v_actor,v_at)
  ON CONFLICT(dm_id,username) DO UPDATE SET last_read_at=excluded.last_read_at
    WHERE r.last_read_at IS NULL OR r.last_read_at<excluded.last_read_at
  RETURNING last_read_at INTO v_result;
  IF v_result IS NULL THEN
    SELECT r.last_read_at INTO v_result FROM public.dm_reads r WHERE r.dm_id=p_dm_id AND r.username=v_actor;
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_update_dm_read_cursor(uuid,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.chat_update_dm_read_cursor(uuid,timestamptz) TO authenticated;

-- Existing tabs can still call the old endpoint; it no longer updates messages.
CREATE OR REPLACE FUNCTION public.chat_mark_dm_read(p_dm_id uuid,p_limit integer DEFAULT 200)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM public.chat_update_dm_read_cursor(p_dm_id,pg_catalog.now());
  RETURN 0;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_mark_dm_read(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.chat_mark_dm_read(uuid,integer) TO authenticated;

-- Retain the result shape for older clients without sending receipt arrays.
CREATE OR REPLACE FUNCTION public.chat_list_conversations()
 RETURNS TABLE(id uuid, participants text[], created_at timestamptz, title text, is_group boolean, group_owner text, last_id uuid, last_sender text, last_content text, last_type text, last_created_at timestamptz, last_deleted boolean, last_read_by text[], my_last_read_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
SELECT d.id,d.participants,d.created_at,d.title,d.is_group,d.group_owner,m.id,m.sender,m.content,m.type,m.created_at,coalesce(m.deleted,false),ARRAY[]::text[],r.last_read_at
FROM public.dms d LEFT JOIN LATERAL (SELECT mm.id,mm.sender,mm.content,mm.type,mm.created_at,mm.deleted FROM public.dm_messages mm WHERE mm.dm_id=d.id ORDER BY mm.created_at DESC,mm.id DESC LIMIT 1) m ON true
LEFT JOIN public.dm_reads r ON r.dm_id=d.id AND r.username=(SELECT private.chat_username())
WHERE (SELECT private.chat_username())=ANY(d.participants);
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='dm_reads') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.dm_reads;
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
