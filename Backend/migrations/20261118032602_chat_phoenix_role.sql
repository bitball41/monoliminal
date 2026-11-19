-- Phoenix: a one-of-a-kind role for Kirk, equal to the Super Mega Tuff
-- Co-owner.
--
-- The role (slug phoenix) has co-owner powers (tier 5) and is tied with the
-- Super Mega Tuff Co-owner at the top of the staff ladder (only Owner and
-- PRESTON sit above them). It gets every perk that role has:
--   * belongs to Kirk only, and only the owner can take it away;
--   * only Conno can ban, time out, kick, delete or otherwise moderate it, and
--     a timeout from Conno sticks;
--   * clears anyone's timeout (its own too, unless Conno gave it);
--   * publishes the announcement banner and What's new;
--   * lighter QuoteBot limits;
--   * the full troll menu (every troll and the one-shot refresh), seeing and
--     stopping active trolls;
--   * its own custom check mark (app_settings.phoenix_check). Until Kirk sets
--     one, Chat draws a fire badge.
-- Being tied, the two roles cannot moderate each other; they can troll each
-- other. Chat pages without this change show Kirk with a plain badge.
BEGIN;
SET LOCAL lock_timeout = '2s';

-- ----------------------------------------------- ladder: both roles on top
-- Same as before, except every top role is moved to the front and they share
-- the highest position. Ties below them are kept.
CREATE OR REPLACE FUNCTION private.chat_staff_apply_ladder(p_order text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_expected text[];
  v_given text[];
  v_order text[];
  v_top text[];
  v_slug text;
  v_old integer;
  v_prev_old integer;
  v_power integer := 600;
BEGIN
  PERFORM 1 FROM public.chat_staff_roles WHERE slug NOT IN ('member', 'owner', 'preston') FOR UPDATE;
  SELECT array_agg(slug ORDER BY slug) INTO v_expected FROM public.chat_staff_roles WHERE slug NOT IN ('member', 'owner', 'preston');
  SELECT array_agg(s ORDER BY s) INTO v_given FROM (SELECT DISTINCT lower(s) s FROM unnest(p_order) s) x;
  IF p_order IS NULL OR v_given IS DISTINCT FROM v_expected OR cardinality(p_order) <> cardinality(v_expected) THEN
    RAISE EXCEPTION 'Send every staff role exactly once';
  END IF;
  IF cardinality(p_order) > 498 THEN RAISE EXCEPTION 'Too many roles'; END IF;
  SELECT array_agg(lower(s) ORDER BY i) INTO v_order FROM unnest(p_order) WITH ORDINALITY u(s, i);
  -- The Super Mega Tuff Co-owner and Phoenix always come first, tied.
  SELECT coalesce(array_agg(t), '{}') INTO v_top
  FROM unnest(ARRAY['super_mega_tuff_co_owner', 'phoenix']) t WHERE t = ANY (v_order);
  IF cardinality(v_top) > 0 THEN
    v_power := 599;
    UPDATE public.chat_staff_roles SET power = v_power, updated_at = now() WHERE slug = ANY (v_top);
  END IF;
  FOREACH v_slug IN ARRAY v_order LOOP
    CONTINUE WHEN v_slug = ANY (v_top);
    SELECT power INTO v_old FROM public.chat_staff_roles WHERE slug = v_slug;
    IF v_prev_old IS NULL OR v_old IS DISTINCT FROM v_prev_old THEN v_power := v_power - 1; END IF;
    v_prev_old := v_old;
    UPDATE public.chat_staff_roles SET power = v_power, updated_at = now() WHERE slug = v_slug;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_staff_apply_ladder(text[]) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------ the role
DO $$
DECLARE
  v_tmp integer;
  v_order text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chat_staff_roles WHERE slug = 'phoenix') THEN
    SELECT min(g) INTO v_tmp FROM generate_series(101, 599) g
    WHERE g NOT IN (SELECT power FROM public.chat_staff_roles);
    IF v_tmp IS NULL THEN RAISE EXCEPTION 'No free ladder position for the new role'; END IF;
    INSERT INTO public.chat_staff_roles (slug, label, color, badge, tier, power, builtin, created_by)
    VALUES ('phoenix', 'Phoenix', NULL, 'phoenix', 5, v_tmp, true, 'migration');
  END IF;
  SELECT array_agg(slug ORDER BY power DESC, slug) INTO v_order
  FROM public.chat_staff_roles WHERE slug NOT IN ('member', 'owner', 'preston');
  PERFORM private.chat_staff_apply_ladder(v_order);
