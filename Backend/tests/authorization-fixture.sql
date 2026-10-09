-- Minimal Supabase runtime for isolated authorization tests; no production rows or credentials.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA private;
CREATE SCHEMA storage;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
$$;
GRANT USAGE ON SCHEMA auth,public,storage TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;
CREATE TABLE private.chat_upload_grants(storage_path text,consumed_at timestamptz,expires_at timestamptz);
CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,bucket_id text,name text,owner_id text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql AS $$SELECT string_to_array($1,'/')$$;
GRANT ALL ON storage.objects TO anon,authenticated,service_role;
CREATE SCHEMA realtime;
CREATE TABLE realtime.messages(id uuid DEFAULT gen_random_uuid(),topic text NOT NULL,extension text NOT NULL,
  payload jsonb,event text,private boolean DEFAULT false,inserted_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('realtime.topic',true),'')::text
$$;
GRANT USAGE ON SCHEMA realtime TO anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON realtime.messages TO anon,authenticated,service_role;

CREATE TABLE "private"."chat_admin_audit" (
  "id" int8 GENERATED ALWAYS AS IDENTITY NOT NULL,
  "actor_username" text NOT NULL,
  "action" text NOT NULL,
  "target" text,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "private"."chat_admin_sessions" (
  "token_hash" bytea NOT NULL,
  "username" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL
);

CREATE TABLE "public"."app_settings" (
  "key" text NOT NULL,
  "value" text NOT NULL,
  "updated_at" timestamptz DEFAULT now()
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.app_settings TO anon,authenticated,service_role;

CREATE TABLE "public"."bans" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "username" text NOT NULL,
  "reason" text DEFAULT ''::text,
  "banned_by" text NOT NULL,
  "created_at" timestamptz DEFAULT now()
);
ALTER TABLE public.bans ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.bans TO anon,authenticated,service_role;

CREATE TABLE "public"."channels" (
  "id" text NOT NULL,
  "label" text NOT NULL,
  "icon" text DEFAULT '#'::text,
  "position" int4 DEFAULT 0,
  "topic" text DEFAULT ''::text,
  "is_system" bool DEFAULT false,
  "created_at" timestamptz DEFAULT now(),
  "kind" text DEFAULT 'chat'::text NOT NULL,
  "category" text DEFAULT ''::text,
  "forum_tags" jsonb DEFAULT '[]'::jsonb,
  "min_speak_role" text DEFAULT 'member'::text NOT NULL
);
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.channels TO anon,authenticated,service_role;

CREATE TABLE "public"."chat_device_bans" (
  "device_id" text NOT NULL,
  "username" text NOT NULL,
  "reason" text DEFAULT ''::text NOT NULL,
  "banned_by" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE public.chat_device_bans ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.chat_device_bans TO anon,authenticated,service_role;

CREATE TABLE "public"."chat_devices" (
  "device_id" text NOT NULL,
  "username" text NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE public.chat_devices ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.chat_devices TO anon,authenticated,service_role;

CREATE TABLE "public"."dm_blocks" (
  "blocker" text NOT NULL,
  "blocked" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE public.dm_blocks ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.dm_blocks TO anon,authenticated,service_role;

CREATE TABLE "public"."dm_messages" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "dm_id" uuid NOT NULL,
  "sender" text NOT NULL,
  "content" text DEFAULT ''::text NOT NULL,
  "type" text DEFAULT 'text'::text,
  "media_url" text DEFAULT ''::text,
  "reply_to" jsonb,
  "read_by" text[] DEFAULT '{}'::text[],
  "deleted" bool DEFAULT false,
  "edited" bool DEFAULT false,
  "created_at" timestamptz DEFAULT now(),
  "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(content, ''::text))) STORED,
  "reactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "deleted_at" timestamptz,
  "deleted_by" text
);
ALTER TABLE public.dm_messages ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.dm_messages TO anon,authenticated,service_role;

CREATE TABLE "public"."dm_reads" (
  "dm_id" uuid NOT NULL,
  "username" text NOT NULL,
  "last_read_at" timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE public.dm_reads ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.dm_reads TO anon,authenticated,service_role;

CREATE TABLE "public"."dms" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "participants" text[] NOT NULL,
  "created_at" timestamptz DEFAULT now(),
  "title" text DEFAULT 'New chat'::text NOT NULL
);
ALTER TABLE public.dms ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.dms TO anon,authenticated,service_role;

CREATE TABLE "public"."follows" (
  "follower" text NOT NULL,
  "followee" text NOT NULL,
  "created_at" timestamptz DEFAULT now()
);
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.follows TO anon,authenticated,service_role;

CREATE TABLE "public"."forum_threads" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" text NOT NULL,
  "title" text NOT NULL,
  "author" text NOT NULL,
  "body" text DEFAULT ''::text NOT NULL,
  "tags" text[] DEFAULT '{}'::text[],
  "reactions" jsonb DEFAULT '{}'::jsonb,
  "pinned" bool DEFAULT false,
  "locked" bool DEFAULT false,
  "reply_count" int4 DEFAULT 0,
  "last_activity_at" timestamptz DEFAULT now(),
  "edited" bool DEFAULT false,
  "deleted" bool DEFAULT false,
  "created_at" timestamptz DEFAULT now()
);
ALTER TABLE public.forum_threads ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.forum_threads TO anon,authenticated,service_role;

CREATE TABLE "public"."messages" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" text NOT NULL,
  "sender" text NOT NULL,
  "content" text DEFAULT ''::text NOT NULL,
  "type" text DEFAULT 'text'::text,
  "media_url" text DEFAULT ''::text,
  "reply_to" jsonb,
  "reactions" jsonb DEFAULT '{}'::jsonb,
  "deleted" bool DEFAULT false,
  "edited" bool DEFAULT false,
  "created_at" timestamptz DEFAULT now(),
  "pinned" bool DEFAULT false,
  "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(content, ''::text))) STORED,
  "deleted_at" timestamptz,
  "deleted_by" text
);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.messages TO anon,authenticated,service_role;

CREATE TABLE "public"."profiles" (
  "username" text NOT NULL,
  "password_hash" text DEFAULT ''::text NOT NULL,
  "color" text DEFAULT '#a78bfa'::text,
  "pfp" text DEFAULT ''::text,
  "banner" text DEFAULT ''::text,
  "bio" text DEFAULT ''::text,
  "tag" text DEFAULT ''::text,
  "status" text DEFAULT 'online'::text,
  "custom_status" text DEFAULT ''::text,
  "is_admin" bool DEFAULT false,
  "is_owner" bool DEFAULT false,
  "is_banned" bool DEFAULT false,
  "ban_reason" text DEFAULT ''::text,
  "banned_by" text DEFAULT ''::text,
  "timeout_until" timestamptz,
  "timeout_by" text DEFAULT ''::text,
  "kicked_at" timestamptz,
  "created_at" timestamptz DEFAULT now(),
  "display_name" text NOT NULL,
  "is_test_account" bool DEFAULT false NOT NULL,
  "ring" text DEFAULT ''::text,
  "user_id" uuid,
  "staff_role" text DEFAULT 'member'::text NOT NULL
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.profiles TO anon,authenticated,service_role;

CREATE TABLE "public"."public_stickers" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "category" text DEFAULT 'general'::text,
  "added_by" text NOT NULL,
  "created_at" timestamptz DEFAULT now(),
  "kind" text DEFAULT 'sticker'::text NOT NULL,
  "shortcode" text,
  "storage_key" text
);
ALTER TABLE public.public_stickers ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.public_stickers TO anon,authenticated,service_role;
ALTER TABLE private.chat_admin_sessions ADD PRIMARY KEY(token_hash);
ALTER TABLE public.dm_reads ADD CONSTRAINT "dm_reads_pkey" PRIMARY KEY (dm_id, username);
ALTER TABLE public.public_stickers ADD CONSTRAINT "public_stickers_pkey" PRIMARY KEY (id);
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_pkey" PRIMARY KEY (username);
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_user_id_key" UNIQUE (user_id);
ALTER TABLE public.bans ADD CONSTRAINT "bans_pkey" PRIMARY KEY (id);
ALTER TABLE public.app_settings ADD CONSTRAINT "app_settings_pkey" PRIMARY KEY (key);
ALTER TABLE public.dm_blocks ADD CONSTRAINT "dm_blocks_pkey" PRIMARY KEY (blocker, blocked);
ALTER TABLE public.dms ADD CONSTRAINT "dms_pkey" PRIMARY KEY (id);
ALTER TABLE public.dm_messages ADD CONSTRAINT "dm_messages_pkey" PRIMARY KEY (id);
ALTER TABLE public.chat_device_bans ADD CONSTRAINT "chat_device_bans_pkey" PRIMARY KEY (device_id);
ALTER TABLE public.chat_devices ADD CONSTRAINT "chat_devices_pkey" PRIMARY KEY (device_id, username);
ALTER TABLE public.follows ADD CONSTRAINT "follows_pkey" PRIMARY KEY (follower, followee);
ALTER TABLE public.forum_threads ADD CONSTRAINT "forum_threads_pkey" PRIMARY KEY (id);
ALTER TABLE public.messages ADD CONSTRAINT "messages_pkey" PRIMARY KEY (id);
ALTER TABLE public.channels ADD CONSTRAINT "channels_pkey" PRIMARY KEY (id);
ALTER TABLE public.public_stickers ADD CONSTRAINT "public_stickers_emoji_shortcode_check" CHECK (((kind <> 'emoji'::text) OR (shortcode IS NOT NULL)));
ALTER TABLE public.public_stickers ADD CONSTRAINT "public_stickers_kind_check" CHECK ((kind = ANY (ARRAY['sticker'::text, 'emoji'::text])));
ALTER TABLE public.public_stickers ADD CONSTRAINT "public_stickers_shortcode_format_check" CHECK (((shortcode IS NULL) OR (shortcode ~ '^[a-z0-9_]{2,32}$'::text)));
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_display_name_length" CHECK (((char_length(btrim(display_name)) >= 1) AND (char_length(btrim(display_name)) <= 40)));
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_luna_is_reserved_bot" CHECK (((lower(username) <> 'luna'::text) OR ((user_id IS NULL) AND (NOT is_admin) AND (NOT is_owner))));
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_staff_role_check" CHECK ((staff_role = ANY (ARRAY['member'::text, 'mod'::text, 'manager'::text, 'admin'::text, 'super_mega_tuff_admin'::text, 'dusty'::text, 'co_owner'::text, 'owner'::text, 'preston'::text])));
ALTER TABLE public.dm_blocks ADD CONSTRAINT "dm_blocks_no_self" CHECK ((blocker <> blocked));
ALTER TABLE public.chat_device_bans ADD CONSTRAINT "chat_device_bans_device_id_length" CHECK (((char_length(device_id) >= 16) AND (char_length(device_id) <= 200)));
ALTER TABLE public.chat_devices ADD CONSTRAINT "chat_devices_device_id_length" CHECK (((char_length(device_id) >= 16) AND (char_length(device_id) <= 200)));
ALTER TABLE public.follows ADD CONSTRAINT "follows_no_self" CHECK ((follower <> followee));
ALTER TABLE public.channels ADD CONSTRAINT "channels_min_speak_role_check" CHECK ((min_speak_role = ANY (ARRAY['member'::text, 'mod'::text, 'manager'::text, 'admin'::text, 'owner'::text])));
ALTER TABLE public.dm_reads ADD CONSTRAINT "dm_reads_dm_id_fkey" FOREIGN KEY (dm_id) REFERENCES dms(id) ON DELETE CASCADE;
ALTER TABLE public.dm_reads ADD CONSTRAINT "dm_reads_username_fkey" FOREIGN KEY (username) REFERENCES profiles(username) ON DELETE CASCADE;
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.dm_blocks ADD CONSTRAINT "dm_blocks_blocked_fkey" FOREIGN KEY (blocked) REFERENCES profiles(username) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE public.dm_blocks ADD CONSTRAINT "dm_blocks_blocker_fkey" FOREIGN KEY (blocker) REFERENCES profiles(username) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE public.dm_messages ADD CONSTRAINT "dm_messages_dm_id_fkey" FOREIGN KEY (dm_id) REFERENCES dms(id);
ALTER TABLE public.chat_device_bans ADD CONSTRAINT "chat_device_bans_username_fkey" FOREIGN KEY (username) REFERENCES profiles(username) ON DELETE CASCADE;
ALTER TABLE public.chat_devices ADD CONSTRAINT "chat_devices_username_fkey" FOREIGN KEY (username) REFERENCES profiles(username) ON DELETE CASCADE;
ALTER TABLE public.follows ADD CONSTRAINT "follows_followee_fkey" FOREIGN KEY (followee) REFERENCES profiles(username) ON DELETE CASCADE;
ALTER TABLE public.follows ADD CONSTRAINT "follows_follower_fkey" FOREIGN KEY (follower) REFERENCES profiles(username) ON DELETE CASCADE;
ALTER TABLE public.forum_threads ADD CONSTRAINT "forum_threads_channel_id_fkey" FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION private.chat_staff_rank(p_role text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case lower(coalesce(p_role, 'member'))
    when 'preston' then 7
    when 'owner' then 6
    when 'co_owner' then 5
    when 'super_mega_tuff_admin' then 4
    when 'dusty' then 4
    when 'admin' then 4
    when 'manager' then 3
    when 'mod' then 2
    else 1
  end;
$function$;

CREATE OR REPLACE FUNCTION private.chat_is_staff(p_owner_only boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((
    select not p.is_banned
      and p.user_id = auth.uid()
      and (
        case when p_owner_only then p.staff_role in ('owner', 'preston')
             else private.chat_staff_rank(p.staff_role) >= 2
        end
      )
    from public.profiles p
    where p.user_id = auth.uid()
  ), false);
$function$;


CREATE OR REPLACE FUNCTION private.chat_reject_blocked_dm()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_participants text[];
begin
  if tg_table_name = 'dms' then
    v_participants := new.participants;
  else
    if tg_op = 'UPDATE' then
      if row(new.content, new.type, new.media_url, new.reactions)
         is not distinct from row(old.content, old.type, old.media_url, old.reactions) then
        return new;
      end if;
    end if;
    select d.participants into v_participants
    from public.dms d where d.id = new.dm_id;
  end if;

  if cardinality(v_participants) = 2 and exists (
    select 1 from public.dm_blocks b
    where (b.blocker = v_participants[1] and b.blocked = v_participants[2])
       or (b.blocker = v_participants[2] and b.blocked = v_participants[1])
  ) then
    raise exception 'DM_BLOCKED' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;





CREATE OR REPLACE FUNCTION private.chat_storage_upload_allowed_for_policy(p_storage_path text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from private.chat_upload_grants as g
    where g.storage_path = p_storage_path
      and g.consumed_at is null
      and g.expires_at > pg_catalog.now()
  )
$function$;


CREATE OR REPLACE FUNCTION private.chat_sync_legacy_staff_flags()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'UPDATE'
     and new.staff_role is not distinct from old.staff_role
     and (new.is_owner is distinct from old.is_owner or new.is_admin is distinct from old.is_admin) then
    if new.is_owner then
      new.staff_role := 'owner';
    elsif new.is_admin and private.chat_staff_rank(coalesce(old.staff_role, 'member')) < 4 then
      new.staff_role := 'admin';
    elsif not new.is_admin and coalesce(old.staff_role, 'member') in ('admin', 'super_mega_tuff_admin', 'dusty', 'co_owner', 'owner', 'preston') then
      new.staff_role := 'member';
    end if;
  end if;

  new.staff_role := lower(coalesce(nullif(pg_catalog.btrim(new.staff_role), ''), 'member'));
  if new.staff_role not in ('member', 'mod', 'manager', 'admin', 'super_mega_tuff_admin', 'dusty', 'co_owner', 'owner', 'preston') then
    new.staff_role := 'member';
  end if;
  new.is_owner := (new.staff_role in ('owner', 'preston'));
  new.is_admin := (new.staff_role in ('admin', 'super_mega_tuff_admin', 'dusty', 'co_owner', 'owner', 'preston'));
  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION private.chat_username()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p.username
  from public.profiles p
  where p.user_id = auth.uid()
    and not p.is_banned
  limit 1
$function$;


CREATE OR REPLACE FUNCTION private.require_chat_staff_min_rank(p_min_rank integer)
 RETURNS profiles
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
BEGIN
  SELECT * INTO v_actor
  FROM public.profiles p
  WHERE p.user_id = auth.uid()
    AND NOT p.is_banned;

  IF v_actor.username IS NULL OR private.chat_staff_rank(v_actor.staff_role) < coalesce(p_min_rank, 2) THEN
    RAISE EXCEPTION 'Insufficient staff permission';
  END IF;
  RETURN v_actor;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_dashboard_sign_in_auth()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile public.profiles%rowtype;
  v_token text;
  v_expires_at timestamptz := now() + interval '8 hours';
begin
  delete from private.chat_admin_sessions where expires_at <= now();
  select * into v_profile
  from public.profiles p
  where p.user_id = auth.uid()
    and not p.is_banned
    and (p.is_admin or p.is_owner);
  if v_profile.username is null then
    raise exception 'Invalid administrator credentials';
  end if;
  v_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.chat_admin_sessions (token_hash, username, expires_at)
  values (extensions.digest(v_token, 'sha256'), v_profile.username, v_expires_at);
  insert into private.chat_admin_audit (actor_username, action)
  values (v_profile.username, 'dashboard_sign_in');
  return jsonb_build_object(
    'token', v_token,
    'username', v_profile.username,
    'is_owner', v_profile.is_owner,
    'expires_at', v_expires_at
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.chat_enforce_message_controls()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_is_owner boolean := false;
  v_is_admin boolean := false;
  v_is_banned boolean := false;
  v_timeout timestamptz;
  v_enabled boolean;
  v_words jsonb;
  v_word text;
  v_slow integer := 0;
  v_max_length integer := 2000;
  v_last_message_at timestamptz;
  v_is_luna_reply boolean := new.sender = 'Luna'
    and current_setting('app.luna_reply_insert', true) = 'true';
  v_luna_workspace boolean := false;
begin
  -- Guarded bulk import of guest history (service role, transaction-scoped flag).
  if coalesce(current_setting('app.luna_import_user', true), '') <> '' then
    return new;
  end if;

  -- Luna's replies are generated paid-side; community controls must not reject them.
  if v_is_luna_reply then
    return new;
  end if;

  select p.is_owner, p.is_admin, p.is_banned, p.timeout_until
  into v_is_owner, v_is_admin, v_is_banned, v_timeout
  from public.profiles p
  where p.username = new.sender;

  if tg_table_name = 'dm_messages' then
    select exists (
      select 1 from public.dms d
      where d.id = new.dm_id and 'Luna' = any (d.participants)
    ) into v_luna_workspace;
  end if;

  if coalesce(v_is_banned, false) then
    raise exception 'Banned accounts cannot send messages';
  end if;
  -- Timeouts are a chat mute. They do not apply to Luna or to DMs with Luna.
  if v_timeout is not null and v_timeout > now()
     and new.sender <> 'Luna'
     and not v_is_luna_reply
     and not v_luna_workspace then
    raise exception 'This account is timed out';
  end if;

  select coalesce((select value = 'true' from public.app_settings where key = 'app_enabled'), true)
  into v_enabled;
  if not v_enabled and not coalesce(v_is_owner, false) then
    raise exception 'Liminal Chat is currently disabled';
  end if;

  if tg_op = 'INSERT' then
    select coalesce((select value = 'true' from public.app_settings where key = 'messages_enabled'), true)
    into v_enabled;
    if not v_enabled and not coalesce(v_is_admin, false) and not coalesce(v_is_owner, false) then
      raise exception 'Sending messages is currently disabled';
    end if;

    if tg_table_name = 'dm_messages' then
      select coalesce((select value = 'true' from public.app_settings where key = 'dms_enabled'), true)
      into v_enabled;
      if not v_enabled and not coalesce(v_is_admin, false) and not coalesce(v_is_owner, false) then
        raise exception 'Direct messages are currently disabled';
      end if;
    end if;

    if not coalesce(v_is_admin, false) and not coalesce(v_is_owner, false) then
      begin
        select value::integer into v_slow
        from public.app_settings where key = 'slow_mode_seconds';
      exception when others then
        v_slow := 0;
      end;

      if v_slow > 0 then
        if tg_table_name = 'dm_messages' then
          select max(created_at) into v_last_message_at
          from public.dm_messages where sender = new.sender;
        else
          select max(created_at) into v_last_message_at
          from public.messages where sender = new.sender;
        end if;

        if v_last_message_at > now() - pg_catalog.make_interval(secs => v_slow) then
          raise exception 'Slow mode is active. Please wait before sending again';
        end if;
      end if;
    end if;
  end if;

  if not v_is_luna_reply then
    begin
      select value::integer into v_max_length
      from public.app_settings where key = 'max_message_length';
    exception when others then
      v_max_length := 2000;
    end;
    v_max_length := greatest(100, least(v_max_length, 4000));
    if char_length(coalesce(new.content, '')) > v_max_length then
      raise exception 'Message exceeds the current length limit';
    end if;
  end if;

  if new.type = 'gif' then
    select coalesce((select value = 'true' from public.app_settings where key = 'gifs_enabled'), true)
    into v_enabled;
    if not v_enabled then raise exception 'GIFs are currently disabled'; end if;
  elsif coalesce(new.media_url, '') <> '' then
    select coalesce((select value = 'true' from public.app_settings where key = 'uploads_enabled'), true)
    into v_enabled;
    if not v_enabled then raise exception 'Media uploads are currently disabled'; end if;
  end if;

  if coalesce(new.content, '') <> '' then
    begin
      select value::jsonb into v_words
      from public.app_settings where key = 'banned_words';
      for v_word in select jsonb_array_elements_text(coalesce(v_words, '[]'::jsonb))
      loop
        if v_word <> '' and position(lower(v_word) in lower(new.content)) > 0 then
          raise exception 'Message contains a blocked word';
        end if;
      end loop;
    exception
      when invalid_text_representation then null;
    end;
  end if;
  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION public.chat_guard_channel_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'INSERT' then
    if coalesce(new.min_speak_role, 'member') <> 'member' and not private.chat_is_staff(true) then
      new.min_speak_role := 'member';
    end if;
    return new;
  end if;
  if new.min_speak_role is distinct from old.min_speak_role and not private.chat_is_staff(true) then
    raise exception 'Only the owner can change who can speak in a channel';
  end if;
  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION public.chat_mark_dm_read(p_dm_id uuid, p_limit integer DEFAULT 200)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor public.profiles%rowtype;
  v_count integer;
begin
  select * into v_actor
  from public.profiles
  where user_id = auth.uid();

  if v_actor.username is null or v_actor.is_banned then
    raise exception 'Active account required';
  end if;

  if not exists (
    select 1 from public.dms d
    where d.id = p_dm_id and v_actor.username = any(d.participants)
  ) then
    raise exception 'Not a participant of this conversation';
  end if;

  insert into public.dm_reads (dm_id, username, last_read_at)
  values (p_dm_id, v_actor.username, pg_catalog.now())
  on conflict (dm_id, username)
  do update set last_read_at = excluded.last_read_at;

  with target as (
    select id
    from public.dm_messages
    where dm_id = p_dm_id
      and sender <> v_actor.username
      and not coalesce(deleted, false)
      and not (coalesce(read_by, array[]::text[]) @> array[v_actor.username])
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 200), 500))
  )
  update public.dm_messages m
  set read_by = pg_catalog.array_append(coalesce(m.read_by, array[]::text[]), v_actor.username)
  from target t
  where m.id = t.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;


CREATE OR REPLACE FUNCTION public.chat_toggle_dm_reaction(p_message_id uuid, p_emoji text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor public.profiles%rowtype;
  v_row public.dm_messages%rowtype;
  v_reactions jsonb;
  v_users jsonb;
begin
  select * into v_actor
  from public.profiles
  where user_id = auth.uid();

  if v_actor.username is null or v_actor.is_banned then
    raise exception 'Active account required';
  end if;
  if v_actor.timeout_until is not null and v_actor.timeout_until > pg_catalog.now() then
    raise exception 'You are timed out';
  end if;
  if p_emoji is null or pg_catalog.length(p_emoji) = 0 or pg_catalog.length(p_emoji) > 32 then
    raise exception 'Invalid reaction';
  end if;

  select * into v_row
  from public.dm_messages
  where id = p_message_id
    and not coalesce(deleted, false)
  for update;

  if v_row.id is null then raise exception 'Message not found'; end if;
  if not exists (
    select 1 from public.dms d
    where d.id = v_row.dm_id and v_actor.username = any (d.participants)
  ) then
    raise exception 'Not a participant of this conversation';
  end if;

  v_reactions := coalesce(v_row.reactions, '{}'::jsonb);
  v_users := coalesce(v_reactions -> p_emoji, '[]'::jsonb);

  if v_users ? v_actor.username then
    select coalesce(pg_catalog.jsonb_agg(u), '[]'::jsonb)
    into v_users
    from pg_catalog.jsonb_array_elements_text(v_users) as u
    where u <> v_actor.username;
  else
    if not (v_reactions ? p_emoji)
       and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_reactions)) >= 40 then
      raise exception 'Too many different reactions on this message';
    end if;
    v_users := v_users || pg_catalog.to_jsonb(v_actor.username);
  end if;

  if pg_catalog.jsonb_array_length(v_users) = 0 then
    v_reactions := v_reactions - p_emoji;
  else
    v_reactions := pg_catalog.jsonb_set(v_reactions, array[p_emoji], v_users, true);
  end if;

  update public.dm_messages
  set reactions = v_reactions
  where id = p_message_id
  returning * into v_row;

  return pg_catalog.to_jsonb(v_row) - 'search_tsv';
