-- Safe to run against the linked database: all fixtures, writes, and audit entries roll back.
BEGIN;
DO $regression$
DECLARE
  v_nonce text := 'audit_' || left(replace(gen_random_uuid()::text,'-',''),8) || '_';
  v_users jsonb := '{}'::jsonb;
  v_names jsonb := '{}'::jsonb;
  v_results jsonb := '[]'::jsonb;
  v_key text;
  v_uid uuid;
  v_username text;
  v_role text;
  v_case jsonb;
  v_sql text;
  v_count integer;
  v_error text;
  v_allowed boolean;
  v_token text;
  v_index integer := 0;
BEGIN
  INSERT INTO public.app_settings(key,value) VALUES ('app_enabled','true'),('messages_enabled','true'),('dms_enabled','true'),('slow_mode_seconds','0'),('max_message_length','2000'),('banned_words','[]') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  FOR v_key,v_role IN SELECT * FROM (VALUES
    ('member','member'),('member2','member'),('mod','mod'),('manager','manager'),
    ('admin','admin'),('admin2','admin'),('co_owner','co_owner'),('co_owner2','co_owner'),
    ('owner','owner'),('preston','preston'),('banned','member')
  ) AS roles(label,role) LOOP
    v_uid := gen_random_uuid();
    v_username := v_nonce || v_index;
    v_index := v_index+1;
    INSERT INTO auth.users(id) VALUES(v_uid);
    INSERT INTO public.profiles(username,user_id,display_name,staff_role,is_banned)
    VALUES(v_username,v_uid,'Security fixture',v_role,v_key='banned');
    v_users := v_users || jsonb_build_object(v_key,v_uid);
    v_names := v_names || jsonb_build_object(v_key,v_username,'uid_'||v_key,v_uid::text);
    v_token := encode(extensions.gen_random_bytes(32),'hex');
    INSERT INTO private.chat_admin_sessions(token_hash,username,expires_at)
    VALUES(extensions.digest(v_token,'sha256'),v_username,now()+interval '1 hour');
    v_names := v_names || jsonb_build_object('token_'||v_key,v_token);
  END LOOP;
  FOR v_key IN SELECT unnest(array['chat','forum','restricted','restricted_forum','mod']) LOOP
    v_names := v_names || jsonb_build_object('c_'||v_key,v_nonce||v_key);
  END LOOP;
  INSERT INTO public.channels(id,label,kind,min_speak_role) VALUES
    (v_names->>'c_chat','Test Chat','chat','member'),
    (v_names->>'c_forum','Test Forum','forum','member'),
    (v_names->>'c_restricted','Restricted Chat','chat','member'),
    (v_names->>'c_restricted_forum','Restricted Forum','forum','member');
  -- Speak policy updates require an actual owner JWT even from a maintenance session.
  PERFORM set_config('request.jwt.claim.sub',v_users->>'owner',true);
  UPDATE public.channels SET min_speak_role='owner' WHERE id IN (v_names->>'c_restricted',v_names->>'c_restricted_forum');
  PERFORM set_config('request.jwt.claim.sub',v_users->>'member',true);
  INSERT INTO public.messages(channel_id,sender,content)
  VALUES(v_names->>'c_chat',v_names->>'member','Member message') RETURNING id INTO v_uid;
  v_names := v_names || jsonb_build_object('m_member',v_uid::text);
  INSERT INTO public.forum_threads(channel_id,title,author,body)
  VALUES(v_names->>'c_forum','Member post',v_names->>'member','Hello') RETURNING id INTO v_uid;
  v_names := v_names || jsonb_build_object('f_member',v_uid::text);
  PERFORM set_config('request.jwt.claim.sub',v_users->>'owner',true);
  INSERT INTO public.messages(channel_id,sender,content)
  VALUES(v_names->>'c_chat',v_names->>'owner','Owner message') RETURNING id INTO v_uid;
  v_names := v_names || jsonb_build_object('m_owner',v_uid::text);
  INSERT INTO public.forum_threads(channel_id,title,author,body)
  VALUES(v_names->>'c_forum','Owner post',v_names->>'owner','Hello') RETURNING id INTO v_uid;
  v_names := v_names || jsonb_build_object('f_owner',v_uid::text);
  INSERT INTO public.dms(participants) VALUES(array[v_names->>'member',v_names->>'owner']) RETURNING id INTO v_uid;
  v_names := v_names || jsonb_build_object('d_pair',v_uid::text);
  INSERT INTO public.dm_messages(dm_id,sender,content,read_by)
  VALUES(v_uid,v_names->>'owner','Private message',array[v_names->>'owner']) RETURNING id INTO v_uid;
  v_names := v_names || jsonb_build_object('dm_owner',v_uid::text);

  v_names := v_names || jsonb_build_object('m_reply',gen_random_uuid()::text);
  INSERT INTO realtime.messages(topic,extension,event,payload,private) VALUES
    ('liminal-online','presence','fixture','{}',true),
    ('liminal-other','presence','fixture','{}',true);

  FOR v_case IN SELECT value FROM jsonb_array_elements($cases$[
  {
    "name": "member cannot grant themselves owner",
    "actor": "member",
    "sql": "update public.profiles set staff_role='owner' where username='@member'",
    "allowed": false
  },
  {
    "name": "member cannot forge legacy owner flags",
    "actor": "member",
    "sql": "update public.profiles set is_owner=true where username='@member'",
    "allowed": false
  },
  {
    "name": "profile identity is immutable",
    "actor": "member",
    "sql": "update public.profiles set username='@member_changed' where username='@member'",
    "allowed": false
  },
  {
    "name": "ordinary self-profile edits work",
    "actor": "member",
    "sql": "update public.profiles set bio='Test bio',display_name='Test Member' where username='@member'",
    "allowed": true
  },
  {
    "name": "banned self-profile writes are blocked",
    "actor": "banned",
    "sql": "update public.profiles set bio='bypass' where username='@banned'",
    "allowed": false
  },
  {
    "name": "spoofed owner credentials do not grant announcement access",
    "actor": "member",
    "sql": "select public.chat_admin_set_setting('@owner','fake','announcement','test')",
    "allowed": false
  },
  {
    "name": "co-owner legacy announcement write is blocked",
    "actor": "co_owner",
    "sql": "select public.chat_admin_set_setting('@owner','fake','announcement','test')",
    "allowed": false
  },
  {
    "name": "owner legacy announcement write works",
    "actor": "owner",
    "sql": "select public.chat_admin_set_setting('fake','fake','announcement','test')",
    "allowed": true
  },
  {
    "name": "PRESTON legacy announcement write works",
    "actor": "preston",
    "sql": "select public.chat_admin_set_setting('fake','fake','whats_new','test')",
    "allowed": true
  },
  {
    "name": "admin banned-word management still works",
    "actor": "admin",
    "sql": "select public.chat_admin_set_setting('fake','fake','banned_words','[]')",
    "allowed": true
  },
  {
    "name": "mod channel insert is blocked",
    "actor": "mod",
    "sql": "insert into public.channels(id,label) values('@c_mod','Test')",
    "allowed": false
  },
  {
    "name": "manager channel update is blocked",
    "actor": "manager",
    "sql": "update public.channels set label='Bypass' where id='@c_chat'",
    "allowed": false
  },
  {
    "name": "mod channel delete is blocked",
    "actor": "mod",
    "sql": "delete from public.channels where id='@c_chat'",
    "allowed": false
  },
  {
    "name": "admin channel management works",
    "actor": "admin",
    "sql": "update public.channels set topic='Test topic' where id='@c_chat'",
    "allowed": true
  },
  {
    "name": "admin cannot weaken owner-only speak policy",
    "actor": "admin",
    "sql": "update public.channels set min_speak_role='member' where id='@c_restricted'",
    "allowed": false
  },
  {
    "name": "member cannot impersonate another sender",
    "actor": "member",
    "sql": "insert into public.messages(channel_id,sender,content) values('@c_chat','@owner','bypass')",
    "allowed": false
  },
  {
    "name": "member cannot post into owner-only channel",
    "actor": "member",
    "sql": "insert into public.messages(channel_id,sender,content) values('@c_restricted','@member','bypass')",
    "allowed": false
  },
  {
    "name": "normal message sending works",
    "actor": "member",
    "sql": "insert into public.messages(channel_id,sender,content) values('@c_chat','@member','Hello')",
    "allowed": true
  },
  {
    "name": "pinned-message insert bypass is blocked",
    "actor": "member",
    "sql": "insert into public.messages(channel_id,sender,content,pinned) values('@c_chat','@member','bypass',true)",
    "allowed": false
  },
  {
    "name": "reaction identities cannot be forged on insert",
    "actor": "member",
    "sql": "insert into public.messages(channel_id,sender,content,reactions) values('@c_chat','@member','bypass',jsonb_build_object('x',jsonb_build_array('@owner')))",
    "allowed": false
  },
  {
    "name": "another member's content cannot be rewritten",
    "actor": "member",
    "sql": "update public.messages set content='bypass' where id='@m_owner'::uuid",
    "allowed": false
  },
  {
    "name": "staff cannot rewrite another user's content",
    "actor": "mod",
    "sql": "update public.messages set content='bypass' where id='@m_owner'::uuid",
    "allowed": false
  },
  {
    "name": "own message edits work",
    "actor": "member",
    "sql": "update public.messages set content='Edited',edited=true where id='@m_member'::uuid",
    "allowed": true
  },
  {
    "name": "staff can pin their own messages",
    "actor": "owner",
    "sql": "update public.messages set pinned=true where id='@m_owner'::uuid",
    "allowed": true
  },
  {
    "name": "member cannot forge someone else's reaction",
    "actor": "member",
    "sql": "update public.messages set reactions=jsonb_build_object('x',jsonb_build_array('@owner')) where id='@m_owner'::uuid",
    "allowed": false
  },
  {
    "name": "member cannot forge reaction on own message",
    "actor": "member",
    "sql": "update public.messages set reactions=jsonb_build_object('x',jsonb_build_array('@owner')) where id='@m_member'::uuid",
    "allowed": false
  },
  {
    "name": "staff cannot forge reactions either",
    "actor": "mod",
    "sql": "update public.messages set reactions=jsonb_build_object('x',jsonb_build_array('@owner')) where id='@m_owner'::uuid",
    "allowed": false
  },
  {
    "name": "owner reaction RPC works",
    "actor": "owner",
    "sql": "select public.chat_toggle_reaction('@m_owner'::uuid,'\ud83d\udc4d')",
    "allowed": true
  },
  {
    "name": "member reaction RPC preserves owner reaction",
    "actor": "member",
    "sql": "select public.chat_toggle_reaction('@m_owner'::uuid,'\ud83d\udc4d')",
    "allowed": true
  },
  {
    "name": "member cannot remove someone else's reaction",
    "actor": "member",
    "sql": "update public.messages set reactions=jsonb_build_object('\ud83d\udc4d',jsonb_build_array('@member')) where id='@m_owner'::uuid",
    "allowed": false
  },
  {
    "name": "reaction RPC can remove own reaction",
    "actor": "member",
    "sql": "select public.chat_toggle_reaction('@m_owner'::uuid,'\ud83d\udc4d')",
    "allowed": true
  },
  {
    "name": "older client can update only its own reaction",
    "actor": "member",
    "sql": "update public.messages set reactions=jsonb_build_object('\ud83d\udc4d',jsonb_build_array('@owner'),'x',jsonb_build_array('@member')) where id='@m_owner'::uuid",
    "allowed": true
  },
  {
    "name": "member cannot forge deletion actor",
    "actor": "member",
    "sql": "update public.messages set deleted=true,deleted_by='@owner' where id='@m_member'::uuid",
    "allowed": false
  },
  {
    "name": "normal forum creation works",
    "actor": "member",
    "sql": "insert into public.forum_threads(channel_id,title,author,body) values('@c_forum','Test post','@member','Hello')",
    "allowed": true
  },
  {
    "name": "forum cannot bypass a channel speak restriction",
    "actor": "member",
    "sql": "insert into public.forum_threads(channel_id,title,author,body) values('@c_restricted_forum','Bypass','@member','Bypass')",
    "allowed": false
  },
  {
    "name": "timed-out users cannot create forum posts",
    "actor": "member",
    "sql": "insert into public.forum_threads(channel_id,title,author,body) values('@c_forum','Bypass','@member','Bypass')",
    "allowed": false,
    "timeout": true
  },
  {
    "name": "timed-out users cannot edit forum content",
    "actor": "member",
    "sql": "update public.forum_threads set body='Bypass' where id='@f_member'::uuid",
    "allowed": false,
    "timeout": true
  },
  {
    "name": "forum respects blocked words",
    "actor": "member",
    "sql": "insert into public.forum_threads(channel_id,title,author,body) values('@c_forum','blocked-fixture','@member','Hello')",
    "allowed": false,
    "blocked_word": true
  },
  {
    "name": "forum cannot spoof activity counts",
    "actor": "member",
    "sql": "update public.forum_threads set reply_count=99 where id='@f_member'::uuid",
    "allowed": false
  },
  {
    "name": "forum reactions cannot impersonate another user",
    "actor": "member",
    "sql": "update public.forum_threads set reactions=jsonb_build_object('x',jsonb_build_array('@owner')) where id='@f_owner'::uuid",
    "allowed": false
  },
  {
    "name": "forum reaction RPC works",
    "actor": "member",
    "sql": "select public.chat_toggle_forum_reaction('@f_owner'::uuid,'\ud83d\udc4d')",
    "allowed": true
  },
  {
    "name": "forum replies update activity through the server trigger",
    "actor": "member",
    "sql": "insert into public.messages(channel_id,sender,content) values('forum:@f_owner','@member','Reply')",
    "allowed": true
  },
  {
    "name": "normal DM sending works",
    "actor": "member",
    "sql": "insert into public.dm_messages(dm_id,sender,content,read_by) values('@d_pair'::uuid,'@member','Hello',array['@member'])",
    "allowed": true
  },
  {
    "name": "DM initial read receipts cannot be forged",
    "actor": "member",
    "sql": "insert into public.dm_messages(dm_id,sender,content,read_by) values('@d_pair'::uuid,'@member','Bypass',array['@owner'])",
    "allowed": false
  },
  {
    "name": "DM reaction identities cannot be forged",
    "actor": "member",
    "sql": "update public.dm_messages set reactions=jsonb_build_object('x',jsonb_build_array('@owner')) where id='@dm_owner'::uuid",
    "allowed": false
  },
  {
    "name": "DM reaction RPC works",
    "actor": "member",
    "sql": "select public.chat_toggle_dm_reaction('@dm_owner'::uuid,'\ud83d\udc4d')",
    "allowed": true
  },
  {
    "name": "normal read receipt RPC works",
    "actor": "member",
    "sql": "select public.chat_mark_dm_read('@d_pair'::uuid)",
    "allowed": true
  },
  {
    "name": "nonparticipants cannot read DMs",
    "actor": "mod",
    "sql": "select id from public.dm_messages where id='@dm_owner'::uuid",
    "allowed": false
  },
  {
    "name": "nonparticipant DM reaction RPC is blocked",
    "actor": "mod",
    "sql": "select public.chat_toggle_dm_reaction('@dm_owner'::uuid,'\ud83d\udc4d')",
    "allowed": false
  },
  {
    "name": "legacy dashboard cannot bypass admin ban restriction",
    "actor": "admin",
    "sql": "select public.admin_dashboard_ban_user('@token_admin','@member2','test')",
    "allowed": false
  },
  {
    "name": "current Chat enforces same admin ban restriction",
    "actor": "admin",
    "sql": "select public.chat_ban_user('fake','fake','@member2','test')",
    "allowed": false
  },
  {
    "name": "legacy dashboard cannot time out peer admins",
    "actor": "admin",
    "sql": "select public.admin_dashboard_timeout_user('@token_admin','@admin2',1)",
    "allowed": false
  },
  {
    "name": "legacy dashboard cannot kick higher-ranked co-owners",
    "actor": "admin",
    "sql": "select public.admin_dashboard_kick_user('@token_admin','@co_owner')",
    "allowed": false
  },
  {
    "name": "legacy dashboard cannot clear higher-ranked timeouts",
    "actor": "admin",
    "sql": "select public.admin_dashboard_clear_timeout('@token_admin','@co_owner')",
    "allowed": false
  },
  {
    "name": "legacy dashboard cannot unban peer co-owners",
    "actor": "co_owner",
    "sql": "select public.admin_dashboard_unban_user('@token_co_owner','@co_owner2')",
    "allowed": false
  },
  {
    "name": "legacy dashboard permits allowed lower-rank timeouts",
    "actor": "admin",
    "sql": "select public.admin_dashboard_timeout_user('@token_admin','@member2',1)",
    "allowed": true
  },
  {
    "name": "legacy dashboard permits allowed lower-rank timeout clearing",
    "actor": "admin",
    "sql": "select public.admin_dashboard_clear_timeout('@token_admin','@member2')",
    "allowed": true
  },
  {
    "name": "legacy dashboard permits co-owner lower-rank bans",
    "actor": "co_owner",
    "sql": "select public.admin_dashboard_ban_user('@token_co_owner','@member2','test')",
    "allowed": true
  },
  {
    "name": "legacy dashboard permits co-owner lower-rank unbans",
    "actor": "co_owner",
    "sql": "select public.admin_dashboard_unban_user('@token_co_owner','@member2')",
    "allowed": true
  },
  {
    "name": "normal storage upload works",
    "actor": "member",
    "sql": "insert into storage.objects(bucket_id,name,owner_id) values('liminal-media','@uid_member/normal.png','@uid_member')",
    "allowed": true
  },
  {
    "name": "banned accounts cannot upload",
    "actor": "banned",
    "sql": "insert into storage.objects(bucket_id,name,owner_id) values('liminal-media','@uid_banned/bypass.png','@uid_banned')",
    "allowed": false
  },
  {
    "name": "normal private schema access is denied",
    "actor": "member",
    "sql": "select id from private.chat_admin_audit",
    "allowed": false
  },
  {
    "name": "browser cannot call service-only password reset authorization",
    "actor": "member",
    "sql": "select public.chat_authorize_password_reset('@uid_owner'::uuid,'@uid_member'::uuid)",
    "allowed": false
  },
  {
    "name": "service password reset still blocks peers",
    "actor": "service_role",
    "sql": "select public.chat_authorize_password_reset('@uid_admin'::uuid,'@uid_admin2'::uuid)",
    "allowed": false
  },
  {
    "name": "service password reset still blocks owners",
    "actor": "service_role",
    "sql": "select public.chat_authorize_password_reset('@uid_preston'::uuid,'@uid_owner'::uuid)",
    "allowed": false
  },
  {
    "name": "service password reset authorization works for lower rank",
    "actor": "service_role",
    "sql": "select public.chat_authorize_password_reset('@uid_admin'::uuid,'@uid_member'::uuid)",
    "allowed": true
  },
  {
    "name": "co-owner cannot grant a peer role",
    "actor": "co_owner",
    "sql": "select public.chat_set_staff_role('fake','fake','@member2','co_owner')",
    "allowed": false
  },
  {
    "name": "co-owner can manage lower-ranked staff",
    "actor": "co_owner",
    "sql": "select public.chat_set_staff_role('fake','fake','@member2','admin')",
    "allowed": true
  },
  {
    "name": "co-owner can demote lower-ranked staff",
    "actor": "co_owner",
    "sql": "select public.chat_set_staff_role('fake','fake','@member2','member')",
    "allowed": true
  },
  {
    "name": "anonymous privileged settings write is denied",
    "actor": "anon",
    "sql": "select public.chat_admin_set_setting('@owner','fake','announcement','bypass')",
    "allowed": false
  },
  {
    "name": "anonymous message reads are denied",
    "actor": "anon",
    "sql": "select id from public.messages where id='@m_owner'::uuid",
    "allowed": false
  },
  {
    "name": "message timestamps cannot become null",
    "actor": "member",
    "sql": "update public.messages set created_at=null where id='@m_member'::uuid",
    "allowed": false
  },
  {
    "name": "users cannot insert unlabelled system messages",
    "actor": "member",
    "sql": "insert into public.messages(channel_id,sender,content,type) values('@c_chat','@member','fake announcement','system')",
    "allowed": false
  },
  {
    "name": "users cannot turn own messages into system messages",
    "actor": "member",
    "sql": "update public.messages set type='system' where id='@m_member'::uuid",
    "allowed": false
  },
  {
    "name": "ordinary replies use a server-generated quote",
    "actor": "member",
    "sql": "insert into public.messages(id,channel_id,sender,content,reply_to) values('@m_reply'::uuid,'@c_chat','@member','Reply',jsonb_build_object('id','@m_owner','sender','@mod','snippet','Fake quote'))",
    "allowed": true
  },
  {
    "name": "reply author and text come from the original message",
    "actor": "member",
    "sql": "select id from public.messages where id='@m_reply'::uuid and reply_to->>'sender'='@owner' and reply_to->>'snippet'='Owner message'",
    "allowed": true
  },
  {
    "name": "existing reply attribution cannot be rewritten",
    "actor": "member",
    "sql": "update public.messages set reply_to=jsonb_build_object('id','@m_owner','sender','@mod','snippet','Fake quote') where id='@m_reply'::uuid",
    "allowed": false
  },
  {
    "name": "staff forum editing remains available in permitted channels",
    "actor": "mod",
    "sql": "update public.forum_threads set body='Moderated post',edited=true where id='@f_owner'::uuid",
    "allowed": true
  },
  {
    "name": "timed-out reactions cannot bypass moderation",
    "actor": "member",
    "sql": "select public.chat_toggle_reaction('@m_owner'::uuid,'x')",
    "allowed": false,
    "timeout": true
  },
  {
    "name": "browser roles cannot truncate Chat tables",
    "actor": "member",
    "sql": "truncate public.messages",
    "allowed": false
  },
  {
    "name": "members can receive Chat online presence",
    "actor": "member",
    "topic": "liminal-online",
    "sql": "select id from realtime.messages where topic='liminal-online' and extension='presence'",
    "allowed": true
  },
  {
    "name": "members can publish Chat online presence",
    "actor": "member",
    "topic": "liminal-online",
    "sql": "insert into realtime.messages(topic,extension,event,payload,private) values('liminal-online','presence','track','{}',true)",
    "allowed": true
  },
  {
    "name": "banned accounts cannot receive Chat online presence",
    "actor": "banned",
    "topic": "liminal-online",
    "sql": "select id from realtime.messages where topic='liminal-online' and extension='presence'",
    "allowed": false
  },
  {
    "name": "banned accounts cannot publish Chat online presence",
    "actor": "banned",
    "topic": "liminal-online",
    "sql": "insert into realtime.messages(topic,extension,event,payload,private) values('liminal-online','presence','track','{}',true)",
    "allowed": false
  },
  {
    "name": "anonymous clients cannot receive Chat online presence",
    "actor": "anon",
    "topic": "liminal-online",
    "sql": "select id from realtime.messages where topic='liminal-online' and extension='presence'",
    "allowed": false
  },
  {
    "name": "the presence policy does not expose other private topics",
    "actor": "member",
    "topic": "liminal-other",
    "sql": "select id from realtime.messages where topic='liminal-other' and extension='presence'",
    "allowed": false
  },
  {
    "name": "the presence policy does not open other private topics",
    "actor": "member",
    "topic": "liminal-other",
    "sql": "insert into realtime.messages(topic,extension,event,payload,private) values('liminal-other','presence','track','{}',true)",
    "allowed": false
  },
  {
    "name": "the presence policy does not allow private broadcasts",
    "actor": "member",
    "topic": "liminal-online",
    "sql": "insert into realtime.messages(topic,extension,event,payload,private) values('liminal-online','broadcast','fake','{}',true)",
    "allowed": false
  }
]$cases$::jsonb) LOOP
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claim.sub',v_users->>'owner',true);
    UPDATE public.profiles SET timeout_until=CASE WHEN coalesce((v_case->>'timeout')::boolean,false) THEN now()+interval '5 minutes' ELSE null END
      WHERE username=v_names->>'member';
    INSERT INTO public.app_settings(key,value) VALUES('banned_words',CASE WHEN coalesce((v_case->>'blocked_word')::boolean,false) THEN '["blocked-fixture"]' ELSE '[]' END)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    v_uid := (v_users->>(v_case->>'actor'))::uuid;
    PERFORM set_config('request.jwt.claim.sub',coalesce(v_uid::text,''),true);
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_uid,'role',
      CASE WHEN v_case->>'actor' IN ('anon','service_role') THEN v_case->>'actor' ELSE 'authenticated' END,
      'user_metadata',jsonb_build_object('staff_role','owner','is_owner',true))::text,true);
    PERFORM set_config('realtime.topic',coalesce(v_case->>'topic',''),true);
    v_sql := v_case->>'sql';
    FOR v_key IN SELECT key FROM jsonb_each(v_names) ORDER BY length(key) DESC LOOP
      v_sql := replace(v_sql,'@'||v_key,v_names->>v_key);
    END LOOP;
    EXECUTE 'SET LOCAL ROLE ' || quote_ident(CASE WHEN v_case->>'actor' IN ('anon','service_role') THEN v_case->>'actor' ELSE 'authenticated' END);
    v_error := null;
    v_count := 0;
    BEGIN
      EXECUTE v_sql;
      GET DIAGNOSTICS v_count=ROW_COUNT;
    EXCEPTION WHEN OTHERS THEN
      v_error := SQLERRM;
    END;
    EXECUTE 'RESET ROLE';
    v_allowed := v_error IS NULL AND v_count > 0;
    v_results := v_results || jsonb_build_object('test',v_case->>'name','passed',v_allowed=(v_case->>'allowed')::boolean,
      'allowed',v_allowed,'error',v_error);
    IF v_allowed IS DISTINCT FROM (v_case->>'allowed')::boolean THEN
      RAISE EXCEPTION 'Authorization regression failed: %; allowed=%, error=%',v_case->>'name',v_allowed,v_error;
    END IF;
  END LOOP;
  PERFORM set_config('app.security_test_results',v_results::text,true);
END;
$regression$;
SELECT current_setting('app.security_test_results',true)::jsonb AS results;
ROLLBACK;

