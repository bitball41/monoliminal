-- Keep source identity server-configured and mirror only the requested public
-- appearance. The bot never inherits staff roles, subscriptions or permissions.
CREATE FUNCTION public.chat_noelle_profile()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT private.chat_has_rank(6) THEN RAISE EXCEPTION 'Owner access required'; END IF;
  RETURN (SELECT jsonb_build_object('source_username',p.username,'pfp',p.pfp,'ring',p.ring,'bio',p.bio)
    FROM public.profiles p JOIN private.noelle_ai_config cfg ON cfg.source_user_id=p.user_id WHERE cfg.singleton);
END $$;
REVOKE ALL ON FUNCTION public.chat_noelle_profile() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.chat_noelle_profile() TO authenticated;

-- Live, bounded public examples, with the actual nearby/replied-to text so the
-- model can learn reactions rather than an unordered bag of catchphrases.
CREATE FUNCTION private.noelle_ai_reference(p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE source public.messages%rowtype; source_profile public.profiles%rowtype;
  terms text; query tsquery; examples jsonb; history jsonb; replying_to jsonb;
BEGIN
  SELECT * INTO source FROM public.messages WHERE id=p_source_id;
  SELECT p.* INTO source_profile FROM public.profiles p JOIN private.noelle_ai_config cfg ON cfg.source_user_id=p.user_id WHERE cfg.singleton;
  -- English stemming handles games/game; OR matching survives conversational
  -- filler such as "do you like ..." instead of requiring every word to match.
  SELECT string_agg(quote_literal(term)||':*',' | ') INTO terms
    FROM unnest(tsvector_to_array(to_tsvector('english',regexp_replace(source.content,'@noelleai','','gi')))) term;
  query := CASE WHEN terms IS NOT NULL THEN to_tsquery('english',terms) ELSE NULL END;
  WITH candidates AS (
    (SELECT id,content,created_at,1 priority,ts_rank(to_tsvector('english',content),query) score
      FROM private.noelle_ai_corpus WHERE to_tsvector('english',content)@@query
      ORDER BY score DESC,created_at DESC,id LIMIT 24)
    UNION ALL
    (SELECT id,content,created_at,2 priority,0::real score FROM private.noelle_ai_corpus ORDER BY created_at DESC,id LIMIT 16)
    UNION ALL
    (SELECT id,content,created_at,3 priority,0::real score FROM private.noelle_ai_corpus ORDER BY md5(id::text) LIMIT 48)
  ), selected AS (
    SELECT id,content,created_at,min(priority) priority,max(score) score FROM candidates GROUP BY id,content,created_at
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('content',e.content,'relevant',e.priority=1,'context',coalesce(ctx.items,'[]'))
    ORDER BY e.priority,e.score DESC,e.created_at DESC,e.id),'[]') INTO examples
  FROM selected e LEFT JOIN public.messages original ON original.id=e.id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('content',h.content,'is_source',h.sender=source_profile.username) ORDER BY h.created_at,h.id) items
    FROM (SELECT m.id,m.sender,left(m.content,500) content,m.created_at FROM public.messages m
      WHERE m.channel_id=original.channel_id AND NOT coalesce(m.deleted,false) AND NOT m.owner_preview
        AND m.type='text' AND m.sender NOT IN ('NoelleAI','Luna') AND length(btrim(m.content)) BETWEEN 3 AND 500
        AND m.created_at<original.created_at
        AND (m.id::text=original.reply_to->>'id' OR m.created_at>=original.created_at-interval '2 minutes')
      ORDER BY CASE WHEN m.id::text=original.reply_to->>'id' THEN 0 ELSE 1 END,m.created_at DESC,m.id LIMIT 3) h
  ) ctx ON true;
  SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.created_at,h.id),'[]') INTO history FROM
    (SELECT id,sender,left(content,1200) content,type,created_at,reply_to FROM public.messages
      WHERE channel_id=source.channel_id AND NOT coalesce(deleted,false) AND type IN ('text','image','gif')
        AND created_at>=source.created_at-interval '4 hours' AND (created_at<source.created_at OR id=source.id)
        AND (sender=source.sender OR sender='NoelleAI' AND reply_to->>'sender'=source.sender)
      ORDER BY created_at DESC,id DESC LIMIT 16) h;
  SELECT jsonb_build_object('sender',m.sender,'content',left(m.content,1200)) INTO replying_to
    FROM public.messages m WHERE m.id::text=source.reply_to->>'id' AND m.channel_id=source.channel_id
      AND NOT coalesce(m.deleted,false) AND m.created_at<=source.created_at;
  RETURN jsonb_build_object('examples',examples,'history',history,'replying_to',replying_to,
    'public_profile',jsonb_build_object('bio',source_profile.bio),
    'gifs_enabled',NOT EXISTS(SELECT 1 FROM public.app_settings WHERE key='gifs_enabled' AND value='false'));