end;
$function$;


CREATE OR REPLACE FUNCTION public.chat_toggle_forum_reaction(p_thread_id uuid, p_emoji text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor public.profiles%rowtype;
  v_row public.forum_threads%rowtype;
  v_reactions jsonb;
  v_users jsonb;
begin
  select *
  into v_actor
  from public.profiles
  where user_id = auth.uid();

  if v_actor.username is null or v_actor.is_banned then
    raise exception 'Active account required';
  end if;
  if v_actor.timeout_until is not null and v_actor.timeout_until > pg_catalog.now() then
    raise exception 'You are timed out';
  end if;

  -- Guard the emoji itself: this string becomes a jsonb object key.
  if p_emoji is null
     or pg_catalog.length(p_emoji) = 0
     or pg_catalog.length(p_emoji) > 32 then
    raise exception 'Invalid reaction';
  end if;

  -- FOR UPDATE is the whole point: it serialises concurrent reactors on the
  -- same thread so neither can overwrite the other's change.
  select *
  into v_row
  from public.forum_threads
  where id = p_thread_id
    and not coalesce(deleted, false)
  for update;

  if v_row.id is null then
    raise exception 'Thread not found';
  end if;

  -- SECURITY DEFINER bypasses RLS, so re-apply the forum_member_read rule by
  -- hand: 'following' feeds are visible to their author and that author's
  -- followers only, and you cannot react to what you cannot read.
  if v_row.channel_id = 'following'
     and v_row.author <> v_actor.username
     and not exists (
       select 1
       from public.follows f
       where f.follower = v_actor.username
         and f.followee = v_row.author
     ) then
    raise exception 'Thread not found';
  end if;

  v_reactions := coalesce(v_row.reactions, '{}'::jsonb);
  v_users := coalesce(v_reactions -> p_emoji, '[]'::jsonb);

  if v_users ? v_actor.username then
    -- Already reacted: drop this user from the list.
    select coalesce(pg_catalog.jsonb_agg(u), '[]'::jsonb)
    into v_users
    from pg_catalog.jsonb_array_elements_text(v_users) as u
    where u <> v_actor.username;
  else
    -- Cap distinct emoji per thread so one row cannot be grown without bound.
    if not (v_reactions ? p_emoji)
       and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_reactions)) >= 40 then
      raise exception 'Too many different reactions on this post';
    end if;
    v_users := v_users || pg_catalog.to_jsonb(v_actor.username);
  end if;

  if pg_catalog.jsonb_array_length(v_users) = 0 then
    v_reactions := v_reactions - p_emoji;
  else
    v_reactions := pg_catalog.jsonb_set(v_reactions, array[p_emoji], v_users, true);
  end if;

  -- last_activity_at is deliberately left alone: a reaction should not bump a
  -- thread up the board the way a reply does.
  update public.forum_threads
  set reactions = v_reactions
  where id = p_thread_id
  returning * into v_row;

  -- forum_threads has no search_tsv column, so the row ships as-is.
  return pg_catalog.to_jsonb(v_row);
