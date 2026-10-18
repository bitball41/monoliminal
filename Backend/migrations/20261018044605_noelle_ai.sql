-- Noelle AI: public-channel mentions, live public examples, and atomic spend limits.
-- There are deliberately no reads, triggers, or copies of dm_messages here.
CREATE TABLE private.noelle_ai_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  source_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  consent_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  daily_budget_cents integer NOT NULL DEFAULT 25 CHECK (daily_budget_cents BETWEEN 1 AND 10000),
  user_daily_limit integer NOT NULL DEFAULT 50 CHECK (user_daily_limit BETWEEN 1 AND 500)
);
ALTER TABLE private.noelle_ai_config ENABLE ROW LEVEL SECURITY;
INSERT INTO private.noelle_ai_config(singleton,source_user_id,consent_message_id)
SELECT true,p.user_id,(SELECT m.id FROM public.messages m WHERE m.sender=p.username
  AND NOT coalesce(m.deleted,false) AND lower(btrim(m.content))='i agree'
  ORDER BY m.created_at DESC LIMIT 1)
FROM (SELECT true AS singleton) seed LEFT JOIN public.profiles p ON p.username='Noelle';

CREATE TABLE private.noelle_ai_requests (
  source_message_id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  source_hash text NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed','cancelled')),
  response_message_id uuid,
  cost_micros integer NOT NULL DEFAULT 5000 CHECK (cost_micros >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX noelle_ai_requests_actor_created ON private.noelle_ai_requests(actor_user_id,created_at);
CREATE INDEX noelle_ai_requests_created ON private.noelle_ai_requests(created_at);
ALTER TABLE private.noelle_ai_requests ENABLE ROW LEVEL SECURITY;

-- A live view avoids stale training copies: edits, soft deletes, hard deletes,
-- deleted forum threads, consent removal and account deletion take effect at once.
CREATE VIEW private.noelle_ai_corpus WITH (security_invoker=true) AS
SELECT m.id,m.content,m.created_at
FROM public.messages m
JOIN public.profiles p ON p.username=m.sender
JOIN private.noelle_ai_config cfg ON cfg.source_user_id=p.user_id
WHERE NOT coalesce(m.deleted,false) AND m.type='text' AND length(btrim(m.content)) BETWEEN 3 AND 500
  AND (EXISTS(SELECT 1 FROM public.channels c WHERE c.id=m.channel_id AND c.kind='chat')
    OR EXISTS(SELECT 1 FROM public.forum_threads t JOIN public.channels c ON c.id=t.channel_id
      WHERE 'forum:'||t.id::text=m.channel_id AND NOT coalesce(t.deleted,false) AND t.channel_id<>'following'))
UNION ALL
SELECT t.id,t.title||E'\n'||t.body,t.created_at
FROM public.forum_threads t JOIN public.profiles p ON p.username=t.author
JOIN private.noelle_ai_config cfg ON cfg.source_user_id=p.user_id
JOIN public.channels c ON c.id=t.channel_id
WHERE NOT coalesce(t.deleted,false) AND t.channel_id<>'following'
  AND length(btrim(coalesce(t.body,''))) BETWEEN 3 AND 450;

REVOKE ALL ON private.noelle_ai_config,private.noelle_ai_requests,private.noelle_ai_corpus FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT SELECT,UPDATE ON private.noelle_ai_config TO service_role;
GRANT SELECT,INSERT,UPDATE ON private.noelle_ai_requests TO service_role;
GRANT SELECT ON private.noelle_ai_corpus TO service_role;

ALTER TABLE public.profiles ADD CONSTRAINT profiles_noelle_ai_reserved CHECK (
  lower(username)<>'noelleai' OR (user_id IS NULL AND staff_role='member' AND NOT is_admin AND NOT is_owner)
);

-- Extend only the existing server-insertion branches; retain all user, staff,
-- content, channel, and deletion checks in the production trigger definitions.
DO $$
DECLARE name text; definition text;
BEGIN
  FOREACH name IN ARRAY ARRAY['chat_guard_message_mutation','chat_enforce_message_controls'] LOOP
    definition := pg_get_functiondef(('public.'||name||'()')::regprocedure);
    IF position('new.sender = ''Luna''' IN definition)=0 THEN
      RAISE EXCEPTION 'Unexpected definition for %; review bot insertion guard',name;
    END IF;
    definition := replace(definition,'new.sender = ''Luna''','new.sender in (''Luna'', ''NoelleAI'')');
    EXECUTE definition;
  END LOOP;
END $$;

DO $$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('private.chat_capture_message_fact()'::regprocedure);
  IF position('lower(NEW.sender) = ''luna''' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected analytics bot filter'; END IF;
  EXECUTE replace(definition,'lower(NEW.sender) = ''luna''','lower(NEW.sender) IN (''luna'', ''noelleai'')');
  definition := pg_get_functiondef('private.chat_analytics_summary()'::regprocedure);
  EXECUTE replace(definition,'lower(m.sender)<>''luna''','lower(m.sender) NOT IN (''luna'', ''noelleai'')');
END $$;

CREATE FUNCTION public.chat_noelle_claim(p_source_message_id uuid,p_actor_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE cfg private.noelle_ai_config%rowtype; actor public.profiles%rowtype;
  source public.messages%rowtype; existing private.noelle_ai_requests%rowtype;
  examples jsonb; history jsonb; spent bigint; query tsquery;
BEGIN
  SELECT * INTO cfg FROM private.noelle_ai_config WHERE singleton FOR UPDATE;
  IF NOT coalesce(cfg.enabled,false) THEN RAISE EXCEPTION 'noelle_disabled'; END IF;
  SELECT * INTO actor FROM public.profiles WHERE user_id=p_actor_user_id;
  IF actor.username IS NULL OR actor.is_banned OR actor.timeout_until>now() THEN RAISE EXCEPTION 'account_unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.messages m JOIN public.profiles p ON p.username=m.sender
    WHERE m.id=cfg.consent_message_id AND p.user_id=cfg.source_user_id
      AND NOT coalesce(m.deleted,false) AND lower(btrim(m.content))='i agree') THEN
    RAISE EXCEPTION 'consent_unavailable';
  END IF;
  SELECT * INTO source FROM public.messages WHERE id=p_source_message_id;
  IF source.id IS NULL OR source.sender<>actor.username OR coalesce(source.deleted,false)
    OR source.type NOT IN ('text','image') OR source.created_at<now()-interval '1 day' THEN RAISE EXCEPTION 'invalid_source'; END IF;
  IF source.content !~* '(^|[^a-z0-9_@])@noelleai($|[^a-z0-9_])' THEN RAISE EXCEPTION 'noelle_not_invoked'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.channels c WHERE c.id=source.channel_id AND c.kind='chat'
    AND private.chat_staff_rank(actor.staff_role)>=private.chat_staff_rank(coalesce(c.min_speak_role,'member')))
    OR EXISTS(SELECT 1 FROM public.app_settings WHERE key IN ('app_enabled','messages_enabled') AND value='false') THEN
    RAISE EXCEPTION 'channel_unavailable';
  END IF;
  SELECT * INTO existing FROM private.noelle_ai_requests WHERE source_message_id=source.id;
  IF FOUND THEN RETURN jsonb_build_object('duplicate',true,'status',existing.status,'response_message_id',existing.response_message_id); END IF;
  IF (SELECT count(*) FROM private.noelle_ai_requests WHERE actor_user_id=p_actor_user_id AND created_at>now()-interval '1 minute')>=6 THEN RAISE EXCEPTION 'rate_minute'; END IF;
  IF (SELECT count(*) FROM private.noelle_ai_requests WHERE actor_user_id=p_actor_user_id AND created_at>=date_trunc('day',now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago')>=cfg.user_daily_limit THEN RAISE EXCEPTION 'rate_day'; END IF;
  IF (SELECT count(*) FROM private.noelle_ai_requests WHERE status='processing' AND created_at>now()-interval '2 minutes')>=3 THEN RAISE EXCEPTION 'busy'; END IF;
  SELECT coalesce(sum(cost_micros),0) INTO spent FROM private.noelle_ai_requests
    WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago';
  IF spent+5000>cfg.daily_budget_cents::bigint*10000 THEN RAISE EXCEPTION 'budget_day'; END IF;
  query := plainto_tsquery('simple',regexp_replace(source.content,'@noelleai','','gi'));
  WITH candidates AS (
    (SELECT id,content,1 AS priority FROM private.noelle_ai_corpus
      WHERE to_tsvector('simple',content)@@query ORDER BY ts_rank(to_tsvector('simple',content),query) DESC,id LIMIT 24)
    UNION ALL
    (SELECT id,content,2 AS priority FROM private.noelle_ai_corpus ORDER BY md5(id::text) LIMIT 48)
    UNION ALL
    (SELECT id,content,3 AS priority FROM private.noelle_ai_corpus ORDER BY created_at DESC,id LIMIT 16)
  ), unique_examples AS (SELECT id,content,min(priority) priority FROM candidates GROUP BY id,content)
  SELECT coalesce(jsonb_agg(jsonb_build_object('content',content) ORDER BY priority,id),'[]') INTO examples FROM unique_examples;
  SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.created_at,h.id),'[]') INTO history FROM
    (SELECT id,sender,left(content,1200) content,type,created_at FROM public.messages
     WHERE channel_id=source.channel_id AND NOT coalesce(deleted,false) AND type IN ('text','image')
       AND (created_at<source.created_at OR id=source.id) ORDER BY created_at DESC,id DESC LIMIT 16) h;
  INSERT INTO private.noelle_ai_requests(source_message_id,actor_user_id,source_hash) VALUES(source.id,p_actor_user_id,md5(source.content));
  RETURN jsonb_build_object('source',jsonb_build_object('sender',source.sender,'content',source.content),
    'examples',examples,'history',history);
END $$;

CREATE FUNCTION public.chat_noelle_finish(p_source_message_id uuid,p_actor_user_id uuid,p_content text,p_cost_micros integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE request private.noelle_ai_requests%rowtype; source public.messages%rowtype; cfg private.noelle_ai_config%rowtype;
  actor public.profiles%rowtype; result uuid;
BEGIN
  SELECT * INTO cfg FROM private.noelle_ai_config WHERE singleton FOR UPDATE;
  SELECT * INTO request FROM private.noelle_ai_requests WHERE source_message_id=p_source_message_id FOR UPDATE;
  IF request.source_message_id IS NULL OR request.actor_user_id<>p_actor_user_id THEN RAISE EXCEPTION 'invalid_source'; END IF;
  IF request.status<>'processing' THEN RETURN jsonb_build_object('duplicate',true,'response_message_id',request.response_message_id); END IF;
  IF p_content IS NULL OR length(btrim(p_content)) NOT BETWEEN 1 AND 1600 OR p_cost_micros<0 OR p_cost_micros IS NULL THEN RAISE EXCEPTION 'invalid_reply'; END IF;
  SELECT * INTO source FROM public.messages WHERE id=p_source_message_id FOR SHARE;
  SELECT * INTO actor FROM public.profiles WHERE user_id=p_actor_user_id;
  IF source.id IS NULL OR coalesce(source.deleted,false) OR md5(source.content) IS DISTINCT FROM request.source_hash
    OR NOT cfg.enabled OR actor.username IS NULL OR actor.is_banned OR actor.timeout_until>now()
    OR NOT EXISTS(SELECT 1 FROM public.messages m JOIN public.profiles p ON p.username=m.sender
      WHERE m.id=cfg.consent_message_id AND p.user_id=cfg.source_user_id AND NOT coalesce(m.deleted,false)
        AND lower(btrim(m.content))='i agree')
    OR NOT EXISTS(SELECT 1 FROM public.channels c WHERE c.id=source.channel_id AND c.kind='chat'
      AND private.chat_staff_rank(actor.staff_role)>=private.chat_staff_rank(coalesce(c.min_speak_role,'member')))
    OR EXISTS(SELECT 1 FROM public.app_settings WHERE key IN ('app_enabled','messages_enabled') AND value='false') THEN
    UPDATE private.noelle_ai_requests SET status='cancelled',cost_micros=p_cost_micros,completed_at=now() WHERE source_message_id=p_source_message_id;
    RETURN jsonb_build_object('cancelled',true);
  END IF;
  PERFORM set_config('app.luna_reply_insert','true',true);
  INSERT INTO public.messages(channel_id,sender,content,type,reply_to)
  VALUES(source.channel_id,'NoelleAI',btrim(p_content),'text',jsonb_build_object('id',source.id,'sender',source.sender,
    'snippet',left(source.content,90),'bot','noelle','model','gpt-6-luna')) RETURNING id INTO result;
  PERFORM set_config('app.luna_reply_insert','false',true);
  UPDATE private.noelle_ai_requests SET status='completed',cost_micros=p_cost_micros,response_message_id=result,completed_at=now()
    WHERE source_message_id=p_source_message_id;
  RETURN jsonb_build_object('response_message_id',result);
END $$;

CREATE FUNCTION public.chat_noelle_fail(p_source_message_id uuid,p_cost_micros integer,p_code text)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
  UPDATE private.noelle_ai_requests SET status='failed',cost_micros=greatest(coalesce(p_cost_micros,5000),0),
    error_code=left(p_code,60),completed_at=now()
  WHERE source_message_id=p_source_message_id AND status='processing'
$$;

REVOKE ALL ON FUNCTION public.chat_noelle_claim(uuid,uuid),public.chat_noelle_finish(uuid,uuid,text,integer),public.chat_noelle_fail(uuid,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.chat_noelle_claim(uuid,uuid),public.chat_noelle_finish(uuid,uuid,text,integer),public.chat_noelle_fail(uuid,integer,text) TO service_role;

CREATE FUNCTION public.chat_noelle_settings(p_enabled boolean DEFAULT NULL,p_daily_budget_cents integer DEFAULT NULL,p_user_daily_limit integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg private.noelle_ai_config%rowtype;
BEGIN
  IF auth.uid() IS NULL OR NOT private.chat_has_rank(6) THEN RAISE EXCEPTION 'Owner access required'; END IF;
  UPDATE private.noelle_ai_config SET enabled=coalesce(p_enabled,enabled),
    daily_budget_cents=coalesce(p_daily_budget_cents,daily_budget_cents),user_daily_limit=coalesce(p_user_daily_limit,user_daily_limit)
    WHERE singleton RETURNING * INTO cfg;
  RETURN jsonb_build_object('enabled',cfg.enabled,'daily_budget_cents',cfg.daily_budget_cents,'user_daily_limit',cfg.user_daily_limit,
    'spent_micros',(SELECT coalesce(sum(cost_micros),0) FROM private.noelle_ai_requests
      WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'));
END $$;
REVOKE ALL ON FUNCTION public.chat_noelle_settings(boolean,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.chat_noelle_settings(boolean,integer,integer) TO authenticated;