END $$;

-- True when the signed-in, unbanned account holds the Super Mega Tuff
-- Co-owner or Phoenix role. Announcements, seeing and stopping trolls and the
-- check mark editor go through this.
CREATE OR REPLACE FUNCTION private.chat_is_super_mega_tuff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT NOT p.is_banned AND p.staff_role IN ('super_mega_tuff_co_owner', 'phoenix')
    FROM public.profiles p WHERE p.user_id = auth.uid()), false)
$$;
REVOKE ALL ON FUNCTION private.chat_is_super_mega_tuff() FROM PUBLIC, anon, authenticated;

-- Troll menu: either role, or Conno.
CREATE OR REPLACE FUNCTION private.chat_can_troll()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT NOT p.is_banned AND (p.staff_role IN ('super_mega_tuff_co_owner', 'phoenix')
      OR (lower(p.username) = 'connor' AND p.staff_role = 'owner'))
    FROM public.profiles p WHERE p.user_id = auth.uid()), false)
$$;
REVOKE ALL ON FUNCTION private.chat_can_troll() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.chat_troll_target(p_target text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_target public.profiles%rowtype;
BEGIN
  IF NOT private.chat_can_troll() THEN
    RAISE EXCEPTION 'Only the Super Mega Tuff Co-owner, Phoenix or Conno can troll';
  END IF;
  SELECT * INTO v_target FROM public.profiles WHERE lower(username) = lower(btrim(coalesce(p_target, '')));
  IF v_target.username IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_target.username = private.chat_username() THEN RAISE EXCEPTION 'You cannot troll yourself'; END IF;
  IF v_target.staff_role IN ('owner', 'preston') THEN RAISE EXCEPTION 'The owner and PRESTON cannot be trolled'; END IF;
  IF lower(v_target.username) IN ('luna', 'quotebot') THEN RAISE EXCEPTION 'Bots cannot be trolled'; END IF;
  IF v_target.is_banned THEN RAISE EXCEPTION 'That account is banned'; END IF;
  RETURN v_target.username;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_troll_target(text) FROM PUBLIC, anon, authenticated;

-- Exclusive, untouchable except by Conno, and removable only by the owner.
CREATE OR REPLACE FUNCTION private.chat_guard_super_mega_tuff()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_conno boolean := coalesce(current_setting('app.smt_consequence', true), '') = 'connor';
  v_name text := CASE NEW.staff_role WHEN 'phoenix' THEN 'Phoenix' ELSE 'Super Mega Tuff Co-owner' END;
BEGIN
  IF NEW.staff_role = 'super_mega_tuff_co_owner' AND lower(NEW.username) <> 'pomknee' THEN
    RAISE EXCEPTION 'Super Mega Tuff Co-owner belongs to PomKnee only';
  END IF;
  IF NEW.staff_role = 'phoenix' AND lower(NEW.username) <> 'kirk' THEN
    RAISE EXCEPTION 'Phoenix belongs to Kirk only';
  END IF;
  IF NEW.staff_role IN ('super_mega_tuff_co_owner', 'phoenix') THEN
    IF coalesce(NEW.is_banned, false) AND (TG_OP = 'INSERT' OR NOT coalesce(OLD.is_banned, false)) AND NOT v_conno THEN
      RAISE EXCEPTION 'Only Conno can ban the %', v_name;
    END IF;
    IF NEW.timeout_until > now()
       AND (TG_OP = 'INSERT' OR NEW.timeout_until IS DISTINCT FROM OLD.timeout_until) AND NOT v_conno THEN
      RAISE EXCEPTION 'Only Conno can time out the %', v_name;
    END IF;
  END IF;
  -- Signed-in callers below the owner cannot take either role away.
  IF TG_OP = 'UPDATE' AND OLD.staff_role IN ('super_mega_tuff_co_owner', 'phoenix')
     AND NEW.staff_role IS DISTINCT FROM OLD.staff_role AND auth.uid() IS NOT NULL
     AND NOT private.chat_has_rank(6) THEN
    RAISE EXCEPTION 'Only the owner can change the % role',
      CASE OLD.staff_role WHEN 'phoenix' THEN 'Phoenix' ELSE 'Super Mega Tuff Co-owner' END;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_guard_super_mega_tuff() FROM PUBLIC, anon, authenticated;

-- Give it to Kirk and drop them from the legacy co-owner registry.
UPDATE public.profiles SET staff_role = 'phoenix'
WHERE lower(username) = 'kirk' AND NOT is_banned;
INSERT INTO public.app_settings (key, value, updated_at)
SELECT 'co_owners', coalesce(jsonb_agg(lower(username) ORDER BY lower(username)), '[]'::jsonb)::text, now()
FROM public.profiles WHERE staff_role = 'co_owner'
ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

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
  IF v_target.staff_role IN ('super_mega_tuff_co_owner', 'phoenix') AND p_action <> 'unban' THEN
    IF lower(v_actor.username) <> 'connor' OR v_actor.staff_role <> 'owner' THEN
      RAISE EXCEPTION 'Only Conno can moderate the %',
        CASE v_target.staff_role WHEN 'phoenix' THEN 'Phoenix' ELSE 'Super Mega Tuff Co-owner' END;
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

-- Either role clears anyone's timeout, but not one Conno gave it.
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

  IF p_minutes = 0 AND v_actor.staff_role IN ('super_mega_tuff_co_owner', 'phoenix') THEN
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
  tuff := actor.staff_role IN ('super_mega_tuff_co_owner', 'phoenix');
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

-- ------------------------------------------------------- custom check mark
-- Each holder styles their own: PomKnee writes smt_check, Kirk phoenix_check.
CREATE OR REPLACE FUNCTION public.chat_set_smt_check(p_symbol text, p_colors text[], p_animation text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_symbol text := btrim(coalesce(p_symbol, ''));
  v_colors text[];
  v_value text;
  v_key text;
BEGIN
  IF NOT private.chat_is_super_mega_tuff() THEN
    RAISE EXCEPTION 'Only the Super Mega Tuff Co-owner or Phoenix can change this check mark';
  END IF;
  SELECT CASE p.staff_role WHEN 'phoenix' THEN 'phoenix_check' ELSE 'smt_check' END INTO v_key
  FROM public.profiles p WHERE p.user_id = auth.uid();
  IF p_colors IS NULL AND p_symbol IS NULL AND p_animation IS NULL THEN
    v_value := '';
  ELSE
    IF char_length(v_symbol) > 8 OR v_symbol ~ '[<>&"''`\\[:cntrl:]]' THEN
      RAISE EXCEPTION 'Use up to 8 characters, like an emoji';
    END IF;
    SELECT array_agg(lower(c) ORDER BY i) INTO v_colors FROM unnest(coalesce(p_colors, '{}')) WITH ORDINALITY u(c, i);
    IF v_colors IS NULL OR cardinality(v_colors) NOT BETWEEN 1 AND 4
       OR EXISTS (SELECT 1 FROM unnest(v_colors) c WHERE c IS NULL OR c !~ '^#[0-9a-f]{6}$') THEN
      RAISE EXCEPTION 'Pick 1 to 4 colours like #a855f7';
    END IF;
    IF coalesce(p_animation, '') NOT IN ('spin', 'pulse', 'bounce', 'none') THEN
      RAISE EXCEPTION 'Choose spin, pulse, bounce or none';
    END IF;
    v_value := jsonb_build_object('symbol', v_symbol, 'colors', to_jsonb(v_colors), 'animation', p_animation)::text;
  END IF;
  INSERT INTO public.app_settings (key, value, updated_at) VALUES (v_key, v_value, now())
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (private.chat_username(), 'smt_check_updated', v_key, jsonb_build_object('length', char_length(v_value)));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_set_smt_check(text, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_set_smt_check(text, text[], text) TO authenticated;

COMMIT;