end;
$function$;


CREATE OR REPLACE FUNCTION public.chat_toggle_reaction(p_message_id uuid, p_emoji text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor public.profiles%rowtype;
  v_row public.messages%rowtype;
  v_reactions jsonb;
  v_users jsonb;
begin
  select *
  into v_actor
  from public.profiles
  where user_id = auth.uid();

  if v_actor.username is null or v_actor.is_banned then
    raise exception 'Active account required';
  end if;
  if v_actor.timeout_until is not null and v_actor.timeout_until > pg_catalog.now() then
    raise exception 'You are timed out';
  end if;

  -- Guard the emoji itself: this string becomes a jsonb object key.
  if p_emoji is null
     or pg_catalog.length(p_emoji) = 0
     or pg_catalog.length(p_emoji) > 32 then
    raise exception 'Invalid reaction';
  end if;

  -- FOR UPDATE is the whole point: it serialises concurrent reactors on the
  -- same message so neither can overwrite the other's change.
  select *
  into v_row
  from public.messages
  where id = p_message_id
    and not coalesce(deleted, false)
  for update;

  if v_row.id is null then
    raise exception 'Message not found';
  end if;

  v_reactions := coalesce(v_row.reactions, '{}'::jsonb);
  v_users := coalesce(v_reactions -> p_emoji, '[]'::jsonb);

  if v_users ? v_actor.username then
    -- Already reacted: drop this user from the list.
    select coalesce(pg_catalog.jsonb_agg(u), '[]'::jsonb)
    into v_users
    from pg_catalog.jsonb_array_elements_text(v_users) as u
    where u <> v_actor.username;
  else
    -- Cap distinct emoji per message so one row cannot be grown without bound.
    if not (v_reactions ? p_emoji)
       and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_reactions)) >= 40 then
      raise exception 'Too many different reactions on this message';
    end if;
    v_users := v_users || pg_catalog.to_jsonb(v_actor.username);
  end if;

  if pg_catalog.jsonb_array_length(v_users) = 0 then
    v_reactions := v_reactions - p_emoji;
  else
    v_reactions := pg_catalog.jsonb_set(v_reactions, array[p_emoji], v_users, true);
  end if;

  update public.messages
  set reactions = v_reactions
  where id = p_message_id
  returning * into v_row;

  -- search_tsv is a server-side index artefact; never ship it to the client.
  return pg_catalog.to_jsonb(v_row) - 'search_tsv';
