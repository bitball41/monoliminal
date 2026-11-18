// Phoenix (Kirk only): equal to the Super Mega Tuff Co-owner, checked against
// every migration in an isolated database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const SMT = 'super_mega_tuff_co_owner';
const PHX = 'phoenix';

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  const people = { owner: 'owner', connor: 'owner', PomKnee: 'co_owner', kirk: 'co_owner', coowner: 'co_owner', manager: 'manager', alice: 'member', bob: 'member' };
  const ids = Object.fromEntries(Object.keys(people).map((name, i) => [name, `00000000-0000-4000-8000-0000000005${String(i + 10)}`]));
  await db.exec(await file('Backend/tests/authorization-fixture.sql'));
  for (const name of (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
    await db.exec(await file('Backend/migrations/' + name));
  }
  await db.exec(`insert into public.channels(id,label,kind,min_speak_role) values ('general','general','chat','member')`);
  await db.exec(await file('Backend/tests/authorization-triggers.sql'));
  for (const [name, role] of Object.entries(people)) {
    await db.query('insert into auth.users(id) values($1)', [ids[name]]);
    await db.query('insert into public.profiles(username,display_name,user_id,staff_role) values($1,$1,$2,$3)', [name, ids[name], role]);
  }
  // The migrations hand out the roles; here the profiles are created later.
  await db.query(`update public.profiles set staff_role=$1 where username='PomKnee'`, [SMT]);
  await db.query(`update public.profiles set staff_role=$1 where username='kirk'`, [PHX]);
  const as = name => db.exec(`reset role; select set_config('request.jwt.claim.sub','${ids[name] || ''}',false); set role authenticated;`);
  const call = async (name, sql, params = []) => { await as(name); try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); } };
  const profile = async name => (await db.query('select * from public.profiles where username=$1', [name])).rows[0];
  const power = async slug => (await db.query(`select private.chat_staff_power($1) p`, [slug])).rows[0].p;
  return { db, call, profile, power };
}

test('Phoenix is tied with the Super Mega Tuff Co-owner at the top, with co-owner powers', async () => {
  const { db, profile, power } = await setup();
  try {
    const r = (await db.query(`select * from public.chat_staff_roles where slug=$1`, [PHX])).rows[0];
    assert.equal(r.tier, 5); assert.equal(r.builtin, true); assert.equal(r.label, 'Phoenix'); assert.equal(r.badge, 'phoenix');
    assert.equal(await power(PHX), await power(SMT));
    assert(await power(PHX) > await power('co_owner'));
    assert(await power(PHX) < await power('owner'));
    const admins = (await db.query(`select count(distinct power)::int n from public.chat_staff_roles where slug in ('admin','dusty','super_mega_tuff_admin')`)).rows[0].n;
    assert.equal(admins, 1, 'the three admin roles stay tied');
    const kirk = await profile('kirk');
    assert.equal(kirk.is_admin, true); assert.equal(kirk.is_owner, false);
  } finally { await db.close(); }
});

test('both stay tied on top after reordering and new roles', async () => {
  const { db, call, power } = await setup();
  try {
    await call('owner', `select public.chat_save_staff_role(null,'God Tier',null,5)`);
    const god = (await db.query(`select slug from public.chat_staff_roles where label='God Tier'`)).rows[0].slug;
    const rest = (await db.query(`select array_agg(slug order by power desc, slug) o from public.chat_staff_roles where slug not in ('member','owner','preston') and slug <> $1`, [god])).rows[0].o;
    await call('owner', `select public.chat_reorder_staff_roles($1)`, [[god, ...rest]]);
    assert.equal(await power(PHX), await power(SMT));
    assert(await power(PHX) > await power(god));
    assert(await power(god) > await power('co_owner'));
    // Moving one of them down is undone.
    await call('owner', `select public.chat_reorder_staff_roles($1)`, [[god, SMT, ...rest.filter(s => s !== SMT && s !== PHX), PHX]]);
    assert.equal(await power(PHX), await power(SMT));
    assert(await power(PHX) > await power(god));
  } finally { await db.close(); }
});

test('only Kirk can hold it, and only the owner can take it away', async () => {
  const { db, call, profile } = await setup();
  try {
    await assert.rejects(db.query(`update public.profiles set staff_role=$1 where username='alice'`, [PHX]), /Kirk only/);
    await assert.rejects(db.query(`update public.profiles set staff_role=$1 where username='kirk'`, [SMT]), /PomKnee only/);
    await assert.rejects(call('owner', `select public.chat_set_staff_role('owner','', 'alice', $1)`, [PHX]), /Kirk only/);
    await assert.rejects(call('coowner', `select public.chat_set_staff_role('coowner','', 'kirk', 'member')`), /below your rank|Only the owner/);
    await assert.rejects(call('PomKnee', `select public.chat_set_staff_role('PomKnee','', 'kirk', 'member')`), /below your rank|Only the owner/);
    await assert.rejects(call('kirk', `select public.chat_set_staff_role('kirk','', 'PomKnee', 'member')`), /below your rank|Only the owner/);
    await assert.rejects(call('owner', `select public.chat_delete_staff_role($1)`, [PHX]));
    await call('owner', `select public.chat_set_staff_role('owner','', 'kirk', 'co_owner')`);
    assert.equal((await profile('kirk')).staff_role, 'co_owner');
    await call('owner', `select public.chat_set_staff_role('owner','', 'kirk', $1)`, [PHX]);
    assert.equal((await profile('kirk')).staff_role, PHX);
  } finally { await db.close(); }
});

