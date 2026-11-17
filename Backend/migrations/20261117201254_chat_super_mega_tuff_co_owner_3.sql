-- Super Mega Tuff Co-owner, part 3.
--
--   * Consequences: only Conno (the owner account "connor") can ban, time out,
--     kick, delete or otherwise moderate the role holder. Everyone else,
--     PRESTON included, is still refused. A timeout from Conno sticks: the
--     holder cannot lift it themselves.
--   * Spam: QuoteBot limits are lighter for the role instead of absent:
--     1 second between quotes (members: 5), 30 quotes per 10 minutes
--     (members: 10), and the same message once a minute (members: 10 minutes).
BEGIN;
SET LOCAL lock_timeout = '2s';

-- ------------------------------------------------ only Conno can moderate
CREATE OR REPLACE FUNCTION private.chat_require_moderation_target(p_actor_username text, p_target_username text, p_min_rank integer, p_action text)
 RETURNS profiles
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
BEGIN
  SELECT * INTO v_actor FROM public.profiles
  WHERE username = p_actor_username AND NOT is_banned FOR UPDATE;
  IF v_actor.username IS NULL OR private.chat_staff_rank(v_actor.staff_role) < p_min_rank THEN
    RAISE EXCEPTION 'Insufficient staff permission';
  END IF;
  IF p_action IN ('ban', 'unban') AND private.chat_staff_rank(v_actor.staff_role) = 4 THEN
    RAISE EXCEPTION 'Admins cannot manage bans';
  END IF;
  SELECT * INTO v_target FROM public.profiles
  WHERE lower(username) = lower(btrim(p_target_username)) FOR UPDATE;
  IF v_target.username IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_target.staff_role = 'super_mega_tuff_co_owner' AND p_action <> 'unban' THEN
    IF lower(v_actor.username) <> 'connor' OR v_actor.staff_role <> 'owner' THEN
      RAISE EXCEPTION 'Only Conno can moderate the Super Mega Tuff Co-owner';
    END IF;
    -- Lets the profile guard accept this one ban or timeout, for this transaction only.
    PERFORM set_config('app.smt_consequence', 'connor', true);
  END IF;
  IF v_target.username = v_actor.username OR v_target.staff_role IN ('owner', 'preston')
     OR private.chat_staff_power(v_actor.staff_role) <= private.chat_staff_power(v_target.staff_role) THEN
    RAISE EXCEPTION 'You can only moderate another account below your rank';
  END IF;
  IF p_action = 'timeout' AND lower(v_target.username) = 'luna' THEN
    RAISE EXCEPTION 'Luna cannot be timed out';
  END IF;
  RETURN v_target;
END;
$function$;

CREATE OR REPLACE FUNCTION private.chat_guard_super_mega_tuff()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_conno boolean := coalesce(current_setting('app.smt_consequence', true), '') = 'connor';
BEGIN
  IF NEW.staff_role = 'super_mega_tuff_co_owner' THEN
    IF lower(NEW.username) <> 'pomknee' THEN
      RAISE EXCEPTION 'Super Mega Tuff Co-owner belongs to PomKnee only';
    END IF;
    IF coalesce(NEW.is_banned, false) AND (TG_OP = 'INSERT' OR NOT coalesce(OLD.is_banned, false)) AND NOT v_conno THEN
      RAISE EXCEPTION 'Only Conno can ban the Super Mega Tuff Co-owner';
    END IF;
    IF NEW.timeout_until > now()
       AND (TG_OP = 'INSERT' OR NEW.timeout_until IS DISTINCT FROM OLD.timeout_until) AND NOT v_conno THEN
      RAISE EXCEPTION 'Only Conno can time out the Super Mega Tuff Co-owner';
    END IF;
  END IF;
  -- Signed-in callers below the owner cannot take the role away.
  IF TG_OP = 'UPDATE' AND OLD.staff_role = 'super_mega_tuff_co_owner'
     AND NEW.staff_role IS DISTINCT FROM OLD.staff_role AND auth.uid() IS NOT NULL
     AND NOT private.chat_has_rank(6) THEN
    RAISE EXCEPTION 'Only the owner can change the Super Mega Tuff Co-owner role';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_guard_super_mega_tuff() FROM PUBLIC, anon, authenticated;