end;
$function$;


CREATE OR REPLACE FUNCTION public.lc_ensure_following_thread()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not exists (
    select 1 from public.forum_threads
    where channel_id = 'following' and author = NEW.followee and deleted = false
  ) then
    insert into public.forum_threads (channel_id, title, author, body)
    values (
      'following',
      coalesce(
        (select nullif(btrim(display_name), '') from public.profiles where username = NEW.followee),
        NEW.followee
      ),
      NEW.followee,
      ''
    );
  end if;
  return NEW;
end $function$;


CREATE OR REPLACE FUNCTION public.lc_forum_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare tid uuid;
begin
  if NEW.channel_id like 'forum:%' then
    begin
      tid := substring(NEW.channel_id from 7)::uuid;
    exception when others then
      return NEW;
    end;
    update public.forum_threads
      set reply_count = reply_count + 1, last_activity_at = now()
      where id = tid;
  end if;
  return NEW;
end $function$;


CREATE POLICY "profiles_public_read" ON public.profiles AS PERMISSIVE FOR SELECT TO "anon","authenticated" USING (true);

CREATE POLICY "profiles_update_self" ON public.profiles AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));

CREATE POLICY "messages_read_members" ON public.messages AS PERMISSIVE FOR SELECT TO "authenticated" USING (((private.chat_username() IS NOT NULL) AND ((channel_id !~~ 'forum:%'::text) OR (NOT (EXISTS ( SELECT 1
   FROM forum_threads t
  WHERE (((t.id)::text = SUBSTRING(messages.channel_id FROM 7)) AND (t.channel_id = 'following'::text))))) OR (EXISTS ( SELECT 1
   FROM forum_threads t
  WHERE (((t.id)::text = SUBSTRING(messages.channel_id FROM 7)) AND (t.channel_id = 'following'::text) AND ((t.author = private.chat_username()) OR (EXISTS ( SELECT 1
           FROM follows f
          WHERE ((f.follower = private.chat_username()) AND (f.followee = t.author)))))))))));