test('only Conno can ban, time out or kick Kirk; PomKnee and Kirk cannot moderate each other', async () => {
  const { db, call, profile } = await setup();
  try {
    for (const who of ['owner', 'coowner', 'manager', 'PomKnee']) for (const sql of [
      `select public.chat_ban_user($1,'', 'kirk','x')`,
      `select public.chat_staff_timeout_user($1,'', 'kirk', 10)`,
      `select public.chat_staff_kick_user($1,'', 'kirk')`,
    ]) await assert.rejects(call(who, sql, [who]), /Only Conno|Insufficient staff permission|Admins cannot/);
    for (const sql of [
      `select public.chat_ban_user('kirk','', 'PomKnee','x')`,
      `select public.chat_staff_timeout_user('kirk','', 'PomKnee', 10)`,
    ]) await assert.rejects(call('kirk', sql), /Only Conno/);
    await assert.rejects(db.query(`update public.profiles set is_banned=true where username='kirk'`), /Only Conno can ban the Phoenix/);
    await assert.rejects(db.query(`update public.profiles set timeout_until=now()+interval '1 hour' where username='kirk'`), /Only Conno can time out the Phoenix/);

    // Part 2: Kirk lifts even Conno's timeout himself (PomKnee still can't).
    await call('connor', `select public.chat_staff_timeout_user('connor','', 'kirk', 10)`);
    assert.equal((await profile('kirk')).timeout_by, 'connor');
    await call('kirk', `select public.chat_staff_timeout_user('kirk','', 'kirk', 0)`);
    assert.equal((await profile('kirk')).timeout_until, null);
    await call('connor', `select public.chat_staff_timeout_user('connor','', 'PomKnee', 10)`);
    await assert.rejects(call('PomKnee', `select public.chat_staff_timeout_user('PomKnee','', 'PomKnee', 0)`), /Only Conno can lift/);
    // Clearing his own timeout still doesn't let him time himself out or anyone above.
    await assert.rejects(call('kirk', `select public.chat_staff_timeout_user('kirk','', 'kirk', 10)`), /Only Conno/);
    await call('connor', `select public.chat_ban_user('connor','', 'kirk','too hot')`);
    assert.equal((await profile('kirk')).is_banned, true);
    await assert.rejects(call('kirk', `select public.chat_troll_apply('alice', array['popups'], 5)`), /Only the Super Mega Tuff Co-owner, Phoenix or Conno/);
    await call('connor', `select public.chat_unban_user('connor','', 'kirk')`);
    assert.equal((await profile('kirk')).is_banned, false);
  } finally { await db.close(); }
});

test('Kirk clears timeouts, publishes announcements and has lighter QuoteBot limits', async () => {
  const { db, call, profile } = await setup();
  try {
    await db.query(`update public.profiles set timeout_until=now()+interval '1 hour', timeout_by='owner' where username in ('alice','coowner')`);
    await call('kirk', `select public.chat_staff_timeout_user('kirk','', 'coowner', 0)`);
    await call('kirk', `select public.chat_staff_timeout_user('kirk','', 'alice', 0)`);
    assert.equal((await profile('coowner')).timeout_until, null);
    assert.equal((await profile('alice')).timeout_until, null);

    await call('kirk', `select public.chat_owner_set_app_setting('announcement','Phoenix rises')`);
    assert.equal((await db.query(`select value from public.app_settings where key='announcement'`)).rows[0].value, 'Phoenix rises');
    await assert.rejects(call('kirk', `select public.chat_owner_set_app_setting('app_enabled','false')`), /Owner access/);

    const a = (await call('alice', `insert into public.messages(channel_id,sender,content,type) values('general','alice','one','text') returning id`))[0].id;
    const b = (await call('alice', `insert into public.messages(channel_id,sender,content,type) values('general','alice','two','text') returning id`))[0].id;
    await call('kirk', `select public.chat_post_quote($1,'classic')`, [a]);
    await assert.rejects(call('kirk', `select public.chat_post_quote($1,'classic')`, [b]), /few seconds/);
    await db.query(`update private.chat_quote_requests set created_at = created_at - interval '1.5 seconds'`);
    await call('kirk', `select public.chat_post_quote($1,'classic')`, [b]); // members wait 5 seconds
  } finally { await db.close(); }
});

