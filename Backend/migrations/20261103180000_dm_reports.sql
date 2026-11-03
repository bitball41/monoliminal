-- Owner safety review of direct messages and private groups.
--
-- * The owner/PRESTON dashboard session can list, read, search and remove DM
--   and private-group messages. Every conversation view and search is written
--   to the audit log (without message content).
-- * Conversation members can report a message they received. Reports keep an
--   evidence snapshot and are only visible to the owner dashboard session.
-- * Mods, managers, admins and co-owners gain no read access. Browser roles
--   cannot read the report table, and owner accounts without a dashboard
--   session cannot use these RPCs.
BEGIN;

CREATE TABLE private.chat_dm_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The conversation can disappear (group removed); the evidence snapshot stays.
  dm_id uuid REFERENCES public.dms(id) ON DELETE SET NULL,
  message_id uuid NOT NULL,
  reporter text NOT NULL,
  reported_user text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('sexual','harassment','spam','self_harm','other')),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 500),
  is_group boolean NOT NULL DEFAULT false,
  conversation_title text NOT NULL DEFAULT '',
  participants text[] NOT NULL DEFAULT '{}',
  message_type text NOT NULL DEFAULT 'text',
  message_content text NOT NULL DEFAULT '',
  message_media_url text NOT NULL DEFAULT '',
  message_created_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  resolution_note text NOT NULL DEFAULT '' CHECK (char_length(resolution_note) <= 500),
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter, message_id)
);
CREATE INDEX chat_dm_reports_status_idx ON private.chat_dm_reports(status, created_at DESC);
CREATE INDEX chat_dm_reports_reported_user_idx ON private.chat_dm_reports(reported_user);
CREATE INDEX chat_dm_reports_message_idx ON private.chat_dm_reports(message_id);
CREATE INDEX chat_dm_reports_dm_idx ON private.chat_dm_reports(dm_id);
CREATE INDEX chat_dm_reports_reporter_recent_idx ON private.chat_dm_reports(reporter, created_at DESC);
ALTER TABLE private.chat_dm_reports ENABLE ROW LEVEL SECURITY;
-- No policies: browsers never read or write this table directly.
REVOKE ALL ON private.chat_dm_reports FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.chat_dm_reports TO service_role;

------------------------------------------------------------------------------
-- Member reporting
------------------------------------------------------------------------------

