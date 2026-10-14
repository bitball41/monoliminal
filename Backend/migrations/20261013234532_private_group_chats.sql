BEGIN;
ALTER TABLE public.dms ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false;
ALTER TABLE public.dms ADD COLUMN IF NOT EXISTS group_owner text;
ALTER TABLE public.dms ADD CONSTRAINT dms_group_metadata_check CHECK (
  (NOT is_group AND group_owner IS NULL) OR
  (is_group AND char_length(btrim(title)) BETWEEN 1 AND 60 AND cardinality(participants) <= 16
    AND (cardinality(participants)=0 OR coalesce(group_owner=ANY(participants),false)))
);
CREATE TABLE public.chat_group_invites (
  group_id uuid NOT NULL REFERENCES public.dms(id) ON DELETE CASCADE,
  invitee text NOT NULL,
  invited_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(group_id,invitee)
);
CREATE INDEX chat_group_invites_invitee_idx ON public.chat_group_invites(invitee);
ALTER TABLE public.chat_group_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_group_invites FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.chat_group_invites TO authenticated;
GRANT ALL ON public.chat_group_invites TO service_role;
CREATE POLICY group_invites_read ON public.chat_group_invites FOR SELECT TO authenticated
USING (invitee=(SELECT private.chat_username()) OR EXISTS (
  SELECT 1 FROM public.dms d WHERE d.id=group_id AND d.group_owner=(SELECT private.chat_username())
));

-- Group thread metadata is mutated only by the checked RPCs, never a browser write.
CREATE FUNCTION private.chat_guard_group_thread() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF (NEW.is_group OR (TG_OP='UPDATE' AND OLD.is_group)) AND current_user IN ('anon','authenticated') THEN
    RAISE EXCEPTION 'Use the group management actions';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_group_thread_guard BEFORE INSERT OR UPDATE ON public.dms
FOR EACH ROW EXECUTE FUNCTION private.chat_guard_group_thread();
DROP POLICY IF EXISTS dms_participant_insert ON public.dms;
CREATE POLICY dms_participant_insert ON public.dms FOR INSERT TO authenticated
WITH CHECK (NOT is_group AND group_owner IS NULL AND private.chat_username()=ANY(participants) AND cardinality(participants)=2);

-- A staff rank does not bypass membership for group messages, including deletion.
CREATE POLICY group_messages_member_delete ON public.dm_messages AS RESTRICTIVE FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.dms d WHERE d.id=dm_id AND (NOT d.is_group OR private.chat_username()=ANY(d.participants))));
CREATE FUNCTION private.chat_guard_group_message() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid; v_group public.dms%rowtype;
BEGIN
  IF TG_OP='DELETE' THEN v_id:=OLD.dm_id; ELSE v_id:=NEW.dm_id; END IF;
  SELECT * INTO v_group FROM public.dms WHERE id=v_id FOR SHARE;
  IF v_group.is_group AND current_setting('app.chat_account_delete',true) IS DISTINCT FROM 'true'
     AND NOT coalesce(private.chat_username()=ANY(v_group.participants),false) THEN
    RAISE EXCEPTION 'You are not a member of this private group';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER chat_group_message_guard BEFORE INSERT OR UPDATE OR DELETE ON public.dm_messages
FOR EACH ROW EXECUTE FUNCTION private.chat_guard_group_message();

CREATE FUNCTION private.chat_require_group(p_id uuid,p_owner boolean DEFAULT false)
RETURNS public.dms LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor text:=private.chat_username(); v_group public.dms%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Active account required'; END IF;
  SELECT * INTO v_group FROM public.dms WHERE id=p_id AND is_group FOR UPDATE;
  IF v_group.id IS NULL OR NOT coalesce(v_actor=ANY(v_group.participants),false) THEN
    RAISE EXCEPTION 'This private group is unavailable';
  END IF;
  IF p_owner AND v_group.group_owner IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'Only the group owner can do that'; END IF;
  RETURN v_group;
