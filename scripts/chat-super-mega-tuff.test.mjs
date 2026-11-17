// Super Mega Tuff Co-owner (PomKnee only), checked against every migration in
// an isolated database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const SMT = 'super_mega_tuff_co_owner';

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  const people = { owner: 'owner', connor: 'owner', PomKnee: 'co_owner', coowner: 'co_owner', manager: 'manager', mod: 'mod', alice: 'member', bob: 'member' };
  const ids = Object.fromEntries(Object.keys(people).map((name, i) => [name, `00000000-0000-4000-8000-0000000004${String(i + 10)}`]));
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
  // The migration gives PomKnee the role; here the profile is created later.
  await db.query(`update public.profiles set staff_role=$1 where username='PomKnee'`, [SMT]);
  const as = name => db.exec(`reset role; select set_config('request.jwt.claim.sub','${ids[name] || ''}',false); set role authenticated;`);
  const call = async (name, sql, params = []) => { await as(name); try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); } };
  const profile = async name => (await db.query('select * from public.profiles where username=$1', [name])).rows[0];
  return { db, call, profile };
}

test('the role tops the staff ladder with co-owner powers and is permanent', async () => {
  const { db, profile } = await setup();
  try {
    const r = (await db.query(`select * from public.chat_staff_roles where slug=$1`, [SMT])).rows[0];
    assert.equal(r.tier, 5); assert.equal(r.builtin, true); assert.equal(r.label, 'Super Mega Tuff Co-owner');
    const p = (await db.query(`select private.chat_staff_power($1) s, private.chat_staff_power('co_owner') c`, [SMT])).rows[0];
    assert(p.s > p.c, 'above co-owner');
    assert.equal(p.s, (await db.query(`select max(power) m from public.chat_staff_roles where slug not in ('owner','preston')`)).rows[0].m);
    const admins = (await db.query(`select count(distinct power)::int n from public.chat_staff_roles where slug in ('admin','dusty','super_mega_tuff_admin')`)).rows[0].n;
    assert.equal(admins, 1, 'the three admin roles stay tied');
    const pom = await profile('PomKnee');
    assert.equal(pom.is_admin, true); assert.equal(pom.is_owner, false);
  } finally { await db.close(); }
});

test('only PomKnee can hold it, and only the owner can take it away', async () => {
  const { db, call, profile } = await setup();
  try {
    await assert.rejects(db.query(`update public.profiles set staff_role=$1 where username='alice'`, [SMT]), /PomKnee only/);
    await assert.rejects(call('owner', `select public.chat_set_staff_role('owner','', 'alice', $1)`, [SMT]), /PomKnee only/);
    await assert.rejects(call('coowner', `select public.chat_set_staff_role('coowner','', 'PomKnee', 'member')`), /below your rank|Only the owner/);
    // A custom role cannot be placed above it, so its holders cannot strip it either.
    await call('owner', `select public.chat_save_staff_role(null,'God Tier',null,5)`);
    const god = (await db.query(`select slug from public.chat_staff_roles where label='God Tier'`)).rows[0].slug;
    const order = (await db.query(`select array_agg(slug order by power desc, slug) o from public.chat_staff_roles where slug not in ('member','owner','preston') and slug <> $1`, [god])).rows[0].o;
    await call('owner', `select public.chat_reorder_staff_roles($1)`, [[god, ...order]]);
    await db.query(`update public.profiles set staff_role=$1 where username='coowner'`, [god]);
    await assert.rejects(call('coowner', `select public.chat_set_staff_role('coowner','', 'PomKnee', 'member')`), /below your rank/);
    await assert.rejects(call('owner', `select public.chat_delete_staff_role($1)`, [SMT]));
    // The owner can.
    await call('owner', `select public.chat_set_staff_role('owner','', 'PomKnee', 'co_owner')`);
    assert.equal((await profile('PomKnee')).staff_role, 'co_owner');
  } finally { await db.close(); }
});