-- A member reports a message someone else sent in a conversation they belong to.
CREATE FUNCTION public.chat_report_dm_message(p_message_id uuid, p_reason text, p_details text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor text := private.chat_username();
  v_reason text := lower(btrim(coalesce(p_reason,'')));
  v_details text := btrim(coalesce(p_details,''));
  v_msg public.dm_messages%rowtype;
  v_dm public.dms%rowtype;
  v_id uuid;
  v_status text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Sign in to report messages'; END IF;
  IF v_reason NOT IN ('sexual','harassment','spam','self_harm','other') THEN
    RAISE EXCEPTION 'Choose a reason for this report';
  END IF;
  IF char_length(v_details) > 500 THEN RAISE EXCEPTION 'Report details allow up to 500 characters'; END IF;

  SELECT * INTO v_msg FROM public.dm_messages WHERE id=p_message_id;
  IF v_msg.id IS NOT NULL THEN SELECT * INTO v_dm FROM public.dms WHERE id=v_msg.dm_id; END IF;
  -- Same error for missing and inaccessible messages, so ids cannot be probed.
  IF v_msg.id IS NULL OR v_dm.id IS NULL OR NOT coalesce(v_actor=ANY(v_dm.participants),false) THEN
    RAISE EXCEPTION 'This message is unavailable';
  END IF;
  IF v_msg.sender=v_actor THEN RAISE EXCEPTION 'You cannot report your own message'; END IF;

  SELECT r.id,r.status INTO v_id,v_status FROM private.chat_dm_reports r
  WHERE r.reporter=v_actor AND r.message_id=p_message_id;
  IF v_id IS NOT NULL THEN
    -- Repeat reports refresh the reason; the original evidence snapshot is kept.
    UPDATE private.chat_dm_reports SET reason=v_reason, details=v_details WHERE id=v_id;
    RETURN jsonb_build_object('id',v_id,'status',v_status,'duplicate',true);
  END IF;

  IF (SELECT count(*) FROM private.chat_dm_reports r
      WHERE r.reporter=v_actor AND r.created_at > now()-interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'Too many reports. Try again later.';
  END IF;

  INSERT INTO private.chat_dm_reports(dm_id,message_id,reporter,reported_user,reason,details,is_group,
    conversation_title,participants,message_type,message_content,message_media_url,message_created_at)
  VALUES(v_dm.id,v_msg.id,v_actor,v_msg.sender,v_reason,v_details,coalesce(v_dm.is_group,false),
    CASE WHEN v_dm.is_group THEN coalesce(v_dm.title,'') ELSE '' END,v_dm.participants,
    coalesce(v_msg.type,'text'),coalesce(v_msg.content,''),coalesce(v_msg.media_url,''),v_msg.created_at)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id',v_id,'status','open','duplicate',false);
END;
$$;
REVOKE ALL ON FUNCTION public.chat_report_dm_message(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_report_dm_message(uuid,text,text) TO authenticated, service_role;

------------------------------------------------------------------------------
-- Shared owner helpers
------------------------------------------------------------------------------

CREATE FUNCTION private.chat_owner_dm_message_json(p_message public.dm_messages)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
    'id',p_message.id,'dm_id',p_message.dm_id,'sender',p_message.sender,'content',p_message.content,
    'type',p_message.type,'media_url',p_message.media_url,'reply_to',p_message.reply_to,
    'deleted',coalesce(p_message.deleted,false),'deleted_by',p_message.deleted_by,'deleted_at',p_message.deleted_at,
    'edited',coalesce(p_message.edited,false),'created_at',p_message.created_at,
    'report_count',(SELECT count(*) FROM private.chat_dm_reports r WHERE r.message_id=p_message.id));
$$;

CREATE FUNCTION private.chat_owner_conversation_json(p_dm public.dms)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
    'id',p_dm.id,'is_group',coalesce(p_dm.is_group,false),
    'title',CASE WHEN p_dm.is_group THEN p_dm.title ELSE '' END,
    'participants',p_dm.participants,'group_owner',p_dm.group_owner,'created_at',p_dm.created_at);
$$;

CREATE FUNCTION private.chat_dm_report_json(p_report private.chat_dm_reports)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT to_jsonb(p_report) || jsonb_build_object(
    'message_exists', EXISTS(SELECT 1 FROM public.dm_messages m WHERE m.id=p_report.message_id),
    'message_deleted', coalesce((SELECT m.deleted FROM public.dm_messages m WHERE m.id=p_report.message_id),false),
    'conversation_exists', p_report.dm_id IS NOT NULL,
    'message_report_count', (SELECT count(*) FROM private.chat_dm_reports r WHERE r.message_id=p_report.message_id),
    'reported_user_open_reports', (SELECT count(*) FROM private.chat_dm_reports r
      WHERE r.reported_user=p_report.reported_user AND r.status='open'),
    'reported_user_total_reports', (SELECT count(*) FROM private.chat_dm_reports r
      WHERE r.reported_user=p_report.reported_user),
    'reported_user_banned', coalesce((SELECT p.is_banned FROM public.profiles p WHERE p.username=p_report.reported_user),false)
  );
$$;

-- Owner removal is the one non-member write the private-group guard allows,
-- and only for the exact message being removed inside this transaction.
CREATE OR REPLACE FUNCTION private.chat_guard_group_message() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid; v_group public.dms%rowtype;
BEGIN
  IF TG_OP='UPDATE' AND NEW.deleted AND NOT coalesce(OLD.deleted,false)
     AND current_setting('app.chat_owner_dm_removal',true)=NEW.id::text THEN
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN v_id:=OLD.dm_id; ELSE v_id:=NEW.dm_id; END IF;
  SELECT * INTO v_group FROM public.dms WHERE id=v_id FOR SHARE;
  IF v_group.is_group AND current_setting('app.chat_account_delete',true) IS DISTINCT FROM 'true'
     AND NOT coalesce(private.chat_username()=ANY(v_group.participants),false) THEN
    RAISE EXCEPTION 'You are not a member of this private group';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

-- Soft-deletes one message (kept in the archive) and settles its open reports.
CREATE FUNCTION private.chat_owner_remove_dm_message(p_actor text, p_message_id uuid, p_note text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_removed integer; v_sender text; v_dm uuid;
BEGIN
  SELECT sender,dm_id INTO v_sender,v_dm FROM public.dm_messages WHERE id=p_message_id;
  IF v_sender IS NULL THEN RAISE EXCEPTION 'Message not found'; END IF;
  PERFORM set_config('app.chat_admin_delete','true',true);
  PERFORM set_config('app.chat_owner_dm_removal',p_message_id::text,true);
  UPDATE public.dm_messages SET deleted=true WHERE id=p_message_id AND NOT coalesce(deleted,false);
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  PERFORM set_config('app.chat_admin_delete','',true);
  PERFORM set_config('app.chat_owner_dm_removal','',true);
  UPDATE private.chat_dm_reports SET status='actioned', resolved_by=p_actor, resolved_at=now(),
    resolution_note=CASE WHEN resolution_note='' THEN left(coalesce(p_note,''),500) ELSE resolution_note END
  WHERE message_id=p_message_id AND status='open';
  IF v_removed>0 THEN
    INSERT INTO private.chat_admin_audit(actor_username,action,target,details)
    VALUES(p_actor,'dm_message_removed',v_sender,jsonb_build_object('dm_id',v_dm,'message_id',p_message_id));
  END IF;
  RETURN v_removed>0;
END;
$$;

------------------------------------------------------------------------------
-- Owner dashboard: conversations
------------------------------------------------------------------------------

-- Conversations by latest activity, optionally filtered by participant or group title.
CREATE FUNCTION public.admin_dashboard_list_dm_conversations(p_admin_token text, p_query text DEFAULT '',
  p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_query text := lower(btrim(coalesce(p_query,'')));
  v_limit integer := least(greatest(coalesce(p_limit,50),1),100);
  v_offset integer := least(greatest(coalesce(p_offset,0),0),10000);
  v_pattern text;
  v_rows jsonb;
  v_total integer;
BEGIN
  PERFORM private.require_chat_admin(p_admin_token, true);
  IF char_length(v_query) > 60 THEN RAISE EXCEPTION 'Search is too long'; END IF;
  v_pattern := '%'||replace(replace(replace(ltrim(v_query,'@'),'\','\\'),'%','\%'),'_','\_')||'%';
  WITH matched AS (
    SELECT d AS dm, d.id, d.created_at, last.created_at AS last_message_at, last.sender AS last_sender
    FROM public.dms d
    LEFT JOIN LATERAL (SELECT m.created_at,m.sender FROM public.dm_messages m
      WHERE m.dm_id=d.id ORDER BY m.created_at DESC LIMIT 1) last ON true
    WHERE v_query='' OR EXISTS(SELECT 1 FROM unnest(d.participants) u WHERE lower(u) LIKE v_pattern)
      OR (d.is_group AND lower(d.title) LIKE v_pattern)
  ), page AS (
    SELECT * FROM matched ORDER BY last_message_at DESC NULLS LAST, created_at DESC, id
    LIMIT v_limit OFFSET v_offset
  )
  SELECT (SELECT count(*) FROM matched),
    coalesce(jsonb_agg(private.chat_owner_conversation_json(p.dm) || jsonb_build_object(
      'last_message_at',p.last_message_at,'last_sender',p.last_sender,
      'message_count',(SELECT count(*) FROM public.dm_messages m WHERE m.dm_id=p.id),
      'open_reports',(SELECT count(*) FROM private.chat_dm_reports r WHERE r.dm_id=p.id AND r.status='open'))
      ORDER BY p.last_message_at DESC NULLS LAST, p.created_at DESC, p.id),'[]'::jsonb)
  INTO v_total, v_rows FROM page p;
  RETURN jsonb_build_object('total',v_total,'conversations',v_rows,'limit',v_limit,'offset',v_offset);
END;
$$;

-- One page of a conversation, newest first from the cursor, returned oldest first.
CREATE FUNCTION public.admin_dashboard_get_dm_messages(p_admin_token text, p_dm_id uuid,
  p_before timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor text;
  v_dm public.dms%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit,50),1),100);
  v_messages jsonb;
  v_count integer;
BEGIN
  v_actor := private.require_chat_admin(p_admin_token, true);
  SELECT * INTO v_dm FROM public.dms WHERE id=p_dm_id;
  IF v_dm.id IS NULL THEN RAISE EXCEPTION 'Conversation not found'; END IF;
  SELECT coalesce(jsonb_agg(private.chat_owner_dm_message_json(x) ORDER BY x.created_at, x.id),'[]'::jsonb), count(*)
  INTO v_messages, v_count
  FROM (SELECT m.* FROM public.dm_messages m
        WHERE m.dm_id=p_dm_id
          AND (p_before IS NULL OR (m.created_at, m.id) < (p_before, coalesce(p_before_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
        ORDER BY m.created_at DESC, m.id DESC LIMIT v_limit) x;
  INSERT INTO private.chat_admin_audit(actor_username,action,target,details)
  VALUES(v_actor,'dm_conversation_viewed',array_to_string(v_dm.participants,', '),jsonb_build_object(
    'dm_id',v_dm.id,'is_group',coalesce(v_dm.is_group,false),'message_count',v_count,'older_page',p_before IS NOT NULL));
  RETURN jsonb_build_object('conversation',private.chat_owner_conversation_json(v_dm),
    'messages',v_messages,'has_more',v_count=v_limit);
END;
$$;

-- Text search across every DM and private group, optionally by sender.
CREATE FUNCTION public.admin_dashboard_search_dm_messages(p_admin_token text, p_query text,
  p_sender text DEFAULT '', p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor text;
  v_query text := btrim(coalesce(p_query,''));
  v_sender text := lower(ltrim(btrim(coalesce(p_sender,'')),'@'));
  v_limit integer := least(greatest(coalesce(p_limit,50),1),100);
  v_pattern text;
  v_rows jsonb;
  v_count integer;
BEGIN
  v_actor := private.require_chat_admin(p_admin_token, true);
  IF char_length(v_query) < 2 AND v_sender='' THEN RAISE EXCEPTION 'Enter at least 2 characters or a sender'; END IF;
  IF char_length(v_query) > 100 OR char_length(v_sender) > 60 THEN RAISE EXCEPTION 'Search is too long'; END IF;
  v_pattern := '%'||replace(replace(replace(v_query,'\','\\'),'%','\%'),'_','\_')||'%';
  SELECT coalesce(jsonb_agg(private.chat_owner_dm_message_json(x.m) || jsonb_build_object(
      'conversation',private.chat_owner_conversation_json(x.d)) ORDER BY (x.m).created_at DESC),'[]'::jsonb), count(*)
  INTO v_rows, v_count
  FROM (SELECT m, d FROM public.dm_messages m JOIN public.dms d ON d.id=m.dm_id
        WHERE (v_query='' OR m.content ILIKE v_pattern) AND (v_sender='' OR lower(m.sender)=v_sender)
        ORDER BY m.created_at DESC LIMIT v_limit) x;
  INSERT INTO private.chat_admin_audit(actor_username,action,target,details)
  VALUES(v_actor,'dm_search',nullif(v_sender,''),jsonb_build_object('query',v_query,'result_count',v_count));
  RETURN jsonb_build_object('messages',v_rows,'limit',v_limit);
END;
$$;

CREATE FUNCTION public.admin_dashboard_remove_dm_message(p_admin_token text, p_message_id uuid, p_note text DEFAULT '')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor text;
BEGIN
  v_actor := private.require_chat_admin(p_admin_token, true);
  IF char_length(coalesce(p_note,'')) > 500 THEN RAISE EXCEPTION 'Notes allow up to 500 characters'; END IF;
  RETURN private.chat_owner_remove_dm_message(v_actor, p_message_id, btrim(coalesce(p_note,'')));
END;
$$;

------------------------------------------------------------------------------
-- Owner dashboard: reports
------------------------------------------------------------------------------

CREATE FUNCTION public.admin_dashboard_list_dm_reports(p_admin_token text, p_status text DEFAULT 'open', p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_status text := lower(btrim(coalesce(p_status,'open')));
  v_limit integer := least(greatest(coalesce(p_limit,50),1),200);
BEGIN
  PERFORM private.require_chat_admin(p_admin_token, true);
  IF v_status NOT IN ('open','actioned','dismissed','all') THEN RAISE EXCEPTION 'Unknown report filter'; END IF;
  RETURN jsonb_build_object(
    'counts', jsonb_build_object(
      'open',(SELECT count(*) FROM private.chat_dm_reports WHERE status='open'),
      'actioned',(SELECT count(*) FROM private.chat_dm_reports WHERE status='actioned'),
      'dismissed',(SELECT count(*) FROM private.chat_dm_reports WHERE status='dismissed')),
    'reports', coalesce((SELECT jsonb_agg(private.chat_dm_report_json(r) ORDER BY r.created_at DESC)
      FROM (SELECT * FROM private.chat_dm_reports
            WHERE v_status='all' OR status=v_status
            ORDER BY created_at DESC LIMIT v_limit) r),'[]'::jsonb));
END;
$$;

-- The reported message plus at most 25 messages either side of it.
CREATE FUNCTION public.admin_dashboard_get_dm_report_context(p_admin_token text, p_report_id uuid, p_radius integer DEFAULT 15)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor text;
  v_report private.chat_dm_reports%rowtype;
  v_radius integer := least(greatest(coalesce(p_radius,15),0),25);
  v_anchor timestamptz;
  v_messages jsonb := '[]'::jsonb;
BEGIN
  v_actor := private.require_chat_admin(p_admin_token, true);
  SELECT * INTO v_report FROM private.chat_dm_reports WHERE id=p_report_id;
  IF v_report.id IS NULL THEN RAISE EXCEPTION 'Report not found'; END IF;

  IF v_report.dm_id IS NOT NULL THEN
    SELECT m.created_at INTO v_anchor FROM public.dm_messages m
    WHERE m.id=v_report.message_id AND m.dm_id=v_report.dm_id;
    v_anchor := coalesce(v_anchor, v_report.message_created_at, v_report.created_at);
    SELECT coalesce(jsonb_agg(private.chat_owner_dm_message_json(x)
        || jsonb_build_object('is_reported',x.id=v_report.message_id) ORDER BY x.created_at, x.id),'[]'::jsonb)
    INTO v_messages
    FROM (
      (SELECT m.* FROM public.dm_messages m
       WHERE m.dm_id=v_report.dm_id AND (m.created_at, m.id) < (v_anchor, v_report.message_id)
       ORDER BY m.created_at DESC, m.id DESC LIMIT v_radius)
      UNION ALL
      (SELECT m.* FROM public.dm_messages m WHERE m.dm_id=v_report.dm_id AND m.id=v_report.message_id)
      UNION ALL
      (SELECT m.* FROM public.dm_messages m
       WHERE m.dm_id=v_report.dm_id AND (m.created_at, m.id) > (v_anchor, v_report.message_id)
       ORDER BY m.created_at, m.id LIMIT v_radius)
    ) x;
  END IF;

  INSERT INTO private.chat_admin_audit(actor_username,action,target,details)
  VALUES(v_actor,'dm_report_context_viewed',v_report.reported_user,jsonb_build_object(
    'report_id',v_report.id,'dm_id',v_report.dm_id,'message_count',jsonb_array_length(v_messages)));

  RETURN jsonb_build_object('report',private.chat_dm_report_json(v_report),'messages',v_messages,'radius',v_radius);
END;
$$;

CREATE FUNCTION public.admin_dashboard_resolve_dm_report(p_admin_token text, p_report_id uuid, p_status text,
  p_note text DEFAULT '', p_remove_message boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor text;
  v_status text := lower(btrim(coalesce(p_status,'')));
  v_note text := btrim(coalesce(p_note,''));
  v_remove boolean := coalesce(p_remove_message,false);
  v_report private.chat_dm_reports%rowtype;
  v_removed boolean := false;
BEGIN
  v_actor := private.require_chat_admin(p_admin_token, true);
  IF v_status NOT IN ('open','actioned','dismissed') THEN RAISE EXCEPTION 'Choose open, actioned or dismissed'; END IF;
  IF char_length(v_note) > 500 THEN RAISE EXCEPTION 'Notes allow up to 500 characters'; END IF;
  IF v_remove AND v_status<>'actioned' THEN RAISE EXCEPTION 'Removing the message marks the report actioned'; END IF;
  SELECT * INTO v_report FROM private.chat_dm_reports WHERE id=p_report_id FOR UPDATE;
  IF v_report.id IS NULL THEN RAISE EXCEPTION 'Report not found'; END IF;

  IF v_remove AND EXISTS(SELECT 1 FROM public.dm_messages WHERE id=v_report.message_id) THEN
    v_removed := private.chat_owner_remove_dm_message(v_actor, v_report.message_id, v_note);
  END IF;

  UPDATE private.chat_dm_reports SET
    status=v_status, resolution_note=v_note,
    resolved_by=CASE WHEN v_status='open' THEN NULL ELSE v_actor END,
    resolved_at=CASE WHEN v_status='open' THEN NULL ELSE now() END
  WHERE id=v_report.id;

  INSERT INTO private.chat_admin_audit(actor_username,action,target,details)
  VALUES(v_actor,'dm_report_resolved',v_report.reported_user,jsonb_build_object(
    'report_id',v_report.id,'status',v_status,'removed_message',v_removed));

  SELECT * INTO v_report FROM private.chat_dm_reports WHERE id=p_report_id;
  RETURN private.chat_dm_report_json(v_report);
END;
$$;

------------------------------------------------------------------------------
-- Private-group attachments: members as before, plus the owner account.
------------------------------------------------------------------------------

CREATE FUNCTION private.chat_owner_can_read_group_media()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT private.chat_is_staff(true);
$$;

DROP POLICY IF EXISTS group_media_members_only ON storage.objects;
CREATE POLICY group_media_members_only_select ON storage.objects AS RESTRICTIVE FOR SELECT TO PUBLIC
USING(bucket_id<>'liminal-group-media'
  OR EXISTS(SELECT 1 FROM public.dms d WHERE d.is_group AND d.id::text=(storage.foldername(name))[1] AND private.chat_username()=ANY(d.participants))
  OR private.chat_owner_can_read_group_media());
CREATE POLICY group_media_members_only_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO PUBLIC
WITH CHECK(bucket_id<>'liminal-group-media' OR EXISTS(SELECT 1 FROM public.dms d WHERE d.is_group AND d.id::text=(storage.foldername(name))[1] AND private.chat_username()=ANY(d.participants)));
CREATE POLICY group_media_members_only_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO PUBLIC
USING(bucket_id<>'liminal-group-media' OR EXISTS(SELECT 1 FROM public.dms d WHERE d.is_group AND d.id::text=(storage.foldername(name))[1] AND private.chat_username()=ANY(d.participants)))
WITH CHECK(bucket_id<>'liminal-group-media' OR EXISTS(SELECT 1 FROM public.dms d WHERE d.is_group AND d.id::text=(storage.foldername(name))[1] AND private.chat_username()=ANY(d.participants)));
CREATE POLICY group_media_members_only_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO PUBLIC
USING(bucket_id<>'liminal-group-media' OR EXISTS(SELECT 1 FROM public.dms d WHERE d.is_group AND d.id::text=(storage.foldername(name))[1] AND private.chat_username()=ANY(d.participants)));
CREATE POLICY group_media_owner_read ON storage.objects FOR SELECT TO authenticated
USING(bucket_id='liminal-group-media' AND private.chat_owner_can_read_group_media());

------------------------------------------------------------------------------
-- Grants
------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION private.chat_dm_report_json(private.chat_dm_reports),
  private.chat_owner_dm_message_json(public.dm_messages),
  private.chat_owner_conversation_json(public.dms),
  private.chat_owner_remove_dm_message(text,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.chat_owner_can_read_group_media() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.chat_owner_can_read_group_media() TO authenticated;
REVOKE ALL ON FUNCTION public.admin_dashboard_list_dm_conversations(text,text,integer,integer),
  public.admin_dashboard_get_dm_messages(text,uuid,timestamptz,uuid,integer),
  public.admin_dashboard_search_dm_messages(text,text,text,integer),
  public.admin_dashboard_remove_dm_message(text,uuid,text),
  public.admin_dashboard_list_dm_reports(text,text,integer),
  public.admin_dashboard_get_dm_report_context(text,uuid,integer),
  public.admin_dashboard_resolve_dm_report(text,uuid,text,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_list_dm_conversations(text,text,integer,integer),
  public.admin_dashboard_get_dm_messages(text,uuid,timestamptz,uuid,integer),
  public.admin_dashboard_search_dm_messages(text,text,text,integer),
  public.admin_dashboard_remove_dm_message(text,uuid,text),
  public.admin_dashboard_list_dm_reports(text,text,integer),
  public.admin_dashboard_get_dm_report_context(text,uuid,integer),
  public.admin_dashboard_resolve_dm_report(text,uuid,text,text,boolean) TO authenticated;

COMMIT;
NOTIFY pgrst, 'reload schema';
