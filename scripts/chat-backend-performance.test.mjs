import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const repairs = ['20261022163655_index_owner_preview_message_lookups.sql', '20261022163658_reduce_chat_query_work.sql'];

test('backend repairs preserve visibility, inboxes, privileges and every analytics field', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const names = ['alice', 'bob', 'charlie', 'owner', 'banned', 'tester'];
  const ids = Object.fromEntries(names.map((name, i) => [name, `00000000-0000-4000-8000-00000000000${i + 1}`]));
  const actor = async name => db.exec(`reset role; select set_config('request.jwt.claim.sub','${ids[name] || ''}',false); set role authenticated;`);
  const query = async sql => (await db.query(sql)).rows;
  const snapshot = async name => {
    await actor(name);
    return Promise.all([
      query('select id from public.messages order by id'),
      query('select id from public.forum_threads order by id'),
      query('select id from public.dms order by id'),
      query('select id from public.dm_messages order by id'),
      query('select * from public.dm_reads order by dm_id,username'),
      query('select * from public.chat_list_conversations() order by id'),
      query('select public.chat_list_group_invites() as invites'),
      query('select * from public.follows order by follower,followee'),
    ]);
  };
  try {
    await db.exec(await file('Backend/tests/authorization-fixture.sql'));
    const migrations = (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(x => x.endsWith('.sql')).sort();
    for (const name of migrations.filter(x => !repairs.includes(x))) await db.exec(await file('Backend/migrations/' + name));
    for (const name of names) {
      await db.query('insert into auth.users(id) values($1)', [ids[name]]);
      await db.query('insert into public.profiles(username,display_name,user_id,staff_role,is_banned,is_test_account) values($1,$1,$2,$3,$4,$5)', [name, ids[name], name === 'owner' ? 'owner' : 'member', name === 'banned', name === 'tester']);
    }
    await db.exec(`select set_config('request.jwt.claim.sub','${ids.owner}',false)`);
    await db.exec("insert into public.channels(id,label,kind) values('general','General','chat'),('following','Following','forum');");
    const thread = (await query("insert into public.forum_threads(channel_id,title,author) values('following','Restricted feed','bob') returning id"))[0].id;
    await db.query("insert into public.messages(channel_id,sender,content) values('general','alice','public'),('general','owner','@NoelleAI private'),($1,'bob','followers only')", ['forum:' + thread]);
    await db.exec("insert into public.follows(follower,followee) values('alice','bob')");
    const dm = (await query("insert into public.dms(participants) values(array['alice','bob']) returning id"))[0].id;
    const group = (await query("insert into public.dms(participants,is_group,group_owner,title) values(array['bob','charlie'],true,'bob','Private') returning id"))[0].id;
    await db.exec(`select set_config('request.jwt.claim.sub','${ids.bob}',false)`);
    await db.query("insert into public.dm_messages(dm_id,sender,content) values($1,'bob','ordinary DM'),($2,'charlie','group secret')", [dm, group]);
    await db.query("insert into public.dm_reads(dm_id,username,last_read_at) values($1,'alice',now())", [dm]);
    await db.exec(await file('Backend/tests/authorization-triggers.sql'));
    await db.exec('begin');
    const before = new Map();
    for (const name of [...names, null]) before.set(name, await snapshot(name));
    await db.exec('reset role');
    const analytics = (await query('select private.chat_analytics_summary() as data'))[0].data;
    for (const name of repairs) await db.exec(await file('Backend/migrations/' + name));
    assert.deepEqual((await query('select private.chat_analytics_summary() as data'))[0].data, analytics);
    for (const name of [...names, null]) assert.deepEqual(await snapshot(name), before.get(name), 'same visible rows for ' + name);
    await db.exec('rollback; reset role');
    for (const name of repairs) await db.exec(await file('Backend/migrations/' + name));
    await actor('alice');
    await assert.rejects(db.query('select public.chat_get_analytics()'));
    await assert.rejects(db.query('select private.chat_analytics_summary()'));
    await assert.rejects(db.query("insert into public.messages(channel_id,sender,content) values('general','bob','forged sender')"));
    await actor('banned');
    assert.equal((await query('select count(*)::int as n from public.messages'))[0].n, 0);
    await assert.rejects(db.query("insert into public.messages(channel_id,sender,content) values('general','banned','blocked')"));
    await actor('alice');
    await assert.rejects(db.query('select public.chat_mark_dm_read($1)', [group]));
    await db.exec('reset role');
    // Reapplying the maintenance script must not change policy semantics.
    const once = await query("select tablename,policyname,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname");
    await db.exec(await file('Backend/migrations/' + repairs[1]));
    assert.deepEqual(await query("select tablename,policyname,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname"), once);
  } finally { await db.close(); }
});

test('owner-preview lookups and exact unread counts use indexes on a realistic history', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create table public.messages(id uuid primary key,channel_id text,created_at timestamptz,sender text,deleted boolean,owner_preview boolean);
      insert into public.messages select md5(i::text)::uuid,'general',now()-i*interval '1 second','member',false,i%500=0 from generate_series(1,20000) i;`);
    for (const name of repairs.slice(0, 1)) await db.exec(await file('Backend/migrations/' + name));
    const repair = await file('Backend/migrations/' + repairs[1]);
    await db.exec(repair.slice(repair.indexOf('CREATE INDEX IF NOT EXISTS messages_unread'), repair.indexOf('\n\nNOTIFY')));
    await db.exec('analyze public.messages');
    const plan = async sql => JSON.stringify((await db.query('explain (format json) ' + sql)).rows);
    assert.match(await plan("select 1 from public.messages where owner_preview and id::text='00000000-0000-0000-0000-000000000000'"), /messages_owner_preview_id_text_idx/);
    assert.match(await plan("select count(*) from public.messages where channel_id='general' and deleted=false and created_at>now()-interval '10 seconds' and sender<>'alice'"), /messages_unread_channel_created_idx/);
    assert.equal((await db.query("select count(*)::int as n from public.messages where owner_preview and id::text='malformed-json-id'")).rows[0].n, 0);
  } finally { await db.close(); }
});