test('only Conno can ban, time out or kick it; anyone else (another owner too) is refused', async () => {
  const { db, call, profile } = await setup();
  try {
    for (const who of ['owner', 'coowner', 'manager']) for (const sql of [
      `select public.chat_ban_user($1,'', 'PomKnee','x')`,
      `select public.chat_staff_timeout_user($1,'', 'PomKnee', 10)`,
      `select public.chat_staff_kick_user($1,'', 'PomKnee')`,
    ]) await assert.rejects(call(who, sql, [who]), /Only Conno|Insufficient staff permission|Admins cannot/);
    await assert.rejects(db.query(`update public.profiles set is_banned=true where username='PomKnee'`), /Only Conno can ban/);
    await assert.rejects(db.query(`update public.profiles set timeout_until=now()+interval '1 hour' where username='PomKnee'`), /Only Conno can time out/);
    let pom = await profile('PomKnee');
    assert.equal(pom.is_banned, false); assert.equal(pom.timeout_until, null);

    // Conno's timeout sticks: PomKnee cannot lift it, Conno can.
    await call('connor', `select public.chat_staff_timeout_user('connor','', 'PomKnee', 10)`);
    assert.equal((await profile('PomKnee')).timeout_by, 'connor');
    await assert.rejects(call('PomKnee', `select public.chat_staff_timeout_user('PomKnee','', 'PomKnee', 0)`), /Only Conno can lift/);
    await assert.rejects(call('PomKnee', `insert into public.messages(channel_id,sender,content,type) values('general','PomKnee','hi','text')`), /timed out/);
    await call('connor', `select public.chat_staff_timeout_user('connor','', 'PomKnee', 0)`);
    assert.equal((await profile('PomKnee')).timeout_until, null);

    await call('connor', `select public.chat_staff_kick_user('connor','', 'PomKnee')`);
    assert((await profile('PomKnee')).kicked_at);
    await call('connor', `select public.chat_ban_user('connor','', 'PomKnee','too tuff')`);
    pom = await profile('PomKnee');
    assert.equal(pom.is_banned, true); assert.equal(pom.banned_by, 'connor');
    // A banned holder loses the powers until unbanned.
    await assert.rejects(call('PomKnee', `select public.chat_troll_apply('alice', array['popups'], 5)`), /Only the Super Mega Tuff/);
    await call('connor', `select public.chat_unban_user('connor','', 'PomKnee')`);
    assert.equal((await profile('PomKnee')).is_banned, false);
    // The permission does not leak to later statements outside Conno's call.
    await assert.rejects(db.query(`update public.profiles set is_banned=true where username='PomKnee'`), /Only Conno can ban/);
  } finally { await db.close(); }
});

test('it clears anyone’s timeout, but times out only below its rank', async () => {
  const { db, call, profile } = await setup();
  try {
    await db.query(`update public.profiles set timeout_until=now()+interval '1 hour', timeout_by='owner' where username in ('alice','coowner')`);
    await assert.rejects(call('manager', `select public.chat_staff_timeout_user('manager','', 'coowner', 0)`), /below your rank/);
    await call('PomKnee', `select public.chat_staff_timeout_user('PomKnee','', 'coowner', 0)`);
    await call('PomKnee', `select public.chat_staff_timeout_user('PomKnee','', 'alice', 0)`);
    assert.equal((await profile('coowner')).timeout_until, null);
    assert.equal((await profile('alice')).timeout_until, null);
    await call('PomKnee', `select public.chat_staff_timeout_user('PomKnee','', 'bob', 30)`);
    assert((await profile('bob')).timeout_until);
    await assert.rejects(call('PomKnee', `select public.chat_staff_timeout_user('PomKnee','', 'owner', 30)`), /below your rank/);
  } finally { await db.close(); }
});

test('it publishes announcements but no other owner settings', async () => {
  const { db, call } = await setup();
  try {
    await call('PomKnee', `select public.chat_owner_set_app_setting('announcement','PomKnee was here')`);
    await call('PomKnee', `select public.chat_owner_set_app_setting('whats_new','tuff update')`);
    const v = (await db.query(`select key, value from public.app_settings where key in ('announcement','whats_new') order by key`)).rows;
    assert.deepEqual(v, [{ key: 'announcement', value: 'PomKnee was here' }, { key: 'whats_new', value: 'tuff update' }]);
    await assert.rejects(call('PomKnee', `select public.chat_owner_set_app_setting('app_enabled','false')`), /Owner access/);
    await assert.rejects(call('coowner', `select public.chat_owner_set_app_setting('announcement','nope')`), /Owner access/);
  } finally { await db.close(); }
});

