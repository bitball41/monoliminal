// Chat 6.1 delivers database changes as private broadcasts. These tests apply
// every migration to an isolated database and check who receives each change
// and who may join each topic. They never contact production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('changes reach exactly the members who can read them, once per topic', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const names = ['alice', 'bob', 'carol', 'owner', 'banned'];
  const ids = Object.fromEntries(names.map((name, i) => [name, `00000000-0000-4000-8000-00000000010${i + 1}`]));
  const as = name => db.exec(`reset role; select set_config('request.jwt.claim.sub','${ids[name] || ''}',false);`);
  const query = async (sql, params) => (await db.query(sql, params)).rows;
  const sent = async () => {
    const rows = await query(`reset role; select topic, event, payload from realtime.messages order by inserted_at, topic`.replace('reset role; ', ''));
    await db.exec('delete from realtime.messages');
    return rows;
  };
  const topics = rows => rows.map(row => row.topic).sort();
  try {
    await db.exec(await file('Backend/tests/authorization-fixture.sql'));
    const migrations = (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(x => x.endsWith('.sql')).sort();
    for (const name of migrations) await db.exec(await file('Backend/migrations/' + name));
    for (const name of names) {
      await db.query('insert into auth.users(id) values($1)', [ids[name]]);
      await db.query('insert into public.profiles(username,display_name,user_id,staff_role,is_banned) values($1,$1,$2,$3,$4)',
        [name, ids[name], name === 'owner' ? 'owner' : 'member', name === 'banned']);
    }
    await as('owner');
    await db.exec("insert into public.channels(id,label,kind) values('general','General','chat'),('following','Following','forum');");
    await db.exec("insert into public.follows(follower,followee) values('alice','bob')");
    await as('bob');
    const thread = (await query("insert into public.forum_threads(channel_id,title,author) values('following','Feed','bob') returning id"))[0].id;
    await as('alice');
    const dm = (await query("insert into public.dms(participants) values(array['alice','bob']) returning id"))[0].id;
    await sent();

    // A public message goes to everyone once, without search or audit columns.
    await as('alice');
    const publicId = (await query("insert into public.messages(channel_id,sender,content) values('general','alice','hello') returning id"))[0].id;
    let rows = await sent();
    assert.deepEqual(topics(rows), ['chat:live']);
    assert.equal(rows[0].event, 'messages');
    assert.equal(rows[0].payload.op, 'INSERT');
    assert.equal(rows[0].payload.new.content, 'hello');
    for (const hidden of ['search_tsv', 'deleted_by', 'deleted_at']) assert(!(hidden in rows[0].payload.new), hidden);

    // Follower-only feed replies reach the author and followers only.
    await as('bob');
    await db.query("insert into public.messages(channel_id,sender,content) values($1,'bob','for followers')", ['forum:' + thread]);
    assert.deepEqual(topics(await sent()), ['chat:user:alice', 'chat:user:bob']);

    // Owner-preview (Noelle AI) messages reach owners only.
    await as('owner');
    await db.exec("insert into public.messages(channel_id,sender,content) values('general','owner','@NoelleAI hi')");
    assert.deepEqual(topics(await sent()), ['chat:user:owner']);

    // A soft delete carries no content.
    await as('alice');
    await db.query('update public.messages set deleted=true where id=$1', [publicId]);
    rows = await sent();
    assert.deepEqual(topics(rows), ['chat:live']);
    assert.equal(rows[0].payload.new.deleted, true);
    assert(!('content' in rows[0].payload.new));

    // DMs reach their participants only.
    await as('alice');
    await db.query("insert into public.dm_messages(dm_id,sender,content) values($1,'alice','secret')", [dm]);
    rows = await sent();
    assert.deepEqual(topics(rows), ['chat:user:alice', 'chat:user:bob']);
    assert.equal(rows[0].payload.new.content, 'secret');

    // Read cursors reach their owner only.
    await db.query("insert into public.dm_reads(dm_id,username,last_read_at) values($1,'alice',now())", [dm]);
    assert.deepEqual(topics(await sent()), ['chat:user:alice']);

    // Profiles reach everyone, never with the legacy password column.
    await db.exec("update public.profiles set custom_status='busy' where username='alice'");
    rows = await sent();
    assert.deepEqual(topics(rows), ['chat:live']);
    assert.equal(rows[0].payload.new.custom_status, 'busy');
    assert(!('password_hash' in rows[0].payload.new));

    // Joining: members join chat:live and only their own user topic; banned
    // accounts join neither; nobody can publish.
    await db.exec("reset role; insert into realtime.messages(topic,extension,event,payload,private) values ('chat:live','broadcast','x','{}',true),('chat:user:alice','broadcast','x','{}',true),('chat:user:bob','broadcast','x','{}',true)");
    const canRead = async (name, topic) => {
      await as(name);
      await db.exec(`set role authenticated; select set_config('realtime.topic','${topic}',false);`);
      const n = (await query('select count(*)::int n from realtime.messages where topic=$1', [topic]))[0].n;
      await db.exec("reset role; select set_config('realtime.topic','',false);");
      return n > 0;
    };
    assert.equal(await canRead('alice', 'chat:live'), true);
    assert.equal(await canRead('alice', 'chat:user:alice'), true);
    assert.equal(await canRead('alice', 'chat:user:bob'), false);
    assert.equal(await canRead('banned', 'chat:live'), false);
    assert.equal(await canRead('banned', 'chat:user:banned'), false);
    await as('alice');
    await db.exec("set role authenticated; select set_config('realtime.topic','chat:live',false);");
    await assert.rejects(db.exec("insert into realtime.messages(topic,extension,event,payload,private) values ('chat:live','broadcast','messages','{}',true)"));
    await db.exec('reset role');
  } finally { await db.close(); }
});

