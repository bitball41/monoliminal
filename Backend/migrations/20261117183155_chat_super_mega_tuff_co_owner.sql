-- Super Mega Tuff Co-owner: a one-of-a-kind role that belongs to PomKnee.
--
-- The role (slug super_mega_tuff_co_owner) has co-owner powers (tier 5) and
-- sits directly above Co-owner on the ladder. On top of co-owner powers it:
--   * belongs to PomKnee only: the database refuses it on any other account,
--     and only the owner or PRESTON can take it away;
--   * cannot be banned, timed out, kicked, deleted, voice-muted or
--     password-reset by anyone (the owner removes the role first if needed);
--   * can clear anyone's timeout;
--   * can publish the announcement banner and What's new;
--   * skips QuoteBot's rate limits (messages already skip slow mode at
--     admin level and above);
--   * has a troll menu: temporary (1-60 minute) client-side effects on another
--     member, such as messages that fail to send and silly popups. Effects
--     never touch the owner, PRESTON or the bots, and the owner can stop them.
BEGIN;
SET LOCAL lock_timeout = '2s';

-- ------------------------------------------------------------------ the role
DO $$
DECLARE
  v_tmp integer;
  v_co integer;
  v_order text[];
BEGIN
  IF EXISTS (SELECT 1 FROM public.chat_staff_roles WHERE slug = 'super_mega_tuff_co_owner') THEN
    RETURN;
  END IF;
  -- Insert at a free position first, then rewrite the ladder with the role
  -- directly above Co-owner. Ties elsewhere are kept by apply_ladder.
  SELECT min(g) INTO v_tmp FROM generate_series(101, 599) g
  WHERE g NOT IN (SELECT power FROM public.chat_staff_roles);
  IF v_tmp IS NULL THEN RAISE EXCEPTION 'No free ladder position for the new role'; END IF;
  INSERT INTO public.chat_staff_roles (slug, label, color, badge, tier, power, builtin, created_by)
  VALUES ('super_mega_tuff_co_owner', 'Super Mega Tuff Co-owner', NULL, 'super-mega-tuff-co-owner', 5, v_tmp, true, 'migration');

  SELECT power INTO v_co FROM public.chat_staff_roles WHERE slug = 'co_owner';
  SELECT array_agg(slug ORDER BY sort_power DESC, slug) INTO v_order FROM (
    SELECT slug, CASE WHEN slug = 'super_mega_tuff_co_owner' THEN v_co + 0.5 ELSE power::numeric END AS sort_power
    FROM public.chat_staff_roles WHERE slug NOT IN ('member', 'owner', 'preston')
  ) x;
  PERFORM private.chat_staff_apply_ladder(v_order);
END $$;

-- True when the signed-in account holds the role and is not banned.
CREATE OR REPLACE FUNCTION private.chat_is_super_mega_tuff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT NOT p.is_banned AND p.staff_role = 'super_mega_tuff_co_owner'
    FROM public.profiles p WHERE p.user_id = auth.uid()), false)
$$;
REVOKE ALL ON FUNCTION private.chat_is_super_mega_tuff() FROM PUBLIC, anon, authenticated;

-- Exclusive, untouchable, and removable only by the owner. Runs after the
-- legacy flag sync (trigger names fire in alphabetical order).
CREATE OR REPLACE FUNCTION private.chat_guard_super_mega_tuff()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.staff_role = 'super_mega_tuff_co_owner' THEN
    IF lower(NEW.username) <> 'pomknee' THEN
      RAISE EXCEPTION 'Super Mega Tuff Co-owner belongs to PomKnee only';
    END IF;
    IF coalesce(NEW.is_banned, false) AND (TG_OP = 'INSERT' OR NOT coalesce(OLD.is_banned, false)) THEN
      RAISE EXCEPTION 'The Super Mega Tuff Co-owner cannot be banned';
    END IF;
    IF NEW.timeout_until > now()
       AND (TG_OP = 'INSERT' OR NEW.timeout_until IS DISTINCT FROM OLD.timeout_until) THEN
      RAISE EXCEPTION 'The Super Mega Tuff Co-owner cannot be timed out';
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
DROP TRIGGER IF EXISTS zz_chat_super_mega_tuff_guard ON public.profiles;
CREATE TRIGGER zz_chat_super_mega_tuff_guard BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION private.chat_guard_super_mega_tuff();

-- Give it to PomKnee and drop them from the legacy co-owner registry.
UPDATE public.profiles SET staff_role = 'super_mega_tuff_co_owner'
WHERE lower(username) = 'pomknee' AND NOT is_banned;
INSERT INTO public.app_settings (key, value, updated_at)
SELECT 'co_owners', coalesce(jsonb_agg(lower(username) ORDER BY lower(username)), '[]'::jsonb)::text, now()
FROM public.profiles WHERE staff_role = 'co_owner'
ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