END;
$$;
CREATE FUNCTION private.chat_invite_group_member(p_group_id uuid,p_username text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_group public.dms%rowtype:=private.chat_require_group(p_group_id,true); v_target text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.app_settings WHERE key='app_enabled' AND value='false') AND NOT private.chat_is_staff(true) THEN RAISE EXCEPTION 'The community is in maintenance mode'; END IF;
  IF EXISTS(SELECT 1 FROM public.app_settings WHERE key='dms_enabled' AND value='false') AND NOT private.chat_is_staff(false) THEN RAISE EXCEPTION 'Private chats are paused'; END IF;
  IF EXISTS(SELECT 1 FROM public.profiles WHERE username=private.chat_username() AND timeout_until>now()) THEN RAISE EXCEPTION 'You are timed out'; END IF;
  SELECT username INTO v_target FROM public.profiles
  WHERE lower(username)=lower(btrim(p_username)) AND NOT is_banned AND user_id IS NOT NULL AND lower(username)<>'luna';
  IF v_target IS NULL THEN RAISE EXCEPTION 'That account is unavailable'; END IF;
  IF v_target=ANY(v_group.participants) THEN RAISE EXCEPTION 'That person is already a member'; END IF;
  IF EXISTS (SELECT 1 FROM public.dm_blocks b WHERE
    (b.blocker=v_target AND b.blocked=ANY(v_group.participants)) OR
    (b.blocked=v_target AND b.blocker=ANY(v_group.participants))) THEN
    RAISE EXCEPTION 'You cannot invite this person to the group';
  END IF;
  IF cardinality(v_group.participants)+(SELECT count(*) FROM public.chat_group_invites WHERE group_id=p_group_id)>=16
     AND NOT EXISTS(SELECT 1 FROM public.chat_group_invites WHERE group_id=p_group_id AND invitee=v_target) THEN
    RAISE EXCEPTION 'Groups can have up to 16 members, including pending invitations';
  END IF;
  INSERT INTO public.chat_group_invites(group_id,invitee,invited_by)
  VALUES(p_group_id,v_target,private.chat_username()) ON CONFLICT DO NOTHING;
