import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { analyticsJs } from './chat-analytics-ui.mjs';
const file = path => readFile(new URL('../'+path,import.meta.url),'utf8');

test('analytics deduplicates identities, preserves sent totals, enforces permissions, and shares dashboard definitions',async()=>{
  const db=new PGlite({extensions:{pgcrypto}});
  const ids=Object.fromEntries(['alice','bob','owner','tester','banned','Luna'].map((name,i)=>[name,`00000000-0000-4000-8000-00000000000${i+1}`]));
  const browser='shared-browser-identifier', other='other-browser-identifier';
  const actor=async(name,role='authenticated')=>db.exec(`reset role;select set_config('request.jwt.claim.sub','${ids[name]||''}',false);set role ${role};`);
  const one=async(sql,params)=>(await db.query(sql,params)).rows[0];
  const summary=async()=>{await actor('owner');return (await one('select public.chat_get_analytics() data')).data;};
  try {
    await db.exec(await file('Backend/tests/authorization-fixture.sql'));
    const migrations=(await readdir(new URL('../Backend/migrations/',import.meta.url))).filter(x=>x.endsWith('.sql')).sort();
    const analyticsIndex=migrations.findIndex(x=>x.endsWith('_chat_analytics.sql'));
    for(const name of migrations.slice(0,analyticsIndex)) await db.exec(await file('Backend/migrations/'+name));
    for(const [name,id] of Object.entries(ids)) {
      await db.query('insert into auth.users(id) values($1)',[id]);
      await db.query('insert into public.profiles(username,display_name,user_id,staff_role,is_banned,is_test_account) values($1,$1,$2,$3,$4,$5)',[name,name==='Luna'?null:id,name==='owner'?'owner':'member',name==='banned',name==='tester']);
      await db.query('insert into public.chat_devices(device_id,username) values($1,$2)',[browser,name]);
    }
    await db.exec("insert into public.channels(id,label) values('general','General'); insert into public.messages(sender,channel_id,deleted) values('alice','general',true),('alice','general',false),('Luna','general',false),('tester','general',false);");
    const dm=(await one("insert into public.dms(participants) values(array['alice','bob']) returning id")).id;
    await db.query("insert into public.dm_messages(dm_id,sender,content) values($1,'alice','secret must never appear in analytics')",[dm]);
    await db.exec(await file('Backend/migrations/'+migrations.find(x=>x.endsWith('_chat_analytics.sql'))));
    for(const name of migrations.slice(analyticsIndex+1)) await db.exec(await file('Backend/migrations/'+name));
    let s=await summary();
    assert.equal(s.messages_total,2,'surviving soft-deleted rows backfill into sent counts');
    assert.equal(s.visible_messages,1);
    assert.equal(s.dm_messages_total,1);
    assert.equal(s.devices_total,1,'one browser across six accounts');
    assert.equal(s.dau,0,'no fabricated activity backfill');
    assert.equal(s.daily.length,30);
    assert.equal(s.daily[0].accounts,null,'missing historical activity stays unknown');
    assert.equal(s.daily.at(-1).accounts,0);
    assert.ok(!JSON.stringify(s).includes('secret must never'));
    await actor('alice');
    await assert.rejects(db.query('select public.chat_get_analytics()'),'members cannot read analytics');
    await assert.rejects(db.query('select private.chat_analytics_summary()'),'private bypass cannot be called');
    await assert.rejects(db.query('select * from private.chat_activity_days'));
    await assert.rejects(db.query("select public.chat_record_activity('not-registered-browser')"));
    for(let i=0;i<4;i++) await db.query('select public.chat_record_activity($1)',[browser]);
    await db.exec('reset role');
    assert.equal((await one('select count(*)::int n from private.chat_activity_days')).n,1,'refreshes/tabs are one daily account-browser row');
    await db.query('insert into public.chat_devices(device_id,username) values($1,$2)',[other,'alice']);
    await actor('alice'); await db.query('select public.chat_record_activity($1)',[other]);
    await actor('bob'); await db.query('select public.chat_record_activity($1)',[browser]);
    await actor('tester');assert.equal((await one('select public.chat_record_activity($1) ok',[browser])).ok,false);
    await actor('banned');await assert.rejects(db.query('select public.chat_record_activity($1)',[browser]));
    await actor(null,'anon');await assert.rejects(db.query('select public.chat_get_analytics()'));await assert.rejects(db.query('select public.chat_record_activity($1)',[browser]));
    s=await summary();assert.equal(s.dau,2);assert.equal(s.wau,2);assert.equal(s.mau,2);assert.equal(s.browsers_today,2);assert.equal(s.foreground_5m,2);
    await db.exec('reset role');
    await db.query("insert into private.chat_activity_days select (now() at time zone 'America/Chicago')::date-1,$1,$2,now()-interval '1 day',now()-interval '1 day'",[ids.alice,browser]);
    s=await summary();assert.equal(s.returning_today,1,'returning is a distinct account observed before today');
    await db.exec('reset role');
    const day=(await one("select (now() at time zone 'America/Chicago')::date::text as day")).day;
    // DST-safe local midnight: both facts are close in UTC, but on different CT dates.
    await db.query("insert into private.chat_message_facts values('channel',gen_random_uuid(),'boundary','general','text',($1::date::timestamp at time zone 'America/Chicago')-interval '1 second',false),('channel',gen_random_uuid(),'boundary','general','text',($1::date::timestamp at time zone 'America/Chicago')+interval '1 second',false)",[day]);
    s=await summary();assert.equal(s.daily.at(-2).messages,1);assert.equal(s.daily.at(-1).messages,3);
    await db.exec('reset role');
    await db.exec(await file('Backend/tests/authorization-triggers.sql'));
    await actor('alice');
    const message=(await one("insert into public.messages(sender,channel_id,content) values('alice','general','human') returning id")).id;
    const before=(await summary()).messages_total;
    await actor('alice');await db.query("update public.messages set content='edited',edited=true where id=$1",[message]);
    await db.query('update public.messages set deleted=true where id=$1',[message]);
    await db.query('delete from public.messages where id=$1',[message]);
    s=await summary();assert.equal(s.messages_total,before,'edits and both deletion paths preserve exactly one fact');
    await db.exec('reset role');
    assert.equal((await one("select count(*)::int n from private.chat_message_facts where message_id=$1",[message])).n,1);
    // New signups are captured once and survive account removal.
    await db.exec("select set_config('app.chat_account_delete','true',false)");
    await db.exec("insert into auth.users values('00000000-0000-4000-8000-000000000099'); insert into public.profiles(username,display_name,user_id) values('newbie','Newbie','00000000-0000-4000-8000-000000000099'); delete from public.profiles where username='newbie';");
    assert.equal((await one("select count(*)::int n from private.chat_signup_facts where user_id='00000000-0000-4000-8000-000000000099'")).n,1);
    await db.exec("select set_config('app.chat_account_delete','false',false)");
    await db.exec(`create table private.chat_deployments(id uuid,app text,version text,notes text,storage_path text,size_bytes bigint,sha256 text,deployed_by text,deployed_at timestamptz,is_rollback boolean);`);
    const token='analytics-test-token-with-at-least-thirty-two-characters';
    await db.query("insert into private.chat_admin_sessions(token_hash,username,expires_at) values(extensions.digest($1,'sha256'),'owner',now()+interval '1 hour')",[token]);
    await actor('owner');
    const dashboard=(await one('select public.admin_dashboard_get_state($1) data',[token])).data;
    s=await summary();
    for(const key of ['dau','wau','mau','messages_total','dm_messages_total','devices_total','members_total','active_senders_7d']) assert.equal(dashboard.stats[key],s[key],key+' agrees across panels');
    assert.equal(dashboard.analytics.daily.length,30);
    assert.equal(dashboard.stats.active_dashboard_sessions,1);
    await db.query('select public.admin_dashboard_get_state($1)',[token]);
    await actor('alice');await assert.rejects(db.query("select public.admin_dashboard_get_state('forged')"));
  } finally {await db.close();}
});

