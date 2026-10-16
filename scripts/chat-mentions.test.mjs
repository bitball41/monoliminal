import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('mention inbox uses the indexed lookup and the same visibility rules', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const ids = {
    alice: '00000000-0000-4000-8000-000000000011',
    bob: '00000000-0000-4000-8000-000000000012',
    cara: '00000000-0000-4000-8000-000000000013',
  };
  const actor = async name => {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub','${ids[name]}',false); set role authenticated;`);
  };
  try {
    await db.exec(await file('Backend/tests/authorization-fixture.sql'));
    for (const name of (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(await file('Backend/migrations/' + name));
    }
    for (const [name, id] of Object.entries(ids)) {
      await db.query('insert into auth.users(id) values($1)', [id]);
      await db.query('insert into public.profiles(username,user_id,display_name) values($1,$2,$1)', [name, id]);
    }
    await db.query("insert into public.channels(id,label,kind) values('general','General','chat'),('following','Following','forum')");
    await actor('bob');
    await db.query("insert into public.messages(channel_id,sender,content) values('general','bob','hey @alice')");
    await db.query("insert into public.messages(channel_id,sender,content) values('general','bob','email alice@example.com')");
    await db.query("insert into public.messages(channel_id,sender,content,deleted) values('general','bob','deleted @alice',true)");
    await actor('alice');
    await db.query("insert into public.messages(channel_id,sender,content) values('general','alice','@bob hello')");
    await actor('cara');
    const thread = (await db.query("insert into public.forum_threads(channel_id,title,author,body) values('following','Secret','cara','hidden') returning id")).rows[0].id;
    await db.query('insert into public.messages(channel_id,sender,content) values($1,$2,$3)', [`forum:${thread}`, 'cara', 'psst @alice']);

    await actor('bob');
    await db.query("insert into public.messages(channel_id,sender,content,created_at) select 'general','bob','hello @alice2 and @alice_extra',now()+interval '1 second' from generate_series(1,60)");
    await actor('alice');
    const aliceRows = (await db.query('select sender, content from public.chat_list_mentions(50) order by content')).rows;
    assert.deepEqual(aliceRows.map(row => row.content), ['hey @alice']);

    await actor('bob');
    const bobRows = (await db.query('select sender, content from public.chat_list_mentions(50)')).rows;
    assert.deepEqual(bobRows.map(row => row.content), ['@bob hello']);

    await actor('cara');
    assert.equal((await db.query('select count(*)::int n from public.chat_list_mentions(50)')).rows[0].n, 0);
  } finally {
    await db.close();
  }
});
