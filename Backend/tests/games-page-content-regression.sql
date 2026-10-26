-- All temporary accounts, settings changes and audit writes roll back.
BEGIN;
DO $test$
DECLARE
  v_case record;
  v_name text;
  v_uid uuid;
  v_token text;
  v_success boolean;
  v_before text;
  v_audit_before bigint;
BEGIN
  SELECT value INTO v_before FROM public.app_settings WHERE key='games_page_content';
  SELECT count(*) INTO v_audit_before FROM private.chat_admin_audit WHERE action='games_content_updated';
  FOR v_case IN SELECT * FROM (VALUES
    ('owner',false,false,true),('preston',false,false,true),('co_owner',false,false,false),
    ('admin',false,false,false),('member',false,false,false),('owner',true,false,false),('owner',false,true,false)
  ) cases(role,banned,expired,allowed) LOOP
    v_uid := gen_random_uuid();
    v_name := 'games_test_'||left(replace(v_uid::text,'-',''),12);
    INSERT INTO auth.users(id) VALUES(v_uid);
    INSERT INTO public.profiles(username,user_id,display_name,staff_role,is_banned)
    VALUES(v_name,v_uid,'Games test fixture',v_case.role,v_case.banned);
    v_token := encode(extensions.gen_random_bytes(32),'hex');
    INSERT INTO private.chat_admin_sessions(token_hash,username,expires_at)
    VALUES(extensions.digest(v_token,'sha256'),v_name,now()+CASE WHEN v_case.expired THEN interval '-1 hour' ELSE interval '1 hour' END);
    v_success := false;
    BEGIN
      PERFORM public.admin_dashboard_set_games_content(v_token,'{"announcement":"Games test fixture","links":[{"label":"Test","url":"https://example.com"}]}'::jsonb);
      v_success := true;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT IN ('Owner access is required','Invalid or expired administrator session') THEN RAISE; END IF;
    END;
    IF v_success IS DISTINCT FROM v_case.allowed THEN RAISE EXCEPTION 'Unexpected authorization for %',v_case; END IF;
  END LOOP;
  IF (SELECT count(*) FROM private.chat_admin_audit WHERE action='games_content_updated') <> v_audit_before+2 THEN
    RAISE EXCEPTION 'Expected exactly two authorized publication audit events';
  END IF;
  IF has_function_privilege('anon','public.admin_dashboard_set_games_content(text,jsonb)','EXECUTE')
    OR has_table_privilege('anon','public.app_settings','UPDATE')
    OR has_table_privilege('authenticated','public.app_settings','UPDATE') THEN
    RAISE EXCEPTION 'Unexpected public write grant';
  END IF;
END;
$test$;
ROLLBACK;
SELECT 'Owner, PRESTON, lower roles, bans, expiry, audit and write grants passed; fixtures rolled back' AS result;