test('foreground collector stops hidden/idle/offline and coalesces calls with bounded retry',async()=>{
  const html=await file('Chat/chat.html');
  const source=html.slice(html.indexOf('    // Foreground activity, independent'),html.indexOf('    function showMaintenance()'));
  let now=1_000_000,calls=0,pending,fail=false;
  const context=vm.createContext({Date:{now:()=>now},console:{warn(){}},me:{username:'alice'},presenceLeft:false,presenceStopped:false,
    document:{visibilityState:'visible'},navigator:{onLine:true},isHiddenBot:()=>false,getDeviceId:async()=> 'browser-id',
    sb:{rpc:async()=>{calls++;if(pending)await pending;return {error:fail?new Error('offline'):null};}},window:{}});
  vm.runInContext(source,context);
  const run=async()=>vm.runInContext('recordChatActivity()',context);
  vm.runInContext('analyticsInteractionAt=Date.now()',context);
  await run();await run();assert.equal(calls,1);
  now+=60001;context.document.visibilityState='hidden';await run();assert.equal(calls,1);
  context.document.visibilityState='visible';context.navigator.onLine=false;await run();assert.equal(calls,1);
  context.navigator.onLine=true;now+=300001;await run();assert.equal(calls,1,'idle tab is not activity');
  vm.runInContext('analyticsInteractionAt=Date.now()',context);
  let release;pending=new Promise(resolve=>release=resolve);
  const a=run();await Promise.resolve();const b=run();release();await Promise.all([a,b]);pending=null;assert.equal(calls,2);
  now+=60001;fail=true;await run();assert.equal(calls,3);
  now+=60001;await run();assert.equal(calls,3,'failure backs off');
  now+=60001;fail=false;await run();assert.equal(calls,4);
  context.me.is_test_account=true;now+=60001;await run();assert.equal(calls,4);
});

test('shared analytics UI escapes content, represents unknown history, and embeds identically in both apps',async()=>{
  const context=vm.createContext({Intl,Date,esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')});
  vm.runInContext(analyticsJs,context);
  const s={generated_at:'2026-10-16T01:00:00Z',activity_since:'2026-10-16T00:00:00Z',durable_messages_since:'2026-10-16T00:00:00Z',
    daily:[{day:'2026-10-14',accounts:null,browsers:null,messages:0,dms:0,signups:0},{day:'2026-10-15',accounts:2,browsers:1,messages:4,dms:3,signups:1}],
    top_channels:[{label:'<img src=x onerror=alert(1)>',messages:4,senders:2}]};
  context.summary=s;
  const html=vm.runInContext('analyticsMarkup(summary)',context);
  assert.ok(html.includes('Collecting first 30 days'));assert.ok(html.includes('—'));
  assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));
  assert.ok(vm.runInContext("analyticsChart(summary,'accounts')",context).includes('not tracked'));
  for(const path of ['Chat/chat.html','Admin/liminal-admin-dashboard.html']) {
    const embedded=(await file(path)).match(/\/\* CHAT_ANALYTICS_UI_START \*\/[\s\S]*?\/\* CHAT_ANALYTICS_UI_END \*\//)[0];
    assert.equal(embedded,analyticsJs.trim(),path+' uses canonical view');
    const scripts=[...(await file(path)).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    for(const script of scripts) if(script[2].trim() && (!/type=/.test(script[1]) || /type=["'](?:text\/javascript|module)/.test(script[1]))) new vm.Script(script[2],{filename:path});
  }
});