CREATE POLICY "messages_insert_self" ON public.messages AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((sender = private.chat_username()));

CREATE POLICY "messages_update_members" ON public.messages AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((private.chat_username() IS NOT NULL)) WITH CHECK ((private.chat_username() IS NOT NULL));

CREATE POLICY "channels_public_read" ON public.channels AS PERMISSIVE FOR SELECT TO "anon","authenticated" USING (true);

CREATE POLICY "channels_staff_insert" ON public.channels AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (private.chat_is_staff(false));

CREATE POLICY "channels_staff_update" ON public.channels AS PERMISSIVE FOR UPDATE TO "authenticated" USING (private.chat_is_staff(false)) WITH CHECK (private.chat_is_staff(false));

CREATE POLICY "channels_staff_delete" ON public.channels AS PERMISSIVE FOR DELETE TO "authenticated" USING (private.chat_is_staff(false));

CREATE POLICY "dms_participant_read" ON public.dms AS PERMISSIVE FOR SELECT TO "authenticated" USING ((private.chat_username() = ANY (participants)));

CREATE POLICY "dms_participant_insert" ON public.dms AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((private.chat_username() = ANY (participants)) AND (array_length(participants, 1) = 2)));

CREATE POLICY "dm_messages_participant_read" ON public.dm_messages AS PERMISSIVE FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM dms d
  WHERE ((d.id = dm_messages.dm_id) AND (private.chat_username() = ANY (d.participants))))));