-- The role still clears anyone's timeout, but not one Conno gave it.
CREATE OR REPLACE FUNCTION public.chat_staff_timeout_user(p_actor_username text, p_actor_password_hash text, p_target_username text, p_minutes integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_until timestamptz;
  v_max integer;
BEGIN
  IF p_minutes NOT BETWEEN 0 AND 10080 THEN
    RAISE EXCEPTION 'Timeout must be between 0 minutes and 7 days';
  END IF;

  v_actor := private.require_chat_staff_min_rank(2);

  IF p_minutes = 0 AND v_actor.staff_role = 'super_mega_tuff_co_owner' THEN
    SELECT * INTO v_target FROM public.profiles
    WHERE lower(username) = lower(btrim(p_target_username)) FOR UPDATE;
    IF v_target.username IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
    IF v_target.username = v_actor.username AND v_target.timeout_until > now()
       AND lower(coalesce(v_target.timeout_by, '')) = 'connor' THEN
      RAISE EXCEPTION 'Only Conno can lift a timeout from Conno';
    END IF;
    UPDATE public.profiles SET timeout_until = NULL, timeout_by = ''
    WHERE username = v_target.username;
    INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
    VALUES (v_actor.username, 'timeout_cleared_in_chat', v_target.username, jsonb_build_object('minutes', 0));
    RETURN true;
  END IF;

  v_target := private.chat_require_moderation_target(v_actor.username, p_target_username, 2, 'timeout');

  v_max := CASE WHEN private.chat_staff_rank(v_actor.staff_role) = 2 THEN 120 ELSE 10080 END;
  IF p_minutes > v_max THEN
    RAISE EXCEPTION 'Your rank can only timeout up to % minutes', v_max;
  END IF;

  v_until := CASE WHEN p_minutes = 0 THEN NULL ELSE now() + pg_catalog.make_interval(mins => p_minutes) END;

  UPDATE public.profiles
  SET timeout_until = v_until,
      timeout_by = CASE WHEN v_until IS NULL THEN '' ELSE v_actor.username END
  WHERE username = v_target.username;

  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (
    v_actor.username,
    CASE WHEN v_until IS NULL THEN 'timeout_cleared_in_chat' ELSE 'user_timed_out_in_chat' END,
    v_target.username,
    jsonb_build_object('minutes', p_minutes)
  );
  RETURN true;
END;
$function$;

-- ------------------------------------------------- QuoteBot: lighter limits
CREATE OR REPLACE FUNCTION public.chat_post_quote(p_source_message_id uuid, p_style text DEFAULT 'classic'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  actor public.profiles%rowtype;
  source public.messages%rowtype;
  channel public.channels%rowtype;
  quoted_name text;
  quote_text text;
  privileged boolean;
  tuff boolean;
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
  tuff := actor.staff_role = 'super_mega_tuff_co_owner';
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
  IF last_at > now() - (CASE WHEN tuff THEN interval '1 second'
                             ELSE make_interval(secs => greatest(5, least(coalesce(slow,0), 300))) END) THEN
    RAISE EXCEPTION 'QuoteBot needs a few seconds between quotes';
  END IF;
  IF (SELECT count(*) FROM private.chat_quote_requests
      WHERE requester = actor.username AND created_at > now() - interval '10 minutes') >= (CASE WHEN tuff THEN 30 ELSE 10 END) THEN
    RAISE EXCEPTION 'That is a lot of quotes. Try again in a few minutes';
  END IF;
  IF EXISTS(SELECT 1 FROM private.chat_quote_requests
      WHERE requester = actor.username AND source_message_id = source.id
        AND created_at > now() - (CASE WHEN tuff THEN interval '1 minute' ELSE interval '10 minutes' END)) THEN
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
END $function$;

COMMIT;
