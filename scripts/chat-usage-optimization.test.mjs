import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile, readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';

const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const chat = await file('Chat/chat.html');
const migration = '20261025051855_optimize_chat_usage.sql';
function section(start, end) { const a=chat.indexOf(start),b=chat.indexOf(end,a); assert(a>=0&&b>a); return chat.slice(a,b); }

test('batched unreads preserve RLS; cursor writes never mutate DM messages; old clients invalidate stale thumbnails', async () => {
  const db = new PGlite({extensions:{pgcrypto}});
  const names=['alice','bob','owner','banned'];
  const ids=Object.fromEntries(names.map((name,i)=>[name,`00000000-0000-4000-8000-00000000000${i+1}`]));
  const query=async(sql,args)=>(await db.query(sql,args)).rows;
  const actor=async name=>db.exec(`reset role; select set_config('request.jwt.claim.sub','${ids[name]||''}',false); set role ${name?'authenticated':'anon'};`);
  try {
    await db.exec(await file('Backend/tests/authorization-fixture.sql'));
    const migrations=(await readdir(new URL('../Backend/migrations/',import.meta.url))).filter(x=>x.endsWith('.sql')).sort();
    for(const name of migrations) await db.exec(await file('Backend/migrations/'+name));
    for(const name of names){
      await db.query('insert into auth.users(id) values($1)',[ids[name]]);
      await db.query('insert into public.profiles(username,display_name,user_id,staff_role,is_banned) values($1,$1,$2,$3,$4)',[name,ids[name],name==='owner'?'owner':'member',name==='banned']);
    }
    await db.exec(`select set_config('request.jwt.claim.sub','${ids.owner}',false)`);
    await db.exec("insert into public.channels(id,label,kind) values('general','General','chat'),('following','Following','forum'),('forum','Forum','forum');");
    const thread=(await query("insert into public.forum_threads(channel_id,title,author) values('following','Private feed','bob') returning id"))[0].id;
    await db.query("insert into public.messages(channel_id,sender,content) values('general','bob','hello'),('general','alice','mine'),('general','owner','@NoelleAI private'),($1,'bob','followers only')",['forum:'+thread]);
    await db.exec("insert into public.forum_threads(channel_id,title,author) values('forum','Public post','bob')");
    await db.exec("insert into public.messages(channel_id,sender,content) select 'general','bob',i::text from generate_series(1,120)i");
    const dm=(await query("insert into public.dms(participants) values(array['alice','bob']) returning id"))[0].id;
    const other=(await query("insert into public.dms(participants) values(array['bob','owner']) returning id"))[0].id;
    const message=(await query("insert into public.dm_messages(dm_id,sender,content) values($1,'bob','Hi') returning *",[dm]))[0];
    await db.exec(await file('Backend/tests/authorization-triggers.sql'));
    await actor('alice');
    const result=await query("select * from public.chat_unread_counts('{\"general\":null,\"following\":null,\"forum\":null}') order by channel_id");
    assert.equal(result.find(r=>r.channel_id==='general').unread_count,100,'server caps work at the displayed 99+');
    assert.equal(result.find(r=>r.channel_id==='following').unread_count,0,'unfollowed content stays private');
    assert.equal(result.find(r=>r.channel_id==='forum').unread_count,1);
    await db.query('select public.chat_update_dm_read_cursor($1,$2)',[dm,message.created_at]);
    const first=(await query('select * from public.dm_reads where dm_id=$1',[dm]))[0];
    await db.query('select public.chat_update_dm_read_cursor($1,$2)',[dm,'2000-01-01']);
    assert.deepEqual((await query('select * from public.dm_reads where dm_id=$1',[dm]))[0],first,'cursor never moves backwards');
    assert.deepEqual((await query('select * from public.dm_messages where id=$1',[message.id]))[0],message,'no message or read_by mutation');
    await db.query('select public.chat_mark_dm_read($1)',[dm]);
    assert.deepEqual((await query('select * from public.dm_messages where id=$1',[message.id]))[0],message,'legacy endpoint is cursor-only too');
    await assert.rejects(db.query('select public.chat_update_dm_read_cursor($1,now())',[other]));
    await assert.rejects(db.query("select public.chat_unread_counts('[]')"));
    await assert.rejects(db.query("select public.chat_unread_counts((select jsonb_object_agg(i,null) from generate_series(1,65)i))"));
    await db.exec("update public.profiles set pfp='original',pfp_thumbnail='thumb' where username='alice'");
    assert.equal((await query("select pfp_thumbnail from public.profiles where username='alice'"))[0].pfp_thumbnail,'thumb');
    await db.exec("update public.profiles set pfp='new-original' where username='alice'");
    assert.equal((await query("select pfp_thumbnail from public.profiles where username='alice'"))[0].pfp_thumbnail,'');
    await actor('banned'); assert.equal((await query("select count(*)::int n from public.chat_unread_counts('{\"general\":null}')"))[0].n,0);
    await assert.rejects(db.query('select public.chat_update_dm_read_cursor($1,now())',[dm]));
    await actor(null); await assert.rejects(db.query("select public.chat_unread_counts('{}')"));
    await db.exec('reset role'); await db.exec(await file('Backend/migrations/'+migration));
  } finally {await db.close();}
});