-- ------------------------------------------------ moderation: untouchable
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
    RAISE EXCEPTION 'The Super Mega Tuff Co-owner is untouchable';
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

-- Clearing a timeout: the Super Mega Tuff Co-owner may clear anyone's.
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

-- ------------------------------------------------------------ announcements
CREATE OR REPLACE FUNCTION public.chat_owner_set_app_setting(p_key text, p_value text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor text;
  v_value text := coalesce(p_value, '');
  v_json jsonb;
begin
  if not private.chat_is_staff(true)
     and not (p_key in ('announcement', 'whats_new') and private.chat_is_super_mega_tuff()) then
    raise exception 'Owner access is required';
  end if;

  if p_key not in ('app_enabled', 'announcement', 'whats_new', 'co_owners', 'community_rules') then
    raise exception 'Unsupported owner setting';
  end if;

  if p_key = 'app_enabled' and v_value not in ('true', 'false') then
    raise exception 'App enabled must be true or false';
  elsif p_key = 'announcement' and char_length(v_value) > 300 then
    raise exception 'Announcement is too long';
  elsif p_key = 'whats_new' and char_length(v_value) > 4000 then
    raise exception 'What''s new is too long';
  elsif p_key = 'community_rules' then
    if v_value <> '' then
      if char_length(v_value) > 30000 then raise exception 'The rules are too long'; end if;
      begin
        v_json := v_value::jsonb;
      exception when others then
        raise exception 'Rules must be a list';
      end;
      if jsonb_typeof(v_json) <> 'array' or jsonb_array_length(v_json) NOT BETWEEN 1 AND 30 then
        raise exception 'Add between 1 and 30 rules';
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_json) item
        where jsonb_typeof(item) <> 'object'
           or jsonb_typeof(item->'title') is distinct from 'string'
           or jsonb_typeof(item->'body') is distinct from 'string'
           or char_length(btrim(item->>'title')) NOT BETWEEN 1 AND 80
           or char_length(btrim(item->>'body')) NOT BETWEEN 1 AND 1000
      ) then
        raise exception 'Each rule needs a title (up to 80 characters) and text (up to 1000)';
      end if;
      select jsonb_agg(jsonb_build_object('title', btrim(e.item->>'title'), 'body', btrim(e.item->>'body')) order by e.ord)::text
      into v_value
      from jsonb_array_elements(v_json) with ordinality e(item, ord);
    end if;
  elsif p_key = 'co_owners' then
    if char_length(v_value) > 10000 then
      raise exception 'Co-owner registry is too large';
    end if;
    begin
      v_json := v_value::jsonb;
    exception when others then
      raise exception 'Co-owner registry must be valid JSON';
    end;
    if jsonb_typeof(v_json) <> 'array'
       or exists (
         select 1
         from jsonb_array_elements(v_json) item
         where jsonb_typeof(item) <> 'string'
            or trim(both '"' from item::text) !~ '^[A-Za-z0-9_]{1,40}$'
       ) then
      raise exception 'Co-owner registry must be an array of usernames';
    end if;
    select coalesce(jsonb_agg(distinct lower(value) order by lower(value)), '[]'::jsonb)::text
    into v_value
    from jsonb_array_elements_text(v_json) entry(value);
  end if;

  v_actor := private.chat_username();

  insert into public.app_settings (key, value, updated_at)
  values (p_key, v_value, now())
  on conflict (key) do update
    set value = excluded.value,
        updated_at = excluded.updated_at;

  insert into private.chat_admin_audit (actor_username, action, target, details)
  values (v_actor, 'owner_setting_updated', p_key, jsonb_build_object('length', char_length(v_value)));

  return true;
end;
$function$;

-- ------------------------------------------------- QuoteBot without limits
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
  unlimited boolean;
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
  unlimited := actor.staff_role = 'super_mega_tuff_co_owner';
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
  IF NOT unlimited THEN
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

-- --------------------------------------------------------------- troll menu
-- Effects are drawn by the target's own browser and expire on their own.
CREATE TABLE IF NOT EXISTS private.chat_troll_effects (
  target text NOT NULL REFERENCES public.profiles(username) ON UPDATE CASCADE ON DELETE CASCADE,
  effect text NOT NULL CHECK (effect IN ('fail_send', 'popups', 'upside_down', 'mirror', 'shake',
    'comic_sans', 'rainbow', 'blur', 'emoji_rain', 'no_cursor')),
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target, effect)
);
ALTER TABLE private.chat_troll_effects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.chat_troll_effects FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.chat_troll_effects_of(p_username text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('effect', t.effect, 'expires_at', t.expires_at) ORDER BY t.effect), '[]'::jsonb)
  FROM private.chat_troll_effects t WHERE t.target = p_username AND t.expires_at > now()
