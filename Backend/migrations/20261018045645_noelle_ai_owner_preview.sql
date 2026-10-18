-- Initial Noelle AI release is an owner preview. Enforce this on the rows,
-- not only the UI: history, direct REST reads and Realtime all use the policy.
ALTER TABLE public.messages ADD COLUMN owner_preview boolean NOT NULL DEFAULT false;
CREATE POLICY messages_noelle_owner_preview ON public.messages AS RESTRICTIVE
FOR ALL TO authenticated
USING (NOT owner_preview OR (SELECT private.chat_has_rank(6)))
WITH CHECK (NOT owner_preview OR (SELECT private.chat_has_rank(6)));

CREATE FUNCTION private.chat_mark_owner_preview() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE protected boolean;
BEGIN
  IF TG_OP='UPDATE' AND NEW.owner_preview IS DISTINCT FROM OLD.owner_preview THEN
    RAISE EXCEPTION 'Message visibility is assigned by the server';
  END IF;
  protected := lower(NEW.sender)='noelleai'
    OR coalesce(NEW.content ~* '(^|[^a-z0-9_@])@noelleai($|[^a-z0-9_])',false);
  IF TG_OP='UPDATE' THEN protected := protected OR OLD.owner_preview; END IF;
  IF NEW.reply_to IS NOT NULL THEN
    protected := protected OR EXISTS(SELECT 1 FROM public.messages m
      WHERE m.id::text=NEW.reply_to->>'id' AND m.channel_id=NEW.channel_id AND m.owner_preview);
  END IF;
  NEW.owner_preview := protected;
  IF protected AND lower(NEW.sender)<>'noelleai' AND NOT private.chat_has_rank(6) THEN
    RAISE EXCEPTION 'Noelle AI is available to owners only';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.chat_mark_owner_preview() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER aa_chat_mark_owner_preview BEFORE INSERT OR UPDATE ON public.messages
FOR EACH ROW EXECUTE FUNCTION private.chat_mark_owner_preview();

-- No preview has been published yet. Fail closed if unexpected rows exist so
-- they cannot become visible between migration steps.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.messages WHERE lower(sender)='noelleai'
    OR content ~* '(^|[^a-z0-9_@])@noelleai($|[^a-z0-9_])') THEN
    RAISE EXCEPTION 'Existing Noelle preview messages need a visibility backfill';
  END IF;
END $$;

CREATE FUNCTION private.chat_mark_owner_preview_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF OLD.owner_preview THEN
    PERFORM set_config('app.owner_preview_delete_id',OLD.id::text,true);
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION private.chat_mark_owner_preview_delete() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER aa_chat_mark_owner_preview_delete BEFORE DELETE ON public.messages
FOR EACH ROW EXECUTE FUNCTION private.chat_mark_owner_preview_delete();

CREATE FUNCTION private.chat_mark_owner_preview_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.messages m WHERE m.owner_preview
    AND m.id::text=NEW.details->>'message_id') OR lower(coalesce(NEW.target,''))='noelleai'
    OR (NEW.details->>'message_id')=current_setting('app.owner_preview_delete_id',true) THEN
    NEW.details := coalesce(NEW.details,'{}') || jsonb_build_object('owner_preview',true);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.chat_mark_owner_preview_audit() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER aa_chat_mark_owner_preview_audit BEFORE INSERT OR UPDATE ON private.chat_admin_audit
FOR EACH ROW EXECUTE FUNCTION private.chat_mark_owner_preview_audit();

DO $$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.chat_noelle_claim(uuid,uuid)'::regprocedure);
  IF position('IF actor.username IS NULL' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected Noelle claim definition'; END IF;
  EXECUTE replace(definition,'IF actor.username IS NULL',
    'IF private.chat_staff_rank(actor.staff_role)<6 THEN RAISE EXCEPTION ''owner_required''; END IF; IF actor.username IS NULL');
  definition := pg_get_functiondef('public.chat_noelle_finish(uuid,uuid,text,integer)'::regprocedure);
  EXECUTE replace(definition,'IF source.id IS NULL OR','IF private.chat_staff_rank(actor.staff_role)<6 OR source.id IS NULL OR');

  definition := pg_get_functiondef('private.chat_capture_message_fact()'::regprocedure);
  EXECUTE replace(definition,'coalesce(p.is_test_account,false) OR',
    'coalesce((to_jsonb(NEW)->>''owner_preview'')::boolean,false) OR coalesce(p.is_test_account,false) OR');
  definition := pg_get_functiondef('private.chat_analytics_summary()'::regprocedure);
  EXECUTE replace(definition,'WHERE NOT coalesce(m.deleted,false)',
    'WHERE NOT m.owner_preview AND NOT coalesce(m.deleted,false)');

  -- Current public examples must not ingest the private preview conversation.
  definition := pg_get_viewdef('private.noelle_ai_corpus'::regclass,true);
  definition := replace(definition,'m.type = ''text''::text','m.type = ''text''::text AND NOT m.owner_preview');
  EXECUTE 'CREATE OR REPLACE VIEW private.noelle_ai_corpus WITH (security_invoker=true) AS '||definition;

  -- SECURITY DEFINER readers must apply the same visibility as row security.
  definition := pg_get_functiondef('public.chat_list_mentions(integer)'::regprocedure);
  IF position('WHERE private.chat_username() IS NOT NULL' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected mention reader'; END IF;
  EXECUTE replace(definition,'WHERE private.chat_username() IS NOT NULL',
    'WHERE (NOT m.owner_preview OR private.chat_has_rank(6)) AND private.chat_username() IS NOT NULL');
  definition := pg_get_functiondef('private.chat_reply_snapshot(text,text,jsonb)'::regprocedure);
  EXECUTE replace(definition,'WHERE id=v_id AND channel_id=p_destination',
    'WHERE (NOT owner_preview OR private.chat_has_rank(6)) AND id=v_id AND channel_id=p_destination');

  IF to_regprocedure('public.chat_list_deleted_messages(integer)') IS NOT NULL THEN
    definition := pg_get_functiondef('public.chat_list_deleted_messages(integer)'::regprocedure);
    definition := replace(definition,'where m.deleted',
      'where (NOT m.owner_preview OR private.chat_has_rank(6)) AND m.deleted');
    definition := replace(definition,'where a.action = ''message_deleted''',
      'where (coalesce(a.details->>''owner_preview'',''false'')<>''true'' OR private.chat_has_rank(6)) AND a.action = ''message_deleted''');
    EXECUTE definition;
  END IF;
  IF to_regprocedure('public.chat_list_admin_audit(integer)') IS NOT NULL THEN
    definition := pg_get_functiondef('public.chat_list_admin_audit(integer)'::regprocedure);
    EXECUTE replace(definition,'FROM private.chat_admin_audit a',
      'FROM private.chat_admin_audit a WHERE (coalesce(a.details->>''owner_preview'',''false'')<>''true'' OR private.chat_has_rank(6))');
  END IF;
  definition := pg_get_functiondef('public.admin_dashboard_get_state(text)'::regprocedure);
  definition := replace(definition,'from public.messages',
    'from public.messages WHERE (NOT owner_preview OR v_actor_owner)');
  definition := replace(definition,'from private.chat_admin_audit a',
    'from private.chat_admin_audit a WHERE (coalesce(a.details->>''owner_preview'',''false'')<>''true'' OR v_actor_owner)');
  EXECUTE definition;
END $$;

NOTIFY pgrst, 'reload schema';