END;
$$;
CREATE FUNCTION public.chat_create_group(p_title text,p_invitees text[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor text:=private.chat_username(); v_id uuid; v_name text; v_title text:=btrim(coalesce(p_title,''));
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Active account required'; END IF;
  IF EXISTS(SELECT 1 FROM public.app_settings WHERE key='app_enabled' AND value='false') AND NOT private.chat_is_staff(true) THEN RAISE EXCEPTION 'The community is in maintenance mode'; END IF;
  IF EXISTS(SELECT 1 FROM public.profiles WHERE username=v_actor AND timeout_until>now()) THEN RAISE EXCEPTION 'You are timed out'; END IF;
  IF EXISTS(SELECT 1 FROM public.app_settings WHERE key='dms_enabled' AND value='false') AND NOT private.chat_is_staff(false) THEN RAISE EXCEPTION 'Private chats are paused'; END IF;
  IF char_length(v_title) NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'Group names must be 1 to 60 characters'; END IF;
  IF coalesce(cardinality(p_invitees),0) NOT BETWEEN 1 AND 15 OR v_actor=ANY(p_invitees) THEN RAISE EXCEPTION 'Choose 1 to 15 other people to invite'; END IF;
  -- Serialize creation for an account so the group limit cannot be raced.
  PERFORM 1 FROM public.profiles WHERE username=v_actor FOR UPDATE;
  IF (SELECT count(*) FROM public.dms WHERE is_group AND group_owner=v_actor)>=20 THEN RAISE EXCEPTION 'You can own up to 20 groups'; END IF;
  INSERT INTO public.dms(title,participants,is_group,group_owner) VALUES(v_title,ARRAY[v_actor],true,v_actor) RETURNING id INTO v_id;
  FOREACH v_name IN ARRAY p_invitees LOOP PERFORM private.chat_invite_group_member(v_id,v_name); END LOOP;
  RETURN v_id;
END;
$$;
CREATE FUNCTION public.chat_manage_group(p_group_id uuid,p_action text,p_username text DEFAULT '',p_title text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor text:=private.chat_username(); v_group public.dms%rowtype; v_remaining text[]; v_target text;
BEGIN
  v_group:=private.chat_require_group(p_group_id,p_action<>'leave');
  IF p_action='rename' THEN
    IF char_length(btrim(coalesce(p_title,''))) NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'Group names must be 1 to 60 characters'; END IF;
    UPDATE public.dms SET title=btrim(p_title) WHERE id=p_group_id;
  ELSIF p_action='invite' THEN PERFORM private.chat_invite_group_member(p_group_id,p_username);
  ELSIF p_action='cancel_invite' THEN DELETE FROM public.chat_group_invites WHERE group_id=p_group_id AND invitee=p_username;
  ELSIF p_action IN ('remove','transfer') THEN
    SELECT name INTO v_target FROM unnest(v_group.participants) name WHERE lower(name)=lower(btrim(p_username));
    IF v_target IS NULL OR v_target=v_actor THEN RAISE EXCEPTION 'Choose another group member'; END IF;
    IF p_action='transfer' THEN
      UPDATE public.dms SET group_owner=v_target WHERE id=p_group_id;
      DELETE FROM public.chat_group_invites WHERE group_id=p_group_id;
    ELSE
      UPDATE public.dms SET participants=array_remove(participants,v_target) WHERE id=p_group_id;
    END IF;
  ELSIF p_action='leave' THEN
    v_remaining:=array_remove(v_group.participants,v_actor);
    UPDATE public.dms SET participants=v_remaining,
      group_owner=CASE WHEN group_owner=v_actor THEN v_remaining[1] ELSE group_owner END WHERE id=p_group_id;
    IF v_group.group_owner=v_actor THEN DELETE FROM public.chat_group_invites WHERE group_id=p_group_id; END IF;
    DELETE FROM public.dm_reads WHERE dm_id=p_group_id AND username=v_actor;
    RETURN '{}'::jsonb;
  ELSE RAISE EXCEPTION 'Unknown group action';
  END IF;
  SELECT * INTO v_group FROM public.dms WHERE id=p_group_id;
  RETURN to_jsonb(v_group);
END;
$$;
CREATE FUNCTION public.chat_respond_group_invite(p_group_id uuid,p_accept boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor text:=private.chat_username(); v_group public.dms%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Active account required'; END IF;
  SELECT * INTO v_group FROM public.dms WHERE id=p_group_id AND is_group FOR UPDATE;
  IF v_group.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.chat_group_invites WHERE group_id=p_group_id AND invitee=v_actor) THEN RAISE EXCEPTION 'This invitation is unavailable'; END IF;
  IF p_accept IS NULL THEN RAISE EXCEPTION 'Choose accept or decline'; END IF;
  IF p_accept THEN
    IF cardinality(v_group.participants)>=16 THEN RAISE EXCEPTION 'This group is full'; END IF;
    IF EXISTS(SELECT 1 FROM public.dm_blocks b WHERE (b.blocker=v_actor AND b.blocked=ANY(v_group.participants)) OR (b.blocked=v_actor AND b.blocker=ANY(v_group.participants))) THEN RAISE EXCEPTION 'You cannot join this group'; END IF;
    UPDATE public.dms SET participants=array_append(participants,v_actor) WHERE id=p_group_id;
  END IF;
  DELETE FROM public.chat_group_invites WHERE group_id=p_group_id AND invitee=v_actor;
  IF NOT p_accept THEN RETURN '{}'::jsonb; END IF;
  SELECT * INTO v_group FROM public.dms WHERE id=p_group_id;
  RETURN to_jsonb(v_group);
END;
$$;
CREATE FUNCTION public.chat_list_group_invites() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object('group_id',i.group_id,'title',d.title,'invited_by',i.invited_by,'member_count',cardinality(d.participants),'created_at',i.created_at) ORDER BY i.created_at DESC),'[]'::jsonb)
FROM public.chat_group_invites i JOIN public.dms d ON d.id=i.group_id
WHERE i.invitee=private.chat_username() AND d.is_group AND cardinality(d.participants)>0;
$$;
CREATE FUNCTION public.chat_list_conversations()
RETURNS TABLE(id uuid,participants text[],created_at timestamptz,title text,is_group boolean,group_owner text,last_id uuid,last_sender text,last_content text,last_type text,last_created_at timestamptz,last_deleted boolean,last_read_by text[],my_last_read_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
SELECT d.id,d.participants,d.created_at,d.title,d.is_group,d.group_owner,m.id,m.sender,m.content,m.type,m.created_at,coalesce(m.deleted,false),coalesce(m.read_by,ARRAY[]::text[]),r.last_read_at
FROM public.dms d LEFT JOIN LATERAL (SELECT mm.* FROM public.dm_messages mm WHERE mm.dm_id=d.id ORDER BY mm.created_at DESC,mm.id DESC LIMIT 1) m ON true
LEFT JOIN public.dm_reads r ON r.dm_id=d.id AND r.username=private.chat_username()
WHERE private.chat_username()=ANY(d.participants);
$$;
CREATE OR REPLACE FUNCTION public.chat_list_dm_inbox()
RETURNS TABLE(id uuid,participants text[],created_at timestamptz,title text,last_id uuid,last_sender text,last_content text,last_type text,last_created_at timestamptz,last_deleted boolean,last_read_by text[],my_last_read_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
SELECT c.id,c.participants,c.created_at,c.title,c.last_id,c.last_sender,c.last_content,c.last_type,c.last_created_at,c.last_deleted,c.last_read_by,c.my_last_read_at
FROM public.chat_list_conversations() c WHERE NOT c.is_group;
$$;

-- Blocking is for direct conversations and invitations; it cannot disable a shared group for everyone.
CREATE OR REPLACE FUNCTION private.chat_reject_blocked_dm() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_participants text[]; v_group boolean;
BEGIN
  IF TG_TABLE_NAME='dms' THEN v_participants:=NEW.participants; v_group:=NEW.is_group;
  ELSE
    IF TG_OP='UPDATE' AND row(NEW.content,NEW.type,NEW.media_url,NEW.reactions) IS NOT DISTINCT FROM row(OLD.content,OLD.type,OLD.media_url,OLD.reactions) THEN RETURN NEW; END IF;
    SELECT participants,is_group INTO v_participants,v_group FROM public.dms WHERE id=NEW.dm_id;
  END IF;
  IF NOT coalesce(v_group,false) AND cardinality(v_participants)=2 AND EXISTS(SELECT 1 FROM public.dm_blocks b WHERE
    (b.blocker=v_participants[1] AND b.blocked=v_participants[2]) OR (b.blocker=v_participants[2] AND b.blocked=v_participants[1])) THEN RAISE EXCEPTION 'DM_BLOCKED'; END IF;
  RETURN NEW;
END;
$$;

-- Shared staff audit records never retain private-group bodies or attachments.
CREATE FUNCTION private.chat_redact_group_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.details->>'scope'='dm' AND EXISTS(SELECT 1 FROM public.dms d WHERE d.is_group AND d.id::text=coalesce(NEW.details->>'dm_id',NEW.details->>'place')) THEN
    NEW.details:=NEW.details-'content'-'preview'-'media_url';
    NEW.details:=NEW.details||jsonb_build_object('private_group',true);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER redact_private_group_audit BEFORE INSERT OR UPDATE ON private.chat_admin_audit FOR EACH ROW EXECUTE FUNCTION private.chat_redact_group_audit();

-- Filter the existing archive reader without changing its interface or ordinary DM behavior.
DO $patch$
DECLARE v_definition text;
BEGIN
  IF to_regprocedure('public.chat_list_deleted_messages(integer)') IS NOT NULL THEN
    v_definition:=pg_get_functiondef('public.chat_list_deleted_messages(integer)'::regprocedure);
    v_definition:=replace(v_definition,'where d.deleted','where d.deleted AND EXISTS (SELECT 1 FROM public.dms g WHERE g.id=d.dm_id AND (NOT g.is_group OR private.chat_username()=ANY(g.participants)))');
    EXECUTE v_definition;
  END IF;
END;
$patch$;

REVOKE ALL ON FUNCTION private.chat_guard_group_thread(),private.chat_guard_group_message(),private.chat_require_group(uuid,boolean),private.chat_invite_group_member(uuid,text),private.chat_redact_group_audit() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.chat_create_group(text,text[]),public.chat_manage_group(uuid,text,text,text),public.chat_respond_group_invite(uuid,boolean),public.chat_list_group_invites(),public.chat_list_conversations(),public.chat_list_dm_inbox() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.chat_create_group(text,text[]),public.chat_manage_group(uuid,text,text,text),public.chat_respond_group_invite(uuid,boolean),public.chat_list_group_invites(),public.chat_list_conversations(),public.chat_list_dm_inbox() TO authenticated,service_role;
DO $pub$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
    IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='chat_group_invites') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_group_invites; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='dms') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.dms; END IF;
  END IF;
END;
$pub$;
CREATE FUNCTION public.chat_owner_configure(p_key text,p_value text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor public.profiles%rowtype; v_value text:=btrim(coalesce(p_value,'')); v_number integer;
BEGIN
  v_actor:=private.require_chat_staff_min_rank(6);
  IF p_key IN ('app_enabled','registrations_enabled','messages_enabled','dms_enabled','uploads_enabled','gifs_enabled') THEN
    IF v_value NOT IN ('true','false') THEN RAISE EXCEPTION 'Choose enabled or disabled'; END IF;
  ELSIF p_key IN ('max_message_length','slow_mode_seconds') THEN
    IF v_value !~ '^[0-9]{1,4}$' THEN RAISE EXCEPTION 'Enter a whole number'; END IF;
    v_number:=v_value::integer;
    IF (p_key='max_message_length' AND v_number NOT BETWEEN 100 AND 4000) OR (p_key='slow_mode_seconds' AND v_number NOT BETWEEN 0 AND 3600) THEN RAISE EXCEPTION 'This limit is out of range'; END IF;
    v_value:=v_number::text;
  ELSE RAISE EXCEPTION 'Unsupported owner configuration'; END IF;
  INSERT INTO public.app_settings(key,value,updated_at) VALUES(p_key,v_value,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
  INSERT INTO private.chat_admin_audit(actor_username,action,target,details) VALUES(v_actor.username,'owner_setting_updated',p_key,jsonb_build_object('value',v_value));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_owner_configure(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.chat_owner_configure(text,text) TO authenticated,service_role;
INSERT INTO storage.buckets(id,name,public,file_size_limit)
VALUES('liminal-group-media','liminal-group-media',false,20971520)
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=excluded.file_size_limit;
CREATE POLICY group_media_members_read ON storage.objects FOR SELECT TO authenticated
USING(bucket_id='liminal-group-media' AND EXISTS(SELECT 1 FROM public.dms d WHERE d.is_group AND d.id::text=(storage.foldername(name))[1] AND private.chat_username()=ANY(d.participants)));
CREATE POLICY group_media_members_upload ON storage.objects FOR INSERT TO authenticated
WITH CHECK(bucket_id='liminal-group-media' AND (storage.foldername(name))[2]=auth.uid()::text AND EXISTS(SELECT 1 FROM public.dms d WHERE d.is_group AND d.id::text=(storage.foldername(name))[1] AND private.chat_username()=ANY(d.participants)));
CREATE POLICY group_media_own_delete ON storage.objects FOR DELETE TO authenticated
USING(bucket_id='liminal-group-media' AND (storage.foldername(name))[2]=auth.uid()::text AND EXISTS(SELECT 1 FROM public.dms d WHERE d.is_group AND d.id::text=(storage.foldername(name))[1] AND private.chat_username()=ANY(d.participants)));
CREATE POLICY group_media_members_only ON storage.objects AS RESTRICTIVE FOR ALL TO PUBLIC
USING(bucket_id<>'liminal-group-media' OR EXISTS(SELECT 1 FROM public.dms d WHERE d.is_group AND d.id::text=(storage.foldername(name))[1] AND private.chat_username()=ANY(d.participants)))
WITH CHECK(bucket_id<>'liminal-group-media' OR EXISTS(SELECT 1 FROM public.dms d WHERE d.is_group AND d.id::text=(storage.foldername(name))[1] AND private.chat_username()=ANY(d.participants)));

-- Removing an account cannot leave its groups permanently without an owner.
CREATE FUNCTION private.chat_group_account_removed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_group public.dms%rowtype; v_remaining text[];
BEGIN
  FOR v_group IN SELECT * FROM public.dms WHERE is_group AND OLD.username=ANY(participants) ORDER BY id FOR UPDATE LOOP
    v_remaining:=array_remove(v_group.participants,OLD.username);
    UPDATE public.dms SET participants=v_remaining,group_owner=CASE WHEN group_owner=OLD.username THEN v_remaining[1] ELSE group_owner END WHERE id=v_group.id;
    IF v_group.group_owner=OLD.username THEN DELETE FROM public.chat_group_invites WHERE group_id=v_group.id; END IF;
  END LOOP;
  DELETE FROM public.chat_group_invites WHERE invitee=OLD.username OR invited_by=OLD.username;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_group_account_removed() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER chat_group_account_cleanup AFTER DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION private.chat_group_account_removed();
NOTIFY pgrst,'reload schema';
COMMIT;