END $$;
REVOKE ALL ON FUNCTION private.noelle_ai_reference(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.noelle_ai_reference(uuid) TO service_role;

-- Retain the existing owner/consent/visibility/rate/spend checks verbatim.
DO $$
DECLARE definition text; start_at integer; end_at integer;
BEGIN
  definition := pg_get_functiondef('public.chat_noelle_claim(uuid,uuid)'::regprocedure);
  start_at := position('  query := plainto_tsquery(' IN definition);
  end_at := position('  INSERT INTO private.noelle_ai_requests(' IN definition);
  IF start_at=0 OR end_at<=start_at THEN RAISE EXCEPTION 'Unexpected Noelle reference selection'; END IF;
  definition := left(definition,start_at-1)||substring(definition FROM end_at);
  IF position('''examples'',examples,''history'',history);' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected Noelle claim output'; END IF;
  definition := replace(definition,'''examples'',examples,''history'',history);',
    '''examples'',examples,''history'',history) || private.noelle_ai_reference(source.id);');
  EXECUTE definition;
END $$;

-- Save text and an optional GIF together: one owner-only, idempotent reply.
DO $$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.chat_noelle_finish(uuid,uuid,text,integer)'::regprocedure);
  IF position('p_cost_micros integer)' IN definition)=0 OR position('''text'',jsonb_build_object(' IN definition)=0 THEN
    RAISE EXCEPTION 'Unexpected Noelle finish definition';
  END IF;
  definition := replace(definition,'p_cost_micros integer)','p_cost_micros integer, p_gif_url text DEFAULT NULL)');
  definition := replace(definition,'  PERFORM set_config(''app.luna_reply_insert'',''true'',true);',
    $patch$  IF p_gif_url IS NOT NULL AND (length(p_gif_url)>2048 OR p_gif_url !~* '^https://(static\.klipy\.com|media[0-9]*\.giphy\.com|media\.tenor\.com)/[a-z0-9_./-]+\.gif$') THEN
    RAISE EXCEPTION 'invalid_gif';
  END IF;
  IF EXISTS(SELECT 1 FROM public.app_settings WHERE key='gifs_enabled' AND value='false') THEN p_gif_url := NULL; END IF;
  PERFORM set_config('app.luna_reply_insert','true',true);$patch$);
  definition := replace(definition,'(channel_id,sender,content,type,reply_to)', '(channel_id,sender,content,type,media_url,reply_to)');
  definition := replace(definition,'''text'',jsonb_build_object(',
    'CASE WHEN p_gif_url IS NULL THEN ''text'' ELSE ''gif'' END,coalesce(p_gif_url,''''),jsonb_build_object(');
  DROP FUNCTION public.chat_noelle_finish(uuid,uuid,text,integer);
  EXECUTE definition;
END $$;
REVOKE ALL ON FUNCTION public.chat_noelle_finish(uuid,uuid,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.chat_noelle_finish(uuid,uuid,text,integer,text) TO service_role;