test('it spams with lighter limits, QuoteBot included; everyone else keeps the normal ones', async () => {
  const { db, call } = await setup();
  try {
    const srcs = [];
    for (let i = 0; i < 31; i++) srcs.push((await call('alice', `insert into public.messages(channel_id,sender,content,type) values('general','alice',$1,'text') returning id`, ['quote me ' + i]))[0].id);
    await db.query(`insert into public.app_settings(key,value) values('slow_mode_seconds','30') on conflict (key) do update set value=excluded.value`);
    for (let i = 0; i < 8; i++) {
      await call('PomKnee', `insert into public.messages(channel_id,sender,content,type) values('general','PomKnee',$1,'text')`, ['spam ' + i]);
    }
    const age = secs => db.query(`update private.chat_quote_requests set created_at = created_at - make_interval(secs => $1)`, [secs]);
    const quote = id => call('PomKnee', `select public.chat_post_quote($1,'classic')`, [id]);
    // 1 second between quotes (members: 5).
    await quote(srcs[0]);
    await assert.rejects(quote(srcs[1]), /few seconds/);
    await age(1.5);
    // The same message once a minute (members: 10 minutes).
    await assert.rejects(quote(srcs[0]), /just quoted/);
    await age(60);
    await quote(srcs[0]);
    // 30 per 10 minutes (members: 10).
    for (let i = 1; i < 28; i++) { await age(1.5); await quote(srcs[i]); }
    await age(1.5);
    await quote(srcs[28]);
    await age(1.5);
    await assert.rejects(quote(srcs[29]), /a lot of quotes/);
    assert.equal((await db.query(`select count(*)::int n from public.messages where sender='QuoteBot'`)).rows[0].n, 30);
    const src = srcs[0];
    await call('bob', `select public.chat_post_quote($1,'classic')`, [src]);
    await assert.rejects(call('bob', `select public.chat_post_quote($1,'classic')`, [src]), /few seconds/);
    await assert.rejects(call('alice', `insert into public.messages(channel_id,sender,content,type) values('general','alice','again','text')`), /Slow mode/);
  } finally { await db.close(); }
});

test('troll menu: PomKnee only, never the owner, broadcast to the target, owner can stop it', async () => {
  const { db, call } = await setup();
  try {
    const fx = await call('PomKnee', `select public.chat_troll_apply('alice', array['fail_send','popups','fail_send'], 5) r`);
    assert.deepEqual(fx[0].r.map(e => e.effect), ['fail_send', 'popups']);
    const sent = (await db.query(`select topic, event, payload from realtime.messages where event='troll_effects'`)).rows;
    assert.equal(sent.length, 1); assert.equal(sent[0].topic, 'chat:user:alice');
    assert.equal(sent[0].payload.effects.length, 2);
    assert.deepEqual((await call('alice', `select public.chat_my_troll_effects() r`))[0].r.map(e => e.effect), ['fail_send', 'popups']);
    assert.deepEqual((await call('bob', `select public.chat_my_troll_effects() r`))[0].r, []);

    await assert.rejects(call('coowner', `select public.chat_troll_apply('alice', array['popups'], 5)`), /Only the Super Mega Tuff/);
    await assert.rejects(call('alice', `select public.chat_troll_list()`), /Only the Super Mega Tuff/);
    await assert.rejects(call('PomKnee', `select public.chat_troll_apply('owner', array['popups'], 5)`), /owner and PRESTON/);
    await assert.rejects(call('PomKnee', `select public.chat_troll_apply('PomKnee', array['popups'], 5)`), /yourself/);
    await assert.rejects(call('PomKnee', `select public.chat_troll_apply('bob', array['delete_account'], 5)`), /Unknown troll/);
    await assert.rejects(call('PomKnee', `select public.chat_troll_apply('bob', array['popups'], 600)`), /1 and 60 minutes/);
    await assert.rejects(call('alice', `select * from private.chat_troll_effects`));

    const list = (await call('owner', `select public.chat_troll_list() r`))[0].r;
    assert.equal(list[0].target, 'alice');
    await call('owner', `select public.chat_troll_clear('alice')`);
    assert.deepEqual((await call('alice', `select public.chat_my_troll_effects() r`))[0].r, []);
    await db.query(`update private.chat_troll_effects set expires_at = now() - interval '1 second'`);
  } finally { await db.close(); }
});