import vm from 'node:vm';
const chat = await file('Chat/chat.html');
function section(start, end) {
  const from = chat.indexOf(start), to = chat.indexOf(end, from);
  assert(from >= 0 && to > from, start);
  return chat.slice(from, to);
}
function fakeSupabase() {
  const channels = [];
  return { channels, sb: { channel(topic, options = {}) {
    const channel = { topic, options, bindings: [], state: 'joining', callback: null,
      on(type, filter, fn) { this.bindings.push({ type, filter, fn }); return this; },
      subscribe(callback) { this.callback = callback; channels.push(this); return this; } };
    return channel;
  } } };
}
function realtimeContext(mode) {
  const { sb, channels } = fakeSupabase(), calls = [];
  const c = vm.createContext({ sb, me: { username: 'alice' }, voice: {}, realtimeGen: 1, realtimeReadyOnce: false,
    realtimeAttemptAt: 0, realtimeRecoverAttempt: 2, Object, String, console,
    handleMessageChange: p => calls.push(['messages', p]), handleDmChange: p => calls.push(['dm_messages', p]),
    handleDmReadCursor() {}, checkPrivateVoiceAccess() {}, queueConversationRefresh() {}, onProfileRealtime() {},
    reloadSubroleCatalog() {}, handleSettingsChange() {}, handleChannelChange() {}, handleForumThreadChange() {},
    handleFollowChange() {}, handlePollChange() {}, handleStickerChange() {}, loadVoiceServerMutes() {},
    realtimeHealthy: () => false, updateConnection() {}, noteRealtimeJoined() {}, reconcileAfterSubscribe() {},
    scheduleRealtimeRecover() { calls.push(['schedule']); }, recoverRealtime: async () => { calls.push(['recover']); },
    logChatWarning() {}, dbChannel: null });
  vm.runInContext(section('    const LIVE_TOPIC =', '    function setupRealtime() {').replace("let realtimeMode = 'broadcast'", `let realtimeMode = '${mode}'`)
    + '\nglobalThis.getMode = () => realtimeMode;', c);
  return { c, channels, calls };
}

test('Chat joins two private broadcast topics instead of thirteen table listeners', () => {
  const { c, channels, calls } = realtimeContext('broadcast');
  c.setupDataChannels(1);
  assert.deepEqual(channels.map(ch => [ch.topic, ch.options.config?.private]), [['chat:live', true], ['chat:user:alice', true]]);
  for (const ch of channels) {
    assert.equal(ch.bindings.filter(b => b.type === 'postgres_changes').length, 0);
    assert(ch.bindings.some(b => b.type === 'broadcast' && b.filter.event === 'messages'));
  }
  const message = { id: 'm1', channel_id: 'general', content: 'hi' };
  channels[0].bindings.find(b => b.filter.event === 'messages').fn({ payload: { op: 'INSERT', new: message, old: null } });
  assert.equal(calls[0][1].eventType, 'INSERT');
  assert.equal(calls[0][1].new, message);
  channels[1].bindings.find(b => b.filter.event === 'dm_messages').fn({ payload: { op: 'DELETE', new: null, old: { id: 'd1' } } });
  assert.equal(calls[1][1].new, null, 'a delete has no new row, as postgres_changes');
  assert.equal(calls[1][1].old.id, 'd1');
});

test('an unauthorized first join falls back to the previous listeners', () => {
  const { c, channels, calls } = realtimeContext('broadcast');
  c.setupDataChannels(1);
  channels[0].callback('CHANNEL_ERROR', new Error('"Unauthorized: You do not have permissions to read from this Channel topic: chat:live"'));
  assert.equal(c.getMode(), 'legacy');
  assert.deepEqual(calls.at(-1), ['recover']);
  const legacy = realtimeContext('legacy');
  legacy.c.setupDataChannels(1);
  assert.equal(legacy.channels.length, 1);
  const tables = legacy.channels[0].bindings.map(b => b.filter.table);
  assert.equal(tables.length, 13);
  assert.equal(legacy.channels[0].bindings.find(b => b.filter.table === 'dm_reads').filter.filter, 'username=eq.alice');
});

test('after broadcast has worked once, an error recovers normally instead of falling back', () => {
  const { c, channels, calls } = realtimeContext('broadcast');
  c.setupDataChannels(1);
  vm.runInContext('realtimeReadyOnce = true;', c);
  channels[0].callback('SUBSCRIBED');
  channels[0].callback('CHANNEL_ERROR', new Error('Unauthorized: token has expired'));
  assert.equal(c.getMode(), 'broadcast');
  assert.deepEqual(calls.at(-1), ['schedule']);
});