test('DM cursor calls coalesce and unchanged visible messages do not write again', async () => {
  let calls=0;
  const rows=[{id:'a',created_at:'2026-10-25T00:00:00Z',sender:'bob'}];
  const c=vm.createContext({setTimeout,document:{visibilityState:'visible'},me:{username:'alice'},currentView:{type:'dm',id:'one'},
    viewKey:v=>'dm:'+v.id,msgCache:new Map([['dm:one',rows]]),historyContexts:new Map(),dms:[{id:'one'}],markViewRead(){},logChatWarning(){},
    sb:{rpc:async(name,args)=>{assert.equal(name,'chat_update_dm_read_cursor');calls++;return {data:args.p_read_at};}}});
  vm.runInContext(section('    const dmReadWrites =','    /* ============================= 37f.'),c);
  await Promise.all(Array.from({length:20},()=>c.markDmRead(c.currentView))); assert.equal(calls,1);
  await c.markDmRead(c.currentView); assert.equal(calls,1);
  rows.push({id:'b',created_at:'2026-10-25T00:00:01Z',sender:'bob'});
  await c.markDmRead(c.currentView); assert.equal(calls,2);
  c.document.visibilityState='hidden'; rows.push({id:'c',created_at:'2026-10-25T00:00:02Z'});
  await c.markDmRead(c.currentView); assert.equal(calls,2,'hidden tabs do not mark unseen messages read');
});

test('avatar persistence deduplicates concurrent fetches and survives a fresh page instance',async()=>{
  const disk=new Map();let fetches=0,sequence=0;
  const cache={match:async key=>disk.get(key)?.clone(),put:async(key,response)=>disk.set(key,response),keys:async()=>[...disk.keys()],delete:async key=>disk.delete(key)};
  const context=()=>vm.createContext({Map,Date,URL:class extends URL{static createObjectURL(){return 'blob:avatar-'+(++sequence)} static revokeObjectURL(){}},
    runtimeSupabaseUrl:'https://example.supabase.co',caches:{open:async()=>cache},document:{images:[]},
    fetch:async()=>{fetches++;return new Response('webp',{headers:{'content-type':'image/webp','content-length':'4'}})}});
  const source=section('    const AVATAR_CACHE =','    function setupAvatarLoading('),url='https://example.supabase.co/storage/v1/object/public/liminal-pfp/unique.webp';
  const a=context();vm.runInContext(source,a);
  const images=await Promise.all(Array.from({length:40},()=>a.cachedAvatarUrl(url)));
  assert.equal(new Set(images).size,1);assert.equal(fetches,1);
  const b=context();vm.runInContext(source,b);await b.cachedAvatarUrl(url);assert.equal(fetches,1,'second page reads the persistent browser cache');
  const failed=context();failed.fetch=async()=>{fetches++;return new Response('missing',{status:404})};vm.runInContext(source,failed);
  const bad=url.replace('unique','missing');await assert.rejects(failed.cachedAvatarUrl(bad));await assert.rejects(failed.cachedAvatarUrl(bad));assert.equal(fetches,2,'missing avatars back off');
});
