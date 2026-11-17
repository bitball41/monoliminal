// QuoteBot replaces Noelle AI. Checked against every migration in an isolated database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  const people = { owner: 'owner', mod: 'mod', alice: 'member', bob: 'member', carol: 'member' };
  const ids = Object.fromEntries(Object.keys(people).map((name, i) => [name, `00000000-0000-4000-8000-0000000003${String(i + 10)}`]));
  await db.exec(await file('Backend/tests/authorization-fixture.sql'));
  for (const name of (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
    await db.exec(await file('Backend/migrations/' + name));
  }
  // Before the triggers: the speak guard only lets owners set a minimum role.
  await db.exec(`insert into public.channels(id,label,kind,min_speak_role) values
    ('general','general','chat','member'),('news','news','chat','admin'),('board','board','forum','member')`);
  await db.exec(await file('Backend/tests/authorization-triggers.sql'));
  for (const [name, role] of Object.entries(people)) {
    await db.query('insert into auth.users(id) values($1)', [ids[name]]);
    await db.query('insert into public.profiles(username,display_name,user_id,staff_role) values($1,$2,$3,$4)', [name, name === 'alice' ? 'Alice A.' : name, ids[name], role]);
  }
  const as = name => db.exec(`reset role; select set_config('request.jwt.claim.sub','${ids[name] || ''}',false); set role authenticated;`);
  const call = async (name, sql, params = []) => { await as(name); try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); } };
  const say = async (name, content, channel = 'general', extra = {}) =>
    (await call(name, `insert into public.messages(channel_id,sender,content,type) values($1,$2,$3,$4) returning id`, [channel, name, content, extra.type || 'text']))[0].id;
  const quote = async (name, id, style = 'classic') => (await call(name, 'select public.chat_post_quote($1,$2) q', [id, style]))[0].q;
  const age = () => db.exec(`update private.chat_quote_requests set created_at = created_at - interval '10 seconds'`);
  return { db, call, say, quote, age };
}

test('Noelle AI is gone, its name stays reserved and @NoelleAI is plain text', async () => {
  const { db, call, say } = await setup();
  try {
    const left = (await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private') and p.prokind='f' and (p.proname ilike '%noelle%' or pg_get_functiondef(p.oid) ilike '%noelleai%')`)).rows;
    assert.deepEqual(left, []);
    assert.equal((await db.query(`select count(*)::int n from pg_class where relname ilike 'noelle%'`)).rows[0].n, 0);
    await say('alice', 'hey @NoelleAI are you there');
    const row = (await call('alice', `select owner_preview from public.messages where content like 'hey @NoelleAI%'`))[0];
    assert.equal(row.owner_preview, false);
    await assert.rejects(db.query(`update public.profiles set username='NoelleAI' where username='carol'`), /profiles_noelle_ai_reserved/);
    await assert.rejects(db.query(`update public.profiles set username='quotebot' where username='carol'`), /profiles_quotebot_reserved/);
  } finally { await db.close(); }
});

test('a quote is a server snapshot of the real message, posted as QuoteBot', async () => {
  const { db, call, say, quote } = await setup();
  try {
    const id = await say('alice', '  i am never eating cereal with orange juice again  ');
    const q = await quote('bob', id, 'light');
    assert.equal(q.sender, 'QuoteBot'); assert.equal(q.type, 'quote'); assert.equal(q.content, '');
    assert.equal(q.channel_id, 'general');
    assert.equal(q.reply_to.id, id); assert.equal(q.reply_to.sender, 'alice'); assert.equal(q.reply_to.requested_by, 'bob');
    assert.equal(q.reply_to.bot, 'quote');
    assert.equal(q.reply_to.quote.text, 'i am never eating cereal with orange juice again');
    assert.equal(q.reply_to.quote.display_name, 'Alice A.'); assert.equal(q.reply_to.quote.style, 'light');
    assert.equal((await call('carol', `select count(*)::int n from public.messages where sender='QuoteBot'`))[0].n, 1, 'everyone sees it');
    // Members still cannot post as QuoteBot themselves, even with a forged reply.
    await assert.rejects(call('bob', `insert into public.messages(channel_id,sender,content,type,reply_to)
      values('general','QuoteBot','','quote','{"bot":"quote","quote":{"text":"fake"}}')`), /Sender must match/);
  } finally { await db.close(); }
});

test('quotes follow channel, visibility, moderation and rate rules', async () => {
  const { db, call, say, quote, age } = await setup();
  try {
    const id = await say('alice', 'quotable');
    await assert.rejects(quote('bob', id, 'neon'), /classic, color or light/);
    await assert.rejects(quote('bob', '00000000-0000-4000-8000-000000000999'), /Message not found/);
    const news = await say('owner', 'staff only channel', 'news');
    await assert.rejects(quote('bob', news), /cannot send messages in this channel/);
    const q = await quote('bob', id);
    await assert.rejects(quote('carol', q.id), /cannot quote a quote/);
    await assert.rejects(quote('bob', id), /few seconds/);
    await age();
    await assert.rejects(quote('bob', id), /just quoted that message/);
    await db.exec(`update public.profiles set timeout_until = now() + interval '1 hour' where username='carol'`);
    await assert.rejects(quote('carol', id), /timed out/);
    await db.exec(`update public.profiles set timeout_until = null where username='carol'`);
    await db.exec(`insert into public.app_settings(key,value) values('messages_enabled','false')`);
    await assert.rejects(quote('carol', id), /paused/);
    await db.exec(`delete from public.app_settings where key='messages_enabled'`);
    for (let i = 0; i < 10; i++) { await quote('carol', await say('alice', 'line ' + i)); await age(); }
    await assert.rejects(quote('carol', await say('alice', 'one too many')), /lot of quotes/);
    await call('alice', `update public.messages set deleted=true where id=$1`, [id]);
    await assert.rejects(quote('mod', id), /Message not found/);
  } finally { await db.close(); }
});

test('the requester, the quoted member and staff can delete a quote; others cannot', async () => {
  const { db, call, say, quote, age } = await setup();
  try {
    const make = async () => { const q = await quote('bob', await say('alice', 'x' + Math.random())); await age(); return q.id; };
    const a = await make(), b = await make(), c = await make();
    await assert.rejects(call('carol', 'select public.chat_delete_quote($1)', [a]), /cannot delete this quote/);
    await assert.rejects(call('carol', `update public.messages set deleted=true where id=$1`, [a]), /cannot|only reactions/i);
    for (const [who, id] of [['bob', a], ['alice', b], ['mod', c]]) {
      assert.deepEqual(await call(who, 'select public.chat_delete_quote($1) ok', [id]), [{ ok: true }]);
      const row = (await db.query('select deleted, deleted_by from public.messages where id=$1', [id])).rows[0];
      assert.equal(row.deleted, true); assert.equal(row.deleted_by, who);
    }
    const plain = await say('alice', 'not a quote');
    await assert.rejects(call('alice', 'select public.chat_delete_quote($1)', [plain]), /Quote not found/);
  } finally { await db.close(); }
});
