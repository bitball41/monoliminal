import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
const file=path=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('groups can share members with DMs and other groups without participant uniqueness conflicts',async()=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try{
  await db.exec(await file('Backend/tests/authorization-fixture.sql'));
  for(const name of (await readdir(new URL('../Backend/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())await db.exec(await file('Backend/migrations/'+name));
  const ids={alice:'00000000-0000-4000-8000-000000000001',bob:'00000000-0000-4000-8000-000000000002'};
  for(const [name,id] of Object.entries(ids)){
   await db.query('insert into auth.users(id) values($1)',[id]);
   await db.query('insert into public.profiles(username,user_id,display_name) values($1,$2,$1)',[name,id]);
  }
  const actor=async name=>db.exec(`reset role;select set_config('request.jwt.claim.sub','${ids[name]}',false);set role authenticated;`);
  await actor('alice');
  await db.query("insert into public.dms(participants) values(array['alice','bob'])");
  await assert.rejects(db.query("insert into public.dms(participants) values(array['alice','bob'])"),'ordinary DMs still enforce uniqueness');
  const first=(await db.query("select public.chat_create_group('First',array['bob']) id")).rows[0].id;
  const second=(await db.query("select public.chat_create_group('Second',array['bob']) id")).rows[0].id;
  assert.notEqual(first,second,'same creator can own multiple groups');
  await actor('bob');
  for(const group of [first,second])await db.query('select public.chat_respond_group_invite($1,true)',[group]);
  assert.equal((await db.query('select count(*)::int n from public.chat_list_conversations() where is_group')).rows[0].n,2,'same members can join multiple groups alongside their DM');
  for(const group of [first,second])await db.query("select public.chat_manage_group($1,'leave','','')",[group]);
  await actor('alice');
  for(const group of [first,second])await db.query("select public.chat_manage_group($1,'leave','','')",[group]);
  await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int n from public.dms where is_group')).rows[0].n,2,'multiple empty groups do not collide either');
 }finally{await db.close();}
});

test('private groups require acceptance, isolate history and uploads, and revoke all server access on removal', async()=>{
 const db=new PGlite({extensions:{pgcrypto}});
 const ids={alice:'00000000-0000-4000-8000-000000000001',bob:'00000000-0000-4000-8000-000000000002',charlie:'00000000-0000-4000-8000-000000000003',owner:'00000000-0000-4000-8000-000000000004',banned:'00000000-0000-4000-8000-000000000005'};
 const actor=async(name,role='authenticated')=>{await db.exec(`reset role;select set_config('request.jwt.claim.sub','${name ? ids[name] : ''}',false);set role ${role};`);};
 const scalar=async sql=>(await db.query(sql)).rows[0];
 const denied=async sql=>assert.rejects(db.query(sql));
 try{
  await db.exec(await file('Backend/tests/authorization-fixture.sql'));
  // Production archive reader is not part of the old fixture. Its definition is tested here too.
  await db.exec(`CREATE FUNCTION public.chat_list_deleted_messages(p_limit integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN IF NOT private.chat_is_staff(false) THEN RAISE EXCEPTION 'Staff required'; END IF; RETURN coalesce((SELECT jsonb_agg(to_jsonb(d)) from public.dm_messages d where d.deleted),'[]'::jsonb); END; $$; GRANT EXECUTE ON FUNCTION public.chat_list_deleted_messages(integer) TO authenticated;`);
  for(const name of (await readdir(new URL('../Backend/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())await db.exec(await file('Backend/migrations/'+name));
  await db.exec(await file('Backend/tests/authorization-triggers.sql'));
  for(const [name,id] of Object.entries(ids))await db.query("insert into auth.users(id) values($1);",[id]);
  for(const [name,id] of Object.entries(ids))await db.query("insert into public.profiles(username,user_id,display_name,staff_role,is_banned) values($1,$2,$1,$3,$4)",[name,id,name==='owner'?'owner':'member',name==='banned']);
  await actor('alice');
  const group=(await scalar("select public.chat_create_group('Private test',array['bob']) id")).id;
  assert.ok(group);
  await db.query("insert into public.dm_messages(dm_id,sender,content) values($1,'alice','private secret')",[group]);
  assert.equal((await scalar("select count(*)::int n from public.chat_list_conversations() where is_group")).n,1);
  assert.equal((await scalar("select count(*)::int n from public.chat_list_dm_inbox()")).n,0,'old clients do not treat groups as two-person DMs');
  await denied(`insert into public.dms(title,participants,is_group,group_owner) values('Forged',array['alice','bob'],true,'alice')`);
  await actor('bob');
  assert.equal((await scalar(`select count(*)::int n from public.dms where id='${group}'`)).n,0);
  assert.equal((await scalar(`select count(*)::int n from public.dm_messages where dm_id='${group}'`)).n,0,'invited people cannot read history before acceptance');
  assert.equal((await scalar(`select jsonb_array_length(public.chat_list_group_invites()) n`)).n,1);
  await denied(`select public.chat_manage_group('${group}','rename','','Hijacked')`);
  await denied(`select public.chat_mark_dm_read('${group}')`);
  await actor('owner');
  assert.equal((await scalar(`select count(*)::int n from public.dm_messages where dm_id='${group}' and content like '%secret%'`)).n,0,'owner rank does not grant group search or read access');
  await denied(`select public.chat_respond_group_invite('${group}',true)`);
  assert.equal((await scalar(`delete from public.dm_messages where dm_id='${group}' returning id`))?.id,undefined,'staff cannot delete outsider group messages');
  await actor('bob');
  await db.query(`select public.chat_respond_group_invite('${group}',true)`);
  assert.equal((await scalar(`select count(*)::int n from public.dm_messages where dm_id='${group}'`)).n,1,'accepted members can read earlier messages');
  await db.query(`insert into public.dm_messages(dm_id,sender,content) values('${group}','bob','member message')`);
  await denied(`select public.chat_manage_group('${group}','invite','charlie','')`);
  await denied(`select public.chat_manage_group('${group}','remove','alice','')`);
  await actor('alice');
  await db.query(`insert into storage.objects(bucket_id,name,owner_id) values('liminal-group-media','${group}/${ids.alice}/image.jpg','${ids.alice}')`);
  await db.query(`select public.chat_manage_group('${group}','invite','charlie','')`);
  await actor('charlie');
  assert.equal((await scalar("select count(*)::int n from storage.objects where bucket_id='liminal-group-media'")).n,0);
  await db.query(`select public.chat_respond_group_invite('${group}',false)`);
  assert.equal((await scalar("select jsonb_array_length(public.chat_list_group_invites()) n")).n,0);
  await actor('bob');
  assert.equal((await scalar("select count(*)::int n from storage.objects where bucket_id='liminal-group-media'")).n,1);
  await db.query(`select public.chat_manage_group('${group}','leave','','')`);
  assert.equal((await scalar(`select count(*)::int n from public.dm_messages where dm_id='${group}'`)).n,0);
  assert.equal((await scalar("select count(*)::int n from storage.objects where bucket_id='liminal-group-media'")).n,0,'leaving revokes signing/download access');
  await denied(`insert into public.dm_messages(dm_id,sender,content) values('${group}','bob','unauthorized')`);
  await denied(`select public.chat_mark_dm_read('${group}')`);
  await actor('alice');
  await db.query(`select public.chat_manage_group('${group}','invite','bob','')`);
  await actor('bob');await db.query(`select public.chat_respond_group_invite('${group}',true)`);
  await actor('alice');
  await db.query(`select public.chat_manage_group('${group}','transfer','bob','')`);
  await denied(`select public.chat_manage_group('${group}','rename','','Old owner')`);
  await actor('bob');await db.query(`select public.chat_manage_group('${group}','rename','','Renamed group')`);
  await db.query(`select public.chat_manage_group('${group}','remove','alice','')`);
  await actor('alice');
  assert.equal((await scalar("select count(*)::int n from public.chat_list_conversations() where is_group")).n,0);
  await denied(`select public.chat_manage_group('${group}','leave','','')`);
  await actor('bob');
  await db.query(`update public.dm_messages set deleted=true where dm_id='${group}' and sender='bob'`);
  await actor('owner');
  assert.equal((await scalar("select jsonb_array_length(public.chat_list_deleted_messages(100)) n")).n,0,'shared staff archive excludes private group content');
  await actor('banned');
  await denied("select public.chat_create_group('Nope',array['alice'])");
  await actor(null,'anon');await denied("select public.chat_create_group('Nope',array['alice'])");
  assert.equal((await scalar("select count(*)::int n from storage.objects where bucket_id='liminal-group-media'")).n,0);
  await actor('alice');
  const cleanup=(await scalar("select public.chat_create_group('Account cleanup',array['bob']) id")).id;
  await actor('bob');await db.query(`select public.chat_respond_group_invite('${cleanup}',true)`);
  await actor(null,'postgres');await db.query("delete from public.profiles where username='alice'");
  assert.equal((await scalar(`select group_owner from public.dms where id='${cleanup}'`)).group_owner,'bob');
  await actor('bob');await denied("select public.chat_owner_configure('dms_enabled','false')");
  await actor('owner');await db.query("select public.chat_owner_configure('slow_mode_seconds','1')");
  await denied("select public.chat_owner_configure('max_message_length','9999')");
  await denied("select public.chat_owner_configure('service_role','true')");
  await actor(null,'postgres');
  await db.query(`insert into private.chat_admin_audit(actor_username,action,target,details) values('bob','message_deleted','bob',jsonb_build_object('scope','dm','place','${group}','content','SECRET','preview','SECRET','media_url','group-media:SECRET'))`);
  const audit=(await scalar("select details from private.chat_admin_audit where action='message_deleted' order by id desc limit 1")).details;
  assert.equal(audit.private_group,true);assert.equal(audit.content,undefined);assert.equal(audit.media_url,undefined);assert.equal(audit.preview,undefined);
 }finally{await db.close();}
});

test('group invitation checks respect blocking and enforce membership and pending capacity',async()=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try{
  await db.exec(await file('Backend/tests/authorization-fixture.sql'));
  for(const name of (await readdir(new URL('../Backend/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())await db.exec(await file('Backend/migrations/'+name));
  const names=Array.from({length:18},(_,i)=>'user_'+i),ids=[];
  for(const name of names){const id=(await db.query('select gen_random_uuid() id')).rows[0].id;ids.push(id);await db.query('insert into auth.users(id) values($1)',[id]);await db.query("insert into public.profiles(username,user_id,display_name) values($1,$2,$1)",[name,id]);}
  const actor=async i=>{await db.exec(`reset role;select set_config('request.jwt.claim.sub','${ids[i]}',false);set role authenticated;`);};
  await actor(1);await db.query("insert into public.dm_blocks(blocker,blocked) values('user_1','user_0')");
  await actor(0);await assert.rejects(db.query("select public.chat_create_group('Blocked',array['user_1'])"));
  assert.equal((await db.query('select count(*)::int n from public.dms')).rows[0].n,0,'failed group creation is atomic');
  const group=(await db.query("select public.chat_create_group('Capacity',$1::text[]) id",[names.slice(2,17)])).rows[0].id;
  await assert.rejects(db.query(`select public.chat_manage_group('${group}','invite','user_17','')`));
  await actor(2);await db.query("insert into public.dm_blocks(blocker,blocked) values('user_2','user_0')");
  await assert.rejects(db.query(`select public.chat_respond_group_invite('${group}',true)`),'accepting rechecks blocks');
  await db.query("delete from public.dm_blocks where blocker='user_2'");await db.query(`select public.chat_respond_group_invite('${group}',true)`);
  await actor(0);await db.query(`select public.chat_manage_group('${group}','leave','','')`);
  await actor(2);assert.equal((await db.query(`select group_owner from public.dms where id='${group}'`)).rows[0].group_owner,'user_2');
  assert.equal((await db.query(`select count(*)::int n from public.chat_group_invites where group_id='${group}'`)).rows[0].n,0,'ownership changes cancel stale invitations');
  await db.query(`select public.chat_manage_group('${group}','leave','','')`);
  assert.equal((await db.query('select count(*)::int n from public.dms')).rows[0].n,0,'empty groups are unavailable');
 }finally{await db.close();}
});