test('Kirk has every troll and sees and stops them; nobody can troll Kirk', async () => {
  const { db, call } = await setup();
  try {
    const all = ['fail_send', 'popups', 'upside_down', 'mirror', 'shake', 'emoji_rain', 'reverse_mouse', 'backwards_typing', 'auto_refresh', 'runaway_buttons', 'random_keys'];
    assert.equal((await call('kirk', `select public.chat_troll_apply('alice', $1, 5) r`, [all]))[0].r.length, 11);
    await call('kirk', `select public.chat_troll_refresh('alice')`);
    assert.deepEqual((await db.query(`select topic from realtime.messages where event='troll_refresh'`)).rows, [{ topic: 'chat:user:alice' }]);
    await call('kirk', `select public.chat_troll_apply('PomKnee', array['shake'], 5)`);
    // Troll protection (part 2): not PomKnee, not Conno, not the refresh either.
    for (const who of ['PomKnee', 'connor']) {
      await assert.rejects(call(who, `select public.chat_troll_apply('kirk', array['popups'], 5)`), /troll protection/);
      await assert.rejects(call(who, `select public.chat_troll_refresh('Kirk')`), /troll protection/);
    }
    assert.deepEqual((await call('kirk', `select public.chat_my_troll_effects() r`))[0].r, []);
    assert.equal((await call('kirk', `select public.chat_troll_list() r`))[0].r.length, 2);
    await call('kirk', `select public.chat_troll_clear('alice')`);
    assert.deepEqual((await call('alice', `select public.chat_my_troll_effects() r`))[0].r, []);
    await assert.rejects(call('kirk', `select public.chat_troll_apply('connor', array['shake'], 5)`), /owner and PRESTON/);
    await assert.rejects(call('kirk', `select public.chat_troll_apply('kirk', array['shake'], 5)`), /yourself/);
    await assert.rejects(call('coowner', `select public.chat_troll_apply('bob', array['shake'], 5)`), /Only the Super Mega Tuff Co-owner, Phoenix or Conno/);
  } finally { await db.close(); }
});

test('each holder styles only their own check mark', async () => {
  const { db, call } = await setup();
  try {
    await call('PomKnee', `select public.chat_set_smt_check('😈', array['#7c3aed'], 'spin')`);
    await call('kirk', `select public.chat_set_smt_check('🔥', array['#FDE047','#f97316','#dc2626'], 'pulse')`);
    const get = async key => (await db.query(`select value from public.app_settings where key=$1`, [key])).rows[0]?.value;
    assert.deepEqual(JSON.parse(await get('smt_check')), { symbol: '😈', colors: ['#7c3aed'], animation: 'spin' });
    assert.deepEqual(JSON.parse(await get('phoenix_check')), { symbol: '🔥', colors: ['#fde047', '#f97316', '#dc2626'], animation: 'pulse' });
    await call('kirk', `select public.chat_set_smt_check(null, null, null)`);
    assert.equal(await get('phoenix_check'), '');
    assert.notEqual(await get('smt_check'), '', 'Kirk never touches PomKnee’s check');
    await assert.rejects(call('owner', `select public.chat_set_smt_check('x', array['#ff0000'], 'spin')`), /Only the Super Mega Tuff Co-owner or Phoenix/);
    await assert.rejects(call('kirk', `select public.chat_set_smt_check('<b>', array['#ff0000'], 'spin')`), /8 characters/);
  } finally { await db.close(); }
});

test('part 2 clears trolls that were already on Kirk', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    const FIX = '20261118133619_chat_phoenix_protection.sql';
    await db.exec(await file('Backend/tests/authorization-fixture.sql'));
    const names = (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort();
    for (const name of names.filter(n => n < FIX)) await db.exec(await file('Backend/migrations/' + name));
    await db.exec(await file('Backend/tests/authorization-triggers.sql'));
    await db.exec(`insert into public.profiles(username,display_name,staff_role) values('kirk','kirk','phoenix'),('alice','alice','member');
      insert into private.chat_troll_effects(target,effect,expires_at,created_by) values
        ('kirk','popups',now()+interval '5 minutes','PomKnee'),('alice','shake',now()+interval '5 minutes','kirk');`);
    await db.exec(await file('Backend/migrations/' + FIX));
    assert.deepEqual((await db.query(`select target from private.chat_troll_effects`)).rows, [{ target: 'alice' }]);
    const sent = (await db.query(`select topic, payload from realtime.messages where event='troll_effects'`)).rows;
    assert.deepEqual(sent, [{ topic: 'chat:user:kirk', payload: { effects: [] } }]);
  } finally { await db.close(); }
});
