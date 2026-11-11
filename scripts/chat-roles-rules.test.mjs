// Chat 6.1 part 3: custom staff roles, owner-editable rules and cloud sticker
// favorites, checked against every migration in an isolated database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  const people = { owner: 'owner', coowner: 'co_owner', admin: 'admin', manager: 'manager', mod: 'mod', alice: 'member', bob: 'member', carol: 'member' };
  const ids = Object.fromEntries(Object.keys(people).map((name, i) => [name, `00000000-0000-4000-8000-0000000002${String(i + 10)}`]));
  await db.exec(await file('Backend/tests/authorization-fixture.sql'));
  for (const name of (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
    await db.exec(await file('Backend/migrations/' + name));
  }
  await db.exec(await file('Backend/tests/authorization-triggers.sql'));
  for (const [name, role] of Object.entries(people)) {
    await db.query('insert into auth.users(id) values($1)', [ids[name]]);
    await db.query('insert into public.profiles(username,display_name,user_id,staff_role) values($1,$1,$2,$3)', [name, ids[name], role]);
  }
  const as = async name => db.exec(`reset role; select set_config('request.jwt.claim.sub','${ids[name] || ''}',false); set role authenticated;`);
  const call = async (name, sql, params = []) => { await as(name); try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); } };
  const role = async name => (await db.query('select staff_role, is_admin from public.profiles where username=$1', [name])).rows[0];
  return { db, as, call, role };
}

test('built-in roles keep their permission levels', async () => {
  const { db } = await setup();
  try {
    const ranks = (await db.query(`select r, private.chat_staff_rank(r) tier from unnest(array['member','mod','manager','admin','super_mega_tuff_admin','dusty','co_owner','owner','preston','nonsense']) r`)).rows;
    assert.deepEqual(Object.fromEntries(ranks.map(x => [x.r, x.tier])),
      { member: 1, mod: 2, manager: 3, admin: 4, super_mega_tuff_admin: 4, dusty: 4, co_owner: 5, owner: 6, preston: 7, nonsense: 1 });
    const powers = (await db.query(`select private.chat_staff_power('admin') a, private.chat_staff_power('dusty') d, private.chat_staff_power('super_mega_tuff_admin') s`)).rows[0];
    assert(powers.a === powers.d && powers.d === powers.s, 'the three admin roles stay equal, so none can act on another');
    // Adding a role to their level keeps the three tied below it.
    const id = '00000000-0000-4000-8000-000000000299';
    await db.query('insert into auth.users(id) values($1)', [id]);
    await db.query("insert into public.profiles(username,display_name,user_id,staff_role) values('boss','boss',$1,'owner')", [id]);
    await db.exec(`select set_config('request.jwt.claim.sub','${id}',false); set role authenticated;`);
    await db.query("select public.chat_save_staff_role(null,'Head Admin',null,4)");
    await db.exec('reset role');
    const after = (await db.query(`select private.chat_staff_power('admin') a, private.chat_staff_power('dusty') d, private.chat_staff_power('super_mega_tuff_admin') s, (select power from public.chat_staff_roles where label='Head Admin') h`)).rows[0];
    assert(after.a === after.d && after.d === after.s && after.h > after.a);
  } finally { await db.close(); }
});