CREATE POLICY "dm_messages_participant_insert" ON public.dm_messages AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((sender = private.chat_username()) AND (EXISTS ( SELECT 1
   FROM dms d
  WHERE ((d.id = dm_messages.dm_id) AND (private.chat_username() = ANY (d.participants)))))));

CREATE POLICY "dm_messages_participant_update" ON public.dm_messages AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM dms d
  WHERE ((d.id = dm_messages.dm_id) AND (private.chat_username() = ANY (d.participants)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM dms d
  WHERE ((d.id = dm_messages.dm_id) AND (private.chat_username() = ANY (d.participants))))));

CREATE POLICY "stickers_member_read" ON public.public_stickers AS PERMISSIVE FOR SELECT TO "authenticated" USING ((private.chat_username() IS NOT NULL));

CREATE POLICY "stickers_member_insert" ON public.public_stickers AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((added_by = private.chat_username()));

CREATE POLICY "stickers_owner_delete" ON public.public_stickers AS PERMISSIVE FOR DELETE TO "authenticated" USING (((added_by = private.chat_username()) OR private.chat_is_staff(false)));

CREATE POLICY "follows_member_read" ON public.follows AS PERMISSIVE FOR SELECT TO "authenticated" USING ((private.chat_username() IS NOT NULL));

