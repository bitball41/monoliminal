-- QuoteBot replaces Noelle AI as Chat's second server-side bot account.
--
-- Part 1 removes Noelle AI: its RPCs, config, request ledger and live corpus
-- view. Existing NoelleAI messages and the owner-preview conversations around
-- them are kept as history and stay hidden from non-owners; the
-- owner_preview column, its RESTRICTIVE policy and the reserved NoelleAI name
-- remain so those rows cannot leak or be impersonated.
--
-- Part 2 adds QuoteBot. A member replies to a channel message with /quote;
-- chat_post_quote copies that message's text server-side and posts it as
-- QuoteBot, so a quote can never claim words someone did not write. Clients
-- draw the quote card from that snapshot. No images are uploaded or stored.

-- ============================== Part 1: Noelle AI ==============================
DO $$
DECLARE fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname = 'public' AND p.proname LIKE 'chat\_noelle\_%')
       OR (n.nspname = 'private' AND p.proname = 'noelle_ai_reference')
  LOOP
    EXECUTE 'DROP FUNCTION ' || fn;
  END LOOP;
END $$;
DROP VIEW IF EXISTS private.noelle_ai_corpus;
DROP TABLE IF EXISTS private.noelle_ai_requests;
DROP TABLE IF EXISTS private.noelle_ai_config;

-- Mentioning @NoelleAI is ordinary text again. Rows that are already owner
-- preview, and replies to them, stay owner-only.
CREATE OR REPLACE FUNCTION private.chat_mark_owner_preview() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE protected boolean := false;
BEGIN
  IF TG_OP='UPDATE' AND NEW.owner_preview IS DISTINCT FROM OLD.owner_preview THEN
    RAISE EXCEPTION 'Message visibility is assigned by the server';
  END IF;
  IF TG_OP='UPDATE' THEN protected := OLD.owner_preview; END IF;
  IF NEW.reply_to IS NOT NULL THEN
    protected := protected OR EXISTS(SELECT 1 FROM public.messages m
      WHERE m.id::text=NEW.reply_to->>'id' AND m.channel_id=NEW.channel_id AND m.owner_preview);
  END IF;
  NEW.owner_preview := protected;
  IF protected AND NOT private.chat_has_rank(6) THEN
    RAISE EXCEPTION 'This conversation is private to owners';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.chat_mark_owner_preview() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.chat_mark_owner_preview_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.messages m WHERE m.owner_preview
    AND m.id::text=NEW.details->>'message_id')
    OR (NEW.details->>'message_id')=current_setting('app.owner_preview_delete_id',true) THEN
    NEW.details := coalesce(NEW.details,'{}') || jsonb_build_object('owner_preview',true);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.chat_mark_owner_preview_audit() FROM PUBLIC,anon,authenticated;

-- ============================== Part 2: QuoteBot ==============================
-- Nobody can register or rename to the bot's name.
ALTER TABLE public.profiles ADD CONSTRAINT profiles_quotebot_reserved
  CHECK (lower(username) <> 'quotebot');

-- Swap NoelleAI for QuoteBot in the existing server-insert branch. Every
-- other user, staff, content, channel and deletion check is left unchanged.
DO $$
DECLARE name text; definition text;
BEGIN
  FOREACH name IN ARRAY ARRAY['chat_guard_message_mutation','chat_enforce_message_controls'] LOOP
    definition := pg_get_functiondef(('public.'||name||'()')::regprocedure);
    IF position('new.sender in (''Luna'', ''NoelleAI'')' IN definition)=0 THEN
      RAISE EXCEPTION 'Unexpected definition for %; review bot insertion guard',name;
    END IF;
    EXECUTE replace(definition,'new.sender in (''Luna'', ''NoelleAI'')','new.sender in (''Luna'', ''QuoteBot'')');
  END LOOP;
END $$;

-- Request ledger for rate limits. Browsers cannot read it.
CREATE TABLE private.chat_quote_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requester text NOT NULL,
  source_message_id uuid NOT NULL,
  quote_message_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_quote_requests_requester_created ON private.chat_quote_requests(requester, created_at DESC);
ALTER TABLE private.chat_quote_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.chat_quote_requests FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.chat_post_quote(p_source_message_id uuid, p_style text DEFAULT 'classic')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor public.profiles%rowtype;
  source public.messages%rowtype;
  channel public.channels%rowtype;
  quoted_name text;
  quote_text text;
  privileged boolean;
  slow integer := 0;
  last_at timestamptz;
  result public.messages%rowtype;