test('the owner creates a role, places it, and its permissions follow its level', async () => {
  const { db, call, role } = await setup();
  try {
    // Only the owner manages roles.
    await assert.rejects(call('coowner', "select public.chat_save_staff_role(null,'Helper','#22c55e',2)"), /Insufficient staff permission/);
    const senior = (await call('owner', "select public.chat_save_staff_role(null,'Senior Mod','#22C55E',2) r"))[0].r;
    assert.equal(senior.tier, 2); assert.equal(senior.color, '#22c55e');
    const ladder = async () => (await db.query("select slug from public.chat_staff_roles where slug not in ('member','owner','preston') order by power desc, slug")).rows.map(r => r.slug);
    const before = await ladder();
    assert.equal(before.indexOf(senior.slug), before.indexOf('mod') - 1, 'a new role starts just above the highest role with the same powers');
    await assert.rejects(call('owner', "select public.chat_save_staff_role(null,'Boss','#000000',6)"), /Choose Mod, Manager, Admin or Co-owner/);
    await assert.rejects(call('owner', "select public.chat_save_staff_role(null,'senior mod',null,2)"), /already exists/);

    // Co-owners assign it like any role below them.
    assert.deepEqual(await call('coowner', 'select public.chat_set_staff_role($1,$2,$3,$4) ok', ['coowner', '', 'alice', senior.slug]), [{ ok: true }]);
    await call('coowner', 'select public.chat_set_staff_role($1,$2,$3,$4) ok', ['coowner', '', 'bob', 'mod']);
    assert.equal((await role('alice')).staff_role, senior.slug);
    await assert.rejects(call('coowner', 'select public.chat_set_staff_role($1,$2,$3,$4)', ['coowner', '', 'carol', 'owner']), /Invalid staff role/);

    // Mod level: may time out the Mod placed below it, for at most two hours, and cannot ban.
    await call('alice', 'select public.chat_staff_timeout_user($1,$2,$3,60)', ['alice', '', 'bob']);
    await assert.rejects(call('alice', 'select public.chat_staff_timeout_user($1,$2,$3,121)', ['alice', '', 'bob']), /up to 120 minutes/);
    await assert.rejects(call('alice', "select public.chat_ban_user($1,$2,$3,'x')", ['alice', '', 'carol']), /Insufficient staff permission/);
    await assert.rejects(call('bob', 'select public.chat_staff_timeout_user($1,$2,$3,10)', ['bob', '', 'alice']), /below your rank/);

    // Reordering puts Mod above Senior Mod: the direction of authority flips.
    const moved = (await ladder()).filter(x => x !== senior.slug); moved.splice(moved.indexOf('mod') + 1, 0, senior.slug);
    await call('owner', 'select public.chat_reorder_staff_roles($1)', [moved]);
    await call('bob', 'select public.chat_staff_timeout_user($1,$2,$3,10)', ['bob', '', 'alice']);
    await assert.rejects(call('alice', 'select public.chat_staff_timeout_user($1,$2,$3,10)', ['alice', '', 'bob']), /below your rank/);
    await assert.rejects(call('owner', 'select public.chat_reorder_staff_roles($1)', [moved.slice(1)]), /every staff role exactly once/);

    // New tiers anywhere: a role with Mod powers placed above Co-owner acts on
    // co-owners, but still has only Mod powers (no bans, two-hour time-outs).
    const crossed = moved.filter(x => x !== senior.slug); crossed.unshift(senior.slug);
    await call('owner', 'select public.chat_reorder_staff_roles($1)', [crossed]);
    await call('alice', 'select public.chat_staff_timeout_user($1,$2,$3,30)', ['alice', '', 'coowner']);
    await assert.rejects(call('alice', "select public.chat_ban_user($1,$2,$3,'x')", ['alice', '', 'coowner']), /Insufficient staff permission/);
    await assert.rejects(call('coowner', 'select public.chat_set_staff_role($1,$2,$3,$4)', ['coowner', '', 'alice', 'member']), /below your rank/,
      'a co-owner cannot change a role placed above them');
    await call('owner', 'select public.chat_reorder_staff_roles($1)', [moved]);
    const ties = (await db.query("select count(distinct power)::int n from public.chat_staff_roles where slug in ('admin','dusty','super_mega_tuff_admin')")).rows[0].n;
    assert.equal(ties, 1, 'reordering keeps the three admin roles tied while they stay together');

    // An admin-level custom role is an admin: legacy flag on, no bans.
    const warden = (await call('owner', "select public.chat_save_staff_role(null,'Warden',null,4) r"))[0].r;
    await call('coowner', 'select public.chat_set_staff_role($1,$2,$3,$4)', ['coowner', '', 'carol', warden.slug]);
    assert.equal((await role('carol')).is_admin, true);
    await assert.rejects(call('carol', "select public.chat_ban_user($1,$2,$3,'x')", ['carol', '', 'bob']), /Admins cannot ban/);
    await db.query("select set_config('request.jwt.claim.sub',(select user_id::text from public.profiles where username='carol'),false)");
    assert.equal((await db.query('select private.liminal_drive_rank() r')).rows[0].r, 3, 'Drive treats it as admin level');

    // Changing a custom role's powers keeps its place and updates its holders' flags.
    const place = (await db.query('select power from public.chat_staff_roles where slug=$1', [warden.slug])).rows[0].power;
    await call('owner', "select public.chat_save_staff_role($1,'Warden',null,3)", [warden.slug]);
    assert.equal((await db.query('select power from public.chat_staff_roles where slug=$1', [warden.slug])).rows[0].power, place);
    assert.equal((await role('carol')).is_admin, false);
    await call('carol', "select public.chat_ban_user($1,$2,$3,'spam')", ['carol', '', 'bob']);

    // Built-ins can be renamed but keep their level; deleting a custom role demotes its holders.
    await call('owner', "select public.chat_save_staff_role('mod','Moderator',null,null)");
    await assert.rejects(call('owner', "select public.chat_save_staff_role('mod','Moderator',null,4)"), /keep their powers/);
    await assert.rejects(call('owner', "select public.chat_delete_staff_role('mod')"), /cannot be deleted/);
    await call('owner', 'select public.chat_delete_staff_role($1)', [warden.slug]);
    assert.deepEqual(await role('carol'), { staff_role: 'member', is_admin: false });

    // Members read the catalog; nobody writes it directly.
    assert((await call('carol', 'select count(*)::int n from public.chat_staff_roles'))[0].n >= 9);
    await assert.rejects(call('owner', "insert into public.chat_staff_roles(slug,label,tier,power) values('x_x','X',2,260)"));
    // An unknown role can never be stored: it becomes Member.
    await db.query("update public.profiles set staff_role='made_up' where username='alice'");
    assert.equal((await role('alice')).staff_role, 'member');
  } finally { await db.close(); }
});