CREATE POLICY "follows_self_insert" ON public.follows AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((follower = private.chat_username()));

CREATE POLICY "follows_self_delete" ON public.follows AS PERMISSIVE FOR DELETE TO "authenticated" USING ((follower = private.chat_username()));

CREATE POLICY "forum_member_read" ON public.forum_threads AS PERMISSIVE FOR SELECT TO "authenticated" USING (((private.chat_username() IS NOT NULL) AND ((channel_id <> 'following'::text) OR (author = private.chat_username()) OR (EXISTS ( SELECT 1
   FROM follows f
  WHERE ((f.follower = private.chat_username()) AND (f.followee = forum_threads.author)))))));

CREATE POLICY "forum_self_insert" ON public.forum_threads AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((author = private.chat_username()));

CREATE POLICY "forum_member_update" ON public.forum_threads AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((private.chat_username() IS NOT NULL)) WITH CHECK ((private.chat_username() IS NOT NULL));

CREATE POLICY "liminal_user_upload_insert" ON storage.objects AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((bucket_id = ANY (ARRAY['liminal-media'::text, 'liminal-pfp'::text, 'liminal-avatars'::text])) AND ((storage.foldername(name))[1] = (auth.uid())::text) AND ((char_length(name) >= 1) AND (char_length(name) <= 500))));

