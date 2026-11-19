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
  const people = { owner: 'owner', connor: 'owner', kirk: 'co_owner', PomKnee: 'co_owner', coowner: 'co_owner', manager: 'manager', mod: 'mod', alice: 'member', bob: 'member' };
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
    await assert.rejects(call('PomKnee', `select public.chat_troll_apply('alice', array['popups'], 5)`), /troll menu is not available/);
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

test('troll menu: broadcast to the target, never the owner, Conno can stop it', async () => {
  const { db, call } = await setup();
  try {
    const fx = await call('PomKnee', `select public.chat_troll_apply('alice', array['fail_send','popups','fail_send'], 5) r`);
    assert.deepEqual(fx[0].r.map(e => e.effect), ['fail_send', 'popups']);
    const sent = (await db.query(`select topic, event, payload from realtime.messages where event='troll_effects'`)).rows;
    assert.equal(sent.length, 1); assert.equal(sent[0].topic, 'chat:user:alice');
    assert.equal(sent[0].payload.effects.length, 2);
    assert.deepEqual((await call('alice', `select public.chat_my_troll_effects() r`))[0].r.map(e => e.effect), ['fail_send', 'popups']);
    assert.deepEqual((await call('bob', `select public.chat_my_troll_effects() r`))[0].r, []);

    await assert.rejects(call('coowner', `select public.chat_troll_apply('alice', array['popups'], 5)`), /troll menu is not available/);
    await assert.rejects(call('alice', `select public.chat_troll_list()`), /troll menu is not available/);
    await assert.rejects(call('PomKnee', `select public.chat_troll_apply('owner', array['popups'], 5)`), /owner and PRESTON/);
    await assert.rejects(call('PomKnee', `select public.chat_troll_apply('PomKnee', array['popups'], 5)`), /yourself/);
    await assert.rejects(call('PomKnee', `select public.chat_troll_apply('bob', array['delete_account'], 5)`), /Unknown troll/);
    await assert.rejects(call('PomKnee', `select public.chat_troll_apply('bob', array['popups'], 600)`), /1 and 60 minutes/);
    await assert.rejects(call('alice', `select * from private.chat_troll_effects`));

    const list = (await call('connor', `select public.chat_troll_list() r`))[0].r;
    assert.equal(list[0].target, 'alice');
    await assert.rejects(call('owner', `select public.chat_troll_clear('alice')`), /troll menu is not available/);
    await call('connor', `select public.chat_troll_clear('alice')`);
    assert.deepEqual((await call('alice', `select public.chat_my_troll_effects() r`))[0].r, []);
    await db.query(`update private.chat_troll_effects set expires_at = now() - interval '1 second'`);
  } finally { await db.close(); }
});

test('part 2: pinned above every custom role, even after reordering or new roles', async () => {
  const { db, call } = await setup();
  try {
    await call('owner', `select public.chat_save_staff_role(null,'God Tier',null,5)`);
    const ladder = async () => (await db.query(`select slug from public.chat_staff_roles where slug not in ('member','owner','preston') order by power desc, slug`)).rows.map(r => r.slug);
    // Phoenix (20261118032602) shares the top spot (20261118142807).
    assert.deepEqual((await ladder()).slice(0, 2).sort(), ['phoenix', SMT]);
    const god = (await db.query(`select slug from public.chat_staff_roles where label='God Tier'`)).rows[0].slug;
    await call('owner', `select public.chat_reorder_staff_roles($1)`, [[god, ...(await ladder()).filter(s => s !== god)]]);
    const after = await ladder();
    assert.deepEqual(after.slice(0, 3), ['phoenix', SMT, god]);
    const p = (await db.query(`select private.chat_staff_power($1) s, private.chat_staff_power($2) g`, [SMT, god])).rows[0];
    assert(p.s > p.g);
  } finally { await db.close(); }
});