test('part 2: pinned above every custom role, even after reordering or new roles', async () => {
  const { db, call } = await setup();
  try {
    await call('owner', `select public.chat_save_staff_role(null,'God Tier',null,5)`);
    const ladder = async () => (await db.query(`select slug from public.chat_staff_roles where slug not in ('member','owner','preston') order by power desc, slug`)).rows.map(r => r.slug);
    assert.equal((await ladder())[0], SMT);
    const god = (await db.query(`select slug from public.chat_staff_roles where label='God Tier'`)).rows[0].slug;
    await call('owner', `select public.chat_reorder_staff_roles($1)`, [[god, ...(await ladder()).filter(s => s !== god)]]);
    const after = await ladder();
    assert.deepEqual(after.slice(0, 2), [SMT, god]);
    const p = (await db.query(`select private.chat_staff_power($1) s, private.chat_staff_power($2) g`, [SMT, god])).rows[0];
    assert(p.s > p.g);
  } finally { await db.close(); }
});

test('part 2: PomKnee styles their own check mark; nobody else can', async () => {
  const { db, call } = await setup();
  try {
    await call('PomKnee', `select public.chat_set_smt_check('🔥', array['#FF0000','#00ff00'], 'pulse')`);
    const v = JSON.parse((await db.query(`select value from public.app_settings where key='smt_check'`)).rows[0].value);
    assert.deepEqual(v, { symbol: '🔥', colors: ['#ff0000', '#00ff00'], animation: 'pulse' });
    assert.equal((await call('alice', `select value from public.app_settings where key='smt_check'`)).length, 1, 'everyone can read it');
    await assert.rejects(call('PomKnee', `select public.chat_set_smt_check('<b>', array['#ff0000'], 'spin')`), /8 characters/);
    await assert.rejects(call('PomKnee', `select public.chat_set_smt_check('x', array['red'], 'spin')`), /colours/);
    await assert.rejects(call('PomKnee', `select public.chat_set_smt_check('x', array['#ff0000'], 'explode')`), /spin, pulse/);
    await assert.rejects(call('owner', `select public.chat_set_smt_check('x', array['#ff0000'], 'spin')`), /Only the Super Mega Tuff/);
    await call('PomKnee', `select public.chat_set_smt_check(null, null, null)`);
    assert.equal((await db.query(`select value from public.app_settings where key='smt_check'`)).rows[0].value, '');
  } finally { await db.close(); }
});

test('part 2: PomKnee can clear their own timeout', async () => {
  const { db, call, profile } = await setup();
  try {
    await db.exec(`alter table public.profiles disable trigger zz_chat_super_mega_tuff_guard;
      update public.profiles set timeout_until = now() + interval '1 hour', timeout_by='owner' where username='PomKnee';
      alter table public.profiles enable trigger zz_chat_super_mega_tuff_guard;`);
    await call('PomKnee', `select public.chat_staff_timeout_user('PomKnee','', 'PomKnee', 0)`);
    assert.equal((await profile('PomKnee')).timeout_until, null);
  } finally { await db.close(); }
});

test('part 2: new trolls replace the old ones, and the one-shot refresh', async () => {
  const { db, call } = await setup();
  try {
    const fx = await call('PomKnee', `select public.chat_troll_apply('alice', array['reverse_mouse','backwards_typing','auto_refresh','runaway_buttons'], 5) r`);
    assert.equal(fx[0].r.length, 4);
    for (const old of ['rainbow', 'comic_sans', 'blur', 'no_cursor']) {
      await assert.rejects(call('PomKnee', `select public.chat_troll_apply('alice', array[$1], 5)`, [old]), /Unknown troll/);
    }
    await call('PomKnee', `select public.chat_troll_refresh('alice')`);
    const sent = (await db.query(`select topic from realtime.messages where event='troll_refresh'`)).rows;
    assert.deepEqual(sent, [{ topic: 'chat:user:alice' }]);
    await assert.rejects(call('PomKnee', `select public.chat_troll_refresh('owner')`), /owner and PRESTON/);
    await assert.rejects(call('coowner', `select public.chat_troll_refresh('alice')`), /Only the Super Mega Tuff/);
  } finally { await db.close(); }
});