test('only the owner edits the rules, and they are validated', async () => {
  const { db, call } = await setup();
  try {
    const rules = JSON.stringify([{ title: '  Be kind ', body: 'No bullying.', extra: 'dropped' }, { title: 'No spam', body: 'One message is enough.' }]);
    await assert.rejects(call('coowner', "select public.chat_owner_set_app_setting('community_rules',$1)", [rules]), /Owner access/);
    await call('owner', "select public.chat_owner_set_app_setting('community_rules',$1)", [rules]);
    const saved = JSON.parse((await db.query("select value from public.app_settings where key='community_rules'")).rows[0].value);
    assert.deepEqual(saved, [{ title: 'Be kind', body: 'No bullying.' }, { title: 'No spam', body: 'One message is enough.' }]);
    for (const bad of ['[]', 'nope', JSON.stringify([{ title: '', body: 'x' }]), JSON.stringify([{ title: 'x'.repeat(81), body: 'x' }]), JSON.stringify(Array(31).fill({ title: 't', body: 'b' }))]) {
      await assert.rejects(call('owner', "select public.chat_owner_set_app_setting('community_rules',$1)", [bad]));
    }
    await call('owner', "select public.chat_owner_set_app_setting('community_rules','')");
  } finally { await db.close(); }
});

test('sticker favorites are private to their owner', async () => {
  const { db, call } = await setup();
  try {
    const favs = JSON.stringify([{ name: 'cat', url: 'https://x/cat.png' }]);
    await call('alice', 'insert into public.user_fav_stickers(username,stickers) values($1,$2::jsonb)', ['alice', favs]);
    assert.equal((await call('alice', 'select stickers from public.user_fav_stickers'))[0].stickers[0].name, 'cat');
    assert.equal((await call('bob', 'select count(*)::int n from public.user_fav_stickers'))[0].n, 0, 'others cannot read them');
    await assert.rejects(call('bob', 'insert into public.user_fav_stickers(username,stickers) values($1,$2::jsonb)', ['alice', '[]']));
    assert.equal((await call('bob', "update public.user_fav_stickers set stickers='[]' where username='alice' returning 1")).length, 0);
    await assert.rejects(call('alice', 'update public.user_fav_stickers set stickers=$1::jsonb', [JSON.stringify(Array(301).fill({ url: 'u' }))]));
  } finally { await db.close(); }
});

test('members edit their own profile extras, which are validated', async () => {
  const { db, call } = await setup();
  try {
    const good = { pronouns: 'she/her', birthday: { m: 2, d: 29 }, links: [{ label: 'Portfolio', url: 'https://example.com/me' }],
      timezone: 'America/Chicago', show_time: true, accent: '#22C55E' };
    await call('alice', "update public.profiles set profile_extras=$1::jsonb where username='alice'", [JSON.stringify(good)]);
    assert.deepEqual((await call('bob', "select profile_extras from public.profiles where username='alice'"))[0].profile_extras, good, 'others can read them');
    assert.equal((await call('bob', "update public.profiles set profile_extras='{}'::jsonb where username='alice' returning 1")).length, 0, 'only the owner edits them');
    const bad = [
      { pronouns: 'x'.repeat(25) }, { birthday: { m: 2, d: 30 } }, { birthday: { m: 13, d: 1 } }, { birthday: { m: 1, d: 1, y: 2010 } },
      { links: [{ label: 'x', url: 'javascript:alert(1)' }] }, { links: [{ label: 'x', url: 'http://plain.example' }] },
      { links: Array(4).fill({ label: 'x', url: 'https://a.b' }) }, { links: [{ label: 'x', url: 'https://a.b/"onmouseover' }] },
      { timezone: 'Not a zone!' }, { show_time: 'yes' }, { accent: 'red' }, { secret: 1 },
    ];
    for (const value of bad) {
      await assert.rejects(call('alice', "update public.profiles set profile_extras=$1::jsonb where username='alice'", [JSON.stringify(value)]), undefined, JSON.stringify(value));
    }
  } finally { await db.close(); }
});