test('part 2: PomKnee styles their own check mark; nobody else can', async () => {
  const { db, call } = await setup();
  try {
    await call('PomKnee', `select public.chat_set_smt_check('🔥', array['#FF0000','#00ff00'], 'pulse')`);
    const v = JSON.parse((await db.query(`select value from public.app_settings where key='smt_check'`)).rows[0].value);
    assert.deepEqual(v, { symbol: '🔥', colors: ['#ff0000', '#00ff00'], animation: 'pulse', shape: 'burst' });
    assert.equal((await call('alice', `select value from public.app_settings where key='smt_check'`)).length, 1, 'everyone can read it');
    await assert.rejects(call('PomKnee', `select public.chat_set_smt_check('<b>', array['#ff0000'], 'spin')`), /8 characters/);
    await assert.rejects(call('PomKnee', `select public.chat_set_smt_check('x', array['red'], 'spin')`), /colours/);
    await assert.rejects(call('PomKnee', `select public.chat_set_smt_check('x', array['#ff0000'], 'explode')`), /Unknown badge effect/);
    await assert.rejects(call('alice', `select public.chat_set_smt_check('x', array['#ff0000'], 'spin')`), /Only the Owner, the Super Mega Tuff Co-owner or Phoenix/);
    await call('PomKnee', `select public.chat_set_smt_check(null, null, null)`);
    assert.equal((await db.query(`select value from public.app_settings where key='smt_check'`)).rows[0].value, '');
  } finally { await db.close(); }
});