CREATE POLICY "liminal_user_upload_update" ON storage.objects AS PERMISSIVE FOR UPDATE TO "authenticated" USING (((bucket_id = ANY (ARRAY['liminal-media'::text, 'liminal-pfp'::text, 'liminal-avatars'::text])) AND (owner_id = (auth.uid())::text))) WITH CHECK (((bucket_id = ANY (ARRAY['liminal-media'::text, 'liminal-pfp'::text, 'liminal-avatars'::text])) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

CREATE POLICY "liminal_user_upload_delete" ON storage.objects AS PERMISSIVE FOR DELETE TO "authenticated" USING (((bucket_id = ANY (ARRAY['liminal-media'::text, 'liminal-pfp'::text, 'liminal-avatars'::text])) AND (owner_id = (auth.uid())::text)));

CREATE POLICY "bans_direct_deny" ON public.bans AS PERMISSIVE FOR ALL TO "anon","authenticated" USING (false) WITH CHECK (false);

CREATE POLICY "chat_devices_direct_deny" ON public.chat_devices AS PERMISSIVE FOR ALL TO "anon","authenticated" USING (false) WITH CHECK (false);

CREATE POLICY "chat_device_bans_direct_deny" ON public.chat_device_bans AS PERMISSIVE FOR ALL TO "anon","authenticated" USING (false) WITH CHECK (false);

CREATE POLICY "liminal_media_chat_paths_require_grant" ON storage.objects AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK (((bucket_id <> 'liminal-media'::text) OR (name !~ '^chat/'::text) OR private.chat_storage_upload_allowed_for_policy(name)));

CREATE POLICY "dm_blocks_select_own" ON public.dm_blocks AS PERMISSIVE FOR SELECT TO "authenticated" USING ((blocker = private.chat_username()));

CREATE POLICY "liminal_user_upload_select" ON storage.objects AS PERMISSIVE FOR SELECT TO "authenticated" USING (((bucket_id = ANY (ARRAY['liminal-media'::text, 'liminal-pfp'::text, 'liminal-avatars'::text])) AND (owner_id = (auth.uid())::text)));

CREATE POLICY "app_settings_public_read" ON public.app_settings AS PERMISSIVE FOR SELECT TO "anon","authenticated" USING (true);

CREATE POLICY "messages_delete_self_or_staff" ON public.messages AS PERMISSIVE FOR DELETE TO "authenticated" USING (((sender = private.chat_username()) OR private.chat_is_staff(false)));

CREATE POLICY "dm_messages_delete_self_or_staff" ON public.dm_messages AS PERMISSIVE FOR DELETE TO "authenticated" USING ((((sender = private.chat_username()) AND (EXISTS ( SELECT 1
   FROM dms d
  WHERE ((d.id = dm_messages.dm_id) AND (private.chat_username() = ANY (d.participants)))))) OR private.chat_is_staff(false)));

CREATE POLICY "dm_reads_own_write" ON public.dm_reads AS PERMISSIVE FOR ALL TO "authenticated" USING ((username = private.chat_username())) WITH CHECK ((username = private.chat_username()));

CREATE POLICY "dm_blocks_insert_own" ON public.dm_blocks AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((blocker = private.chat_username()));

CREATE POLICY "dm_blocks_delete_own" ON public.dm_blocks AS PERMISSIVE FOR DELETE TO "authenticated" USING ((blocker = private.chat_username()));

CREATE POLICY "liminal_stickers_staff_insert" ON storage.objects AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((bucket_id = 'liminal-stickers'::text) AND ((storage.foldername(name))[1] = ANY (ARRAY['sticker'::text, 'emoji'::text])) AND ((storage.foldername(name))[2] = (( SELECT auth.uid() AS uid))::text) AND (char_length(name) <= 300) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.user_id = ( SELECT auth.uid() AS uid)) AND (NOT p.is_banned) AND (lower(COALESCE(p.staff_role, 'member'::text)) = ANY (ARRAY['admin'::text, 'super_mega_tuff_admin'::text, 'dusty'::text, 'co_owner'::text, 'owner'::text, 'preston'::text])))))));

CREATE OR REPLACE FUNCTION public.chat_set_staff_role(p_actor_username text, p_actor_password_hash text, p_target_username text, p_role text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_role text := lower(pg_catalog.btrim(coalesce(p_role, 'member')));
  v_old text;
  v_registry text;
BEGIN
  v_actor := private.require_chat_staff_min_rank(5);

  IF v_role NOT IN ('member', 'mod', 'manager', 'admin', 'super_mega_tuff_admin', 'dusty', 'co_owner') THEN
    RAISE EXCEPTION 'Invalid staff role';
  END IF;

  -- Lock the actor and target while checking and changing privileges.
  SELECT * INTO v_actor FROM public.profiles
  WHERE username = v_actor.username FOR UPDATE;
  IF coalesce(v_actor.is_banned, false) OR private.chat_staff_rank(v_actor.staff_role) < 5 THEN
    RAISE EXCEPTION 'Insufficient staff permission';
  END IF;

  SELECT * INTO v_target FROM public.profiles
  WHERE lower(username) = lower(pg_catalog.btrim(p_target_username)) FOR UPDATE;

  IF v_target.username IS NULL OR v_target.username = v_actor.username
     OR v_target.staff_role IN ('owner', 'preston') OR coalesce(v_target.is_owner, false) THEN
    RAISE EXCEPTION 'That staff role cannot be changed';
  END IF;
  IF private.chat_staff_rank(v_actor.staff_role) <= private.chat_staff_rank(v_target.staff_role)
     OR private.chat_staff_rank(v_actor.staff_role) <= private.chat_staff_rank(v_role) THEN
    RAISE EXCEPTION 'You can only change roles below your rank';
  END IF;

  v_old := v_target.staff_role;
  UPDATE public.profiles SET staff_role = v_role WHERE username = v_target.username;

  -- Keep the registry for older clients, but native staff_role is authoritative.
  -- Lock the singleton before reading roles so concurrent assignments cannot
  -- overwrite the registry with a snapshot from an earlier assignment.
  PERFORM 1 FROM public.app_settings WHERE key = 'co_owners' FOR UPDATE;
  SELECT coalesce(jsonb_agg(lower(username) ORDER BY lower(username)), '[]'::jsonb)::text
  INTO v_registry FROM public.profiles WHERE staff_role = 'co_owner';
  INSERT INTO public.app_settings (key, value, updated_at)
  VALUES ('co_owners', v_registry, now())
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

  IF v_role = 'member' THEN
    DELETE FROM private.chat_admin_sessions WHERE username = v_target.username;
  END IF;

  INSERT INTO private.chat_admin_audit (actor_username, action, target, details)
  VALUES (v_actor.username, 'staff_role_set_in_chat', v_target.username,
          jsonb_build_object('from', v_old, 'to', v_role));
  RETURN true;
END;
$function$;


CREATE OR REPLACE FUNCTION public.chat_enforce_registration_control()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_enabled boolean;
begin
  if new.is_test_account then
    return new;
  end if;

  if not exists (select 1 from public.profiles) then
    return new;
  end if;

  select coalesce(
    (select value = 'true' from public.app_settings where key = 'registrations_enabled'),
    true
  ) into v_enabled;

  if not v_enabled then
    raise exception 'New account registration is currently disabled';
  end if;

  return new;
end;
$function$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public,private TO authenticated,service_role;

