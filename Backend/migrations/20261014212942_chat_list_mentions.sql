-- Signed-in message reads use row security. ILIKE is not leakproof, so Postgres
-- will not use the trigram index for the inbox query the browser used to send.
-- This function runs as its owner, keeps the same visibility rules, and can use
-- messages_content_trgm_idx.
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