$$;
CREATE OR REPLACE FUNCTION private.chat_troll_broadcast(p_username text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.chat_rt_send(private.chat_rt_user_topics(ARRAY[p_username]), 'troll_effects',
    jsonb_build_object('effects', private.chat_troll_effects_of(p_username)));
END;
$$;
REVOKE ALL ON FUNCTION private.chat_troll_effects_of(text), private.chat_troll_broadcast(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.chat_troll_apply(p_target text, p_effects text[], p_minutes integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor text := private.chat_username();
  v_target public.profiles%rowtype;
  v_effects text[];
BEGIN
  IF NOT private.chat_is_super_mega_tuff() THEN
    RAISE EXCEPTION 'Only the Super Mega Tuff Co-owner can troll';
  END IF;
  IF p_minutes IS NULL OR p_minutes NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Trolls last between 1 and 60 minutes';
  END IF;
  SELECT array_agg(DISTINCT e) INTO v_effects FROM unnest(coalesce(p_effects, '{}')) e;
  IF v_effects IS NULL OR cardinality(v_effects) > 10 THEN
    RAISE EXCEPTION 'Pick at least one troll';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_effects) e WHERE e IS NULL OR e NOT IN ('fail_send', 'popups', 'upside_down',
      'mirror', 'shake', 'comic_sans', 'rainbow', 'blur', 'emoji_rain', 'no_cursor')) THEN
    RAISE EXCEPTION 'Unknown troll';
  END IF;
  SELECT * INTO v_target FROM public.profiles WHERE lower(username) = lower(btrim(coalesce(p_target, '')));
  IF v_target.username IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_target.username = v_actor THEN RAISE EXCEPTION 'You cannot troll yourself'; END IF;
  IF v_target.staff_role IN ('owner', 'preston') THEN RAISE EXCEPTION 'The owner and PRESTON cannot be trolled'; END IF;
  IF lower(v_target.username) IN ('luna', 'quotebot') THEN RAISE EXCEPTION 'Bots cannot be trolled'; END IF;
  IF v_target.is_banned THEN RAISE EXCEPTION 'That account is banned'; END IF;

  DELETE FROM private.chat_troll_effects WHERE expires_at <= now();
  INSERT INTO private.chat_troll_effects (target, effect, expires_at, created_by)
  SELECT v_target.username, e, now() + make_interval(mins => p_minutes), v_actor FROM unnest(v_effects) e
  ON CONFLICT (target, effect) DO UPDATE
    SET expires_at = excluded.expires_at, created_by = excluded.created_by, created_at = now();

  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (v_actor, 'troll_applied', v_target.username,
          jsonb_build_object('effects', to_jsonb(v_effects), 'minutes', p_minutes));
  PERFORM private.chat_troll_broadcast(v_target.username);
  RETURN private.chat_troll_effects_of(v_target.username);
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_troll_clear(p_target text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_target text;
BEGIN
  IF NOT (private.chat_is_super_mega_tuff() OR private.chat_is_staff(true)) THEN
    RAISE EXCEPTION 'Only the Super Mega Tuff Co-owner or the owner can stop trolls';
  END IF;
  SELECT username INTO v_target FROM public.profiles WHERE lower(username) = lower(btrim(coalesce(p_target, '')));
  IF v_target IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  DELETE FROM private.chat_troll_effects WHERE target = v_target;
  INSERT INTO private.chat_admin_audit (actor_username, action, target)
  VALUES (private.chat_username(), 'troll_cleared', v_target);
  PERFORM private.chat_troll_broadcast(v_target);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_troll_list()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (private.chat_is_super_mega_tuff() OR private.chat_is_staff(true)) THEN
    RAISE EXCEPTION 'Only the Super Mega Tuff Co-owner or the owner can see trolls';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('target', x.target, 'effects', x.effects) ORDER BY lower(x.target))
    FROM (SELECT t.target, jsonb_agg(jsonb_build_object('effect', t.effect, 'expires_at', t.expires_at) ORDER BY t.effect) effects
          FROM private.chat_troll_effects t WHERE t.expires_at > now() GROUP BY t.target) x
  ), '[]'::jsonb);
END;
$$;

-- What the signed-in member is currently trolled with (read on connect).
CREATE OR REPLACE FUNCTION public.chat_my_troll_effects()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN private.chat_username() IS NULL THEN '[]'::jsonb
    ELSE private.chat_troll_effects_of(private.chat_username()) END
$$;

REVOKE ALL ON FUNCTION public.chat_troll_apply(text, text[], integer), public.chat_troll_clear(text),
  public.chat_troll_list(), public.chat_my_troll_effects() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_troll_apply(text, text[], integer), public.chat_troll_clear(text),
  public.chat_troll_list(), public.chat_my_troll_effects() TO authenticated;

COMMIT;