BEGIN
  SELECT * INTO actor FROM public.profiles WHERE user_id = auth.uid();
  IF actor.username IS NULL OR actor.is_banned THEN RAISE EXCEPTION 'Active account required'; END IF;
  IF actor.timeout_until IS NOT NULL AND actor.timeout_until > now() THEN
    RAISE EXCEPTION 'You are timed out and cannot send messages right now';
  END IF;
  privileged := actor.is_admin OR actor.is_owner;
  IF EXISTS(SELECT 1 FROM public.app_settings WHERE key='app_enabled' AND value='false') AND NOT actor.is_owner THEN
    RAISE EXCEPTION 'Corazon Chat is currently disabled';
  END IF;
  IF EXISTS(SELECT 1 FROM public.app_settings WHERE key='messages_enabled' AND value='false') AND NOT privileged THEN
    RAISE EXCEPTION 'Message sending is currently paused';
  END IF;
  IF p_style IS NULL OR p_style NOT IN ('classic','color','light') THEN
    RAISE EXCEPTION 'Choose classic, color or light';
  END IF;

  SELECT * INTO source FROM public.messages WHERE id = p_source_message_id;
  IF source.id IS NULL OR coalesce(source.deleted,false)
     OR (source.owner_preview AND NOT private.chat_has_rank(6)) THEN
    RAISE EXCEPTION 'Message not found';
  END IF;
  SELECT * INTO channel FROM public.channels WHERE id = source.channel_id;
  IF channel.id IS NULL OR channel.kind <> 'chat' THEN
    RAISE EXCEPTION 'QuoteBot only works in text channels';
  END IF;
  IF private.chat_staff_rank(actor.staff_role) < private.chat_staff_rank(coalesce(channel.min_speak_role,'member')) THEN
    RAISE EXCEPTION 'You cannot send messages in this channel';
  END IF;
  IF source.sender = 'QuoteBot' THEN RAISE EXCEPTION 'You cannot quote a quote'; END IF;
  quote_text := btrim(coalesce(source.content,''));
  IF quote_text = '' OR coalesce(source.type,'text') IN ('poll','system','quote') THEN
    RAISE EXCEPTION 'That message has no text to quote';
  END IF;

  -- One request at a time per member, so the limits below cannot be raced.
  PERFORM pg_advisory_xact_lock(hashtext('chat_quote:' || actor.username));
  SELECT max(created_at) INTO last_at FROM private.chat_quote_requests WHERE requester = actor.username;
  IF NOT privileged THEN
    BEGIN
      SELECT value::integer INTO slow FROM public.app_settings WHERE key='slow_mode_seconds';
    EXCEPTION WHEN others THEN slow := 0;
    END;
  END IF;
  IF last_at > now() - make_interval(secs => greatest(5, least(coalesce(slow,0), 300))) THEN
    RAISE EXCEPTION 'QuoteBot needs a few seconds between quotes';
  END IF;
  IF (SELECT count(*) FROM private.chat_quote_requests
      WHERE requester = actor.username AND created_at > now() - interval '10 minutes') >= 10 THEN
    RAISE EXCEPTION 'That is a lot of quotes. Try again in a few minutes';
  END IF;
  IF EXISTS(SELECT 1 FROM private.chat_quote_requests
      WHERE requester = actor.username AND source_message_id = source.id
        AND created_at > now() - interval '10 minutes') THEN
    RAISE EXCEPTION 'You just quoted that message';
  END IF;

  SELECT coalesce(nullif(btrim(p.display_name),''), source.sender) INTO quoted_name
  FROM public.profiles p WHERE p.username = source.sender;
  quoted_name := coalesce(quoted_name, source.sender);

  PERFORM set_config('app.luna_reply_insert','true',true);
  INSERT INTO public.messages(channel_id,sender,content,type,media_url,reply_to)
  VALUES(source.channel_id,'QuoteBot','','quote','',jsonb_build_object(
    'id',source.id,'sender',source.sender,'snippet',left(quote_text,90),
    'bot','quote','requested_by',actor.username,
    'quote',jsonb_build_object('text',left(quote_text,1000),'display_name',left(quoted_name,40),
      'style',p_style,'said_at',source.created_at)))
  RETURNING * INTO result;
  PERFORM set_config('app.luna_reply_insert','false',true);

  INSERT INTO private.chat_quote_requests(requester,source_message_id,quote_message_id)
  VALUES(actor.username,source.id,result.id);
  RETURN to_jsonb(result) - 'search_tsv';
END $$;
REVOKE ALL ON FUNCTION public.chat_post_quote(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.chat_post_quote(uuid,text) TO authenticated;

-- The member who asked for a quote and the member quoted may remove it, as
-- well as staff (who already can through the normal delete path).
CREATE FUNCTION public.chat_delete_quote(p_message_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text := private.chat_username(); quote public.messages%rowtype;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO quote FROM public.messages WHERE id = p_message_id AND sender = 'QuoteBot' FOR UPDATE;
  IF quote.id IS NULL OR (quote.owner_preview AND NOT private.chat_has_rank(6)) THEN
    RAISE EXCEPTION 'Quote not found';
  END IF;
  IF coalesce(quote.deleted,false) THEN RETURN true; END IF;
  IF actor IS DISTINCT FROM quote.reply_to->>'requested_by'
     AND actor IS DISTINCT FROM quote.reply_to->>'sender'
     AND NOT private.chat_is_staff(false) THEN
    RAISE EXCEPTION 'You cannot delete this quote';
  END IF;
  PERFORM set_config('app.chat_admin_delete','true',true);
  UPDATE public.messages SET deleted = true WHERE id = quote.id;
  PERFORM set_config('app.chat_admin_delete','false',true);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.chat_delete_quote(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.chat_delete_quote(uuid) TO authenticated;