test('badge styles: the Owner styles its own badge; more effects and shapes; old calls keep the shape', async () => {
  const { db, call } = await setup();
  try {
    const get = async key => JSON.parse((await db.query(`select value from public.app_settings where key=$1`, [key])).rows[0]?.value || 'null');
    // The Owner role writes owner_check, never PomKnee's.
    await call('connor', `select public.chat_set_badge_style('👑', array['#EF4444','#b91c1c'], 'heartbeat', 'shield')`);
    assert.deepEqual(await get('owner_check'), { symbol: '👑', colors: ['#ef4444', '#b91c1c'], animation: 'heartbeat', shape: 'shield' });
    assert.equal(await get('smt_check'), null);
    // Every effect and shape is accepted; unknown ones are not.
    for (const a of ['none', 'spin', 'pulse', 'bounce', 'shake', 'wobble', 'flip', 'float', 'heartbeat', 'glow', 'rainbow', 'blink'])
      await call('PomKnee', `select public.chat_set_badge_style('😈', array['#7c3aed'], $1, 'star')`, [a]);
    for (const sh of ['burst', 'circle', 'square', 'star', 'heart', 'diamond', 'shield', 'hexagon', 'plain'])
      await call('PomKnee', `select public.chat_set_badge_style('😈', array['#7c3aed'], 'glow', $1)`, [sh]);
    await assert.rejects(call('PomKnee', `select public.chat_set_badge_style('x', array['#ff0000'], 'glow', 'blob')`), /Unknown badge shape/);
    await assert.rejects(call('PomKnee', `select public.chat_set_badge_style('x', array['#ff0000'], 'explode', 'star')`), /Unknown badge effect/);
    // The old three-argument call keeps the current shape.
    await call('PomKnee', `select public.chat_set_smt_check('🔥', array['#ff0000'], 'spin')`);
    assert.deepEqual(await get('smt_check'), { symbol: '🔥', colors: ['#ff0000'], animation: 'spin', shape: 'plain' });
    // Nobody else styles a badge; resetting clears only your own.
    for (const who of ['coowner', 'manager', 'alice'])
      await assert.rejects(call(who, `select public.chat_set_badge_style('x', array['#ff0000'], 'spin', 'star')`), /Only the Owner, the Super Mega Tuff Co-owner or Phoenix/);
    await call('connor', `select public.chat_set_badge_style(null, null, null, null)`);
    assert.equal((await db.query(`select value from public.app_settings where key='owner_check'`)).rows[0].value, '');
    assert.notEqual(await get('smt_check'), null);
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

test('part 3: random keys troll, and all eleven trolls in one call', async () => {
  const { db, call } = await setup();
  try {
    const all = ['fail_send', 'popups', 'upside_down', 'mirror', 'shake', 'emoji_rain', 'reverse_mouse', 'backwards_typing', 'auto_refresh', 'runaway_buttons', 'random_keys'];
    const fx = await call('PomKnee', `select public.chat_troll_apply('alice', $1, 5) r`, [all]);
    assert.equal(fx[0].r.length, 11);
    assert((await call('alice', `select public.chat_my_troll_effects() r`))[0].r.some(e => e.effect === 'random_keys'));
  } finally { await db.close(); }
});

test('Conno can troll too; PomKnee has troll protection from everyone, Conno included', async () => {
  const { db, call } = await setup();
  try {
    // Troll protection (20261118145536, restored for everyone in 20261119125007).
    await assert.rejects(call('kirk', `select public.chat_troll_apply('PomKnee', array['popups'], 5)`), /Super Mega Tuff Co-owner has troll protection/);
    const fx = await call('connor', `select public.chat_troll_apply('manager', array['random_keys','popups'], 5) r`);
    assert.deepEqual(fx[0].r.map(e => e.effect), ['popups', 'random_keys']);
    await call('connor', `select public.chat_troll_apply('alice', array['shake'], 5)`);
    await call('connor', `select public.chat_troll_refresh('alice')`);
    assert.deepEqual((await db.query(`select topic from realtime.messages where event='troll_refresh'`)).rows, [{ topic: 'chat:user:alice' }]);
    assert.equal((await call('connor', `select public.chat_troll_list() r`))[0].r.length, 2);
    // Conno doesn't get past it either, the refresh included.
    await assert.rejects(call('connor', `select public.chat_troll_apply('PomKnee', array['random_keys','popups'], 5)`), /Super Mega Tuff Co-owner has troll protection/);
    await assert.rejects(call('connor', `select public.chat_troll_refresh('PomKnee')`), /troll protection/);
    await assert.rejects(call('connor', `select public.chat_troll_apply('connor', array['shake'], 5)`), /yourself/);
    await assert.rejects(call('connor', `select public.chat_troll_apply('owner', array['shake'], 5)`), /owner and PRESTON/);
    await assert.rejects(call('PomKnee', `select public.chat_troll_apply('connor', array['shake'], 5)`), /owner and PRESTON/);
    for (const who of ['owner', 'coowner', 'manager', 'alice']) {
      await assert.rejects(call(who, `select public.chat_troll_apply('bob', array['shake'], 5)`), /troll menu is not available/);
      await assert.rejects(call(who, `select public.chat_troll_refresh('bob')`), /troll menu is not available/);
    }
    // A banned Conno loses it like anyone else.
    await db.query(`update public.profiles set is_banned=true where username='connor'`);
    await assert.rejects(call('connor', `select public.chat_troll_apply('alice', array['shake'], 5)`), /troll menu is not available/);
  } finally { await db.close(); }
});

test('troll menu is locked to the exact @PomKnee and @connor accounts, not roles', async () => {
  const { db, call } = await setup();
  try {
    // Any role, even the top ones, is not enough on its own.
    for (const who of ['owner', 'coowner', 'manager', 'alice']) {
      for (const sql of [`select public.chat_troll_apply('bob', array['shake'], 5)`, `select public.chat_troll_refresh('bob')`,
                         `select public.chat_troll_list()`, `select public.chat_troll_clear('bob')`])
        await assert.rejects(call(who, sql), /troll menu is not available/);
    }
    // PomKnee keeps it whatever their role; Conno whatever his.
    await call('connor', `select public.chat_set_staff_role('connor','', 'PomKnee', 'member')`);
    await call('PomKnee', `select public.chat_troll_apply('bob', array['shake'], 5)`);
    await db.query(`update public.profiles set staff_role='co_owner' where username='connor'`);
    await call('connor', `select public.chat_troll_apply('alice', array['popups'], 5)`);
    assert.equal((await call('connor', `select public.chat_troll_list() r`))[0].r.length, 2);
    // Look-alike accounts are refused, in any capitalisation.
    for (const name of ['pomknee', 'POMKNEE', 'Connor', 'CONNOR']) {
      await assert.rejects(db.query(`insert into public.profiles(username,display_name,staff_role) values($1,$1,'member')`, [name]), /reserved/);
    }
    await db.query(`insert into public.profiles(username,display_name,staff_role) values('pomknee2','x','member')`);
  } finally { await db.close(); }
});

test('limited menu: only the PRESTON account (by user id), Admin rank and below, no refresh trolls, 15 minutes, its own trolls only', async () => {
  const { db, call } = await setup();
  try {
    // The PRESTON account, matched by user id (20261118142342), not by role.
    const PRESTON_ID = '2cba69cd-1c4d-4100-8ddf-d08aa5e0b301';
    await db.query('insert into auth.users(id) values($1)', [PRESTON_ID]);
    await db.query(`insert into public.profiles(username,display_name,user_id,staff_role) values('pres','Pre$ton',$1,'preston')`, [PRESTON_ID]);
    const pres = sql => db.exec(`reset role; select set_config('request.jwt.claim.sub','${PRESTON_ID}',false); set role authenticated;`)
      .then(() => db.query(sql)).then(r => r.rows).finally(() => db.exec('reset role'));
    // Admin rank and below only.
    for (const t of ['alice', 'manager', 'mod']) await pres(`select public.chat_troll_apply('${t}', array['shake'], 15)`);
    await assert.rejects(pres(`select public.chat_troll_apply('coowner', array['shake'], 5)`), /can't troll that account/);
    for (const t of ['PomKnee', 'kirk']) {
      await assert.rejects(pres(`select public.chat_troll_apply('${t}', array['shake'], 5)`), /troll protection|can't troll that account/);
    }
    await assert.rejects(pres(`select public.chat_troll_apply('connor', array['shake'], 5)`), /owner and PRESTON/);
    // No auto refresh, no one-shot refresh, at most 15 minutes.
    await assert.rejects(pres(`select public.chat_troll_apply('alice', array['auto_refresh'], 5)`), /Unknown troll/);
    await assert.rejects(pres(`select public.chat_troll_refresh('alice')`), /Unknown troll/);
    await assert.rejects(pres(`select public.chat_troll_apply('alice', array['popups'], 16)`), /1 and 15 minutes/);
    // It can't shorten or take over a troll someone else started.
    await call('PomKnee', `select public.chat_troll_apply('bob', array['popups'], 60)`);
    const before = (await db.query(`select expires_at, created_by from private.chat_troll_effects where target='bob' and effect='popups'`)).rows[0];
    await pres(`select public.chat_troll_apply('bob', array['popups','shake'], 1)`);
    const after = (await db.query(`select expires_at, created_by from private.chat_troll_effects where target='bob' and effect='popups'`)).rows[0];
    assert.equal(after.created_by, 'PomKnee'); assert.equal(+after.expires_at, +before.expires_at);
    // It sees and stops only its own; the full menu sees everything.
    const mine = (await pres(`select public.chat_troll_list() r`))[0].r;
    assert.deepEqual(mine.find(x => x.target === 'bob').effects.map(e => e.effect), ['shake']);
    assert.equal((await call('connor', `select public.chat_troll_list() r`))[0].r.find(x => x.target === 'bob').effects.length, 2);
    await pres(`select public.chat_troll_clear('bob')`);
    assert.deepEqual((await db.query(`select effect, created_by from private.chat_troll_effects where target='bob'`)).rows, [{ effect: 'popups', created_by: 'PomKnee' }]);
    // The PRESTON role alone gives nothing: another account holding it is refused.
    await db.query(`update public.profiles set staff_role='preston' where username='owner'`);
    await assert.rejects(call('owner', `select public.chat_troll_apply('alice', array['shake'], 5)`), /troll menu is not available/);
    // Kirk now has the full menu: every troll, the refresh, and co-owner-level targets.
    await call('kirk', `select public.chat_troll_apply('coowner', array['auto_refresh','shake'], 60)`);
    await call('kirk', `select public.chat_troll_refresh('alice')`);
    // A banned PRESTON account loses it.
    await db.query(`update public.profiles set is_banned=true where username='pres'`);
    await assert.rejects(pres(`select public.chat_troll_apply('alice', array['shake'], 5)`), /troll menu is not available/);
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
    await assert.rejects(call('coowner', `select public.chat_troll_refresh('alice')`), /troll menu is not available/);
  } finally { await db.close(); }
});
