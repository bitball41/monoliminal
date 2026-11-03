import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const ids = {
  alice: '00000000-0000-4000-8000-000000000001', bob: '00000000-0000-4000-8000-000000000002',
  carol: '00000000-0000-4000-8000-000000000003', mod: '00000000-0000-4000-8000-000000000004',
  admin: '00000000-0000-4000-8000-000000000005', owner: '00000000-0000-4000-8000-000000000006',
};
const roles = { mod: 'mod', admin: 'admin', owner: 'owner' };
const tokens = { admin: 'a'.repeat(40), owner: 'o'.repeat(40) };

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(await file('Backend/tests/authorization-fixture.sql'));
  for (const name of (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort())
    await db.exec(await file('Backend/migrations/' + name));
  await db.exec(await file('Backend/tests/authorization-triggers.sql'));
  for (const [name, id] of Object.entries(ids)) {
    await db.query('insert into auth.users(id) values($1)', [id]);
    await db.query('insert into public.profiles(username,user_id,display_name,staff_role) values($1,$2,$1,$3)', [name, id, roles[name] || 'member']);
  }
  for (const [name, token] of Object.entries(tokens))
    await db.query("insert into private.chat_admin_sessions(token_hash,username,expires_at) values(extensions.digest($1,'sha256'),$2,now()+interval '1 hour')", [token, name]);
  const actor = async (name, role = 'authenticated') =>
    db.exec(`reset role;select set_config('request.jwt.claim.sub','${name ? ids[name] : ''}',false);set role ${role};`);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  return { db, actor, one };
}

test('DM members can report received messages; nobody else can, and browsers never read reports', async () => {
  const { db, actor, one } = await setup();
  try {
    await actor('alice');
    const dm = (await one("insert into public.dms(participants) values(array['alice','bob']) returning id")).id;
    const mine = (await one("insert into public.dm_messages(dm_id,sender,content) values($1,'alice','hi') returning id", [dm])).id;
    await actor('bob');
    const bad = (await one("insert into public.dm_messages(dm_id,sender,content) values($1,'bob','explicit message') returning id", [dm])).id;

    await actor('alice');
    await assert.rejects(db.query("select public.chat_report_dm_message($1,'sexual','')", [mine]), /own message/);
    await assert.rejects(db.query("select public.chat_report_dm_message($1,'nonsense','')", [bad]), /reason/);
    await assert.rejects(db.query("select public.chat_report_dm_message($1,'other',$2)", [bad, 'x'.repeat(501)]), /500/);
    const first = (await one("select public.chat_report_dm_message($1,'sexual','sent after I said stop') r", [bad])).r;
    assert.equal(first.status, 'open');
    assert.equal(first.duplicate, false);
    const again = (await one("select public.chat_report_dm_message($1,'harassment','') r", [bad])).r;
    assert.equal(again.id, first.id, 'repeat reports update the existing report');
    assert.equal(again.duplicate, true);

    for (const name of ['carol', 'mod', 'owner']) {
      await actor(name);
      await assert.rejects(db.query("select public.chat_report_dm_message($1,'spam','')", [bad]), /unavailable/, `${name} is not in the DM`);
    }
    await assert.rejects(db.query("select public.chat_report_dm_message(gen_random_uuid(),'spam','')"), /unavailable/);
    await actor(null, 'anon');
    await assert.rejects(db.query("select public.chat_report_dm_message($1,'spam','')", [bad]));

    for (const name of ['alice', 'mod', 'admin', 'owner']) {
      await actor(name);
      await assert.rejects(db.query('select * from private.chat_dm_reports'), undefined, `${name} cannot read the table`);
      await assert.rejects(db.query("update private.chat_dm_reports set status='dismissed'"));
    }

    await actor(null, 'postgres');
    const stored = await one('select * from private.chat_dm_reports');
    assert.equal(stored.reporter, 'alice');
    assert.equal(stored.reported_user, 'bob');
    assert.equal(stored.reason, 'harassment');
    assert.equal(stored.message_content, 'explicit message', 'evidence is snapshotted');
    assert.deepEqual(stored.participants, ['alice', 'bob']);
  } finally { await db.close(); }
});

test('reports are rate limited per reporter', async () => {
  const { db, actor, one } = await setup();
  try {
    await actor('alice');
    const dm = (await one("insert into public.dms(participants) values(array['alice','bob']) returning id")).id;
    await actor('bob');
    const messages = [];
    for (let i = 0; i < 21; i++) messages.push((await one("insert into public.dm_messages(dm_id,sender,content) values($1,'bob',$2) returning id", [dm, 'm' + i])).id);
    await actor('alice');
    for (const id of messages.slice(0, 20)) await db.query("select public.chat_report_dm_message($1,'spam','')", [id]);
    await assert.rejects(db.query("select public.chat_report_dm_message($1,'spam','')", [messages[20]]), /Too many reports/);
  } finally { await db.close(); }
});

test('only the owner dashboard session can list, view context, and resolve reports', async () => {
  const { db, actor, one } = await setup();
  try {
    await actor('alice');
    const dm = (await one("insert into public.dms(participants) values(array['alice','bob']) returning id")).id;
    const other = (await one("insert into public.dms(participants) values(array['alice','carol']) returning id")).id;
    await db.query("insert into public.dm_messages(dm_id,sender,content) values($1,'alice','unrelated conversation')", [other]);
    let bad;
    for (let i = 0; i < 40; i++) {
      const sender = i % 2 ? 'bob' : 'alice';
      await actor(sender);
      const id = (await one("insert into public.dm_messages(dm_id,sender,content,created_at) values($1,$2,$3,now()) returning id", [dm, sender, 'msg ' + i])).id;
      await actor(null, 'postgres');
      await db.exec("set session_replication_role = replica");
      await db.query("update public.dm_messages set created_at=timestamptz '2026-11-01' + make_interval(mins => $2) where id=$1", [id, i]);
      await db.exec("set session_replication_role = origin");
      if (i === 21) bad = id;
    }
    await actor('alice');
    const report = (await one("select public.chat_report_dm_message($1,'sexual','') r", [bad])).r.id;

    // Admins below owner rank, and owner accounts without a dashboard session, are refused.
    await actor('admin');
    await assert.rejects(db.query("select public.admin_dashboard_list_dm_reports($1,'open',50)", [tokens.admin]), /Owner access/);
    await assert.rejects(db.query('select public.admin_dashboard_get_dm_report_context($1,$2,15)', [tokens.admin, report]), /Owner access/);
    await assert.rejects(db.query("select public.admin_dashboard_resolve_dm_report($1,$2,'dismissed','',false)", [tokens.admin, report]), /Owner access/);
    await actor('owner');
    await assert.rejects(db.query("select public.admin_dashboard_list_dm_reports($1,'open',50)", ['x'.repeat(40)]), /administrator session/);
    assert.equal((await one('select count(*)::int n from public.dm_messages where dm_id=$1', [dm])).n, 0, 'owner rank alone still cannot read DMs');

    const list = (await one("select public.admin_dashboard_list_dm_reports($1,'open',50) r", [tokens.owner])).r;
    assert.equal(list.counts.open, 1);
    assert.equal(list.reports[0].message_content, 'msg 21');
    assert.equal(list.reports[0].reported_user, 'bob');
    assert.equal(list.reports[0].reported_user_open_reports, 1);
    await assert.rejects(db.query("select public.admin_dashboard_list_dm_reports($1,'everything',50)", [tokens.owner]));

    const context = (await one('select public.admin_dashboard_get_dm_report_context($1,$2,15) r', [tokens.owner, report])).r;
    const contents = context.messages.map(m => m.content);
    assert.equal(contents.length, 15 + 1 + 15, 'bounded window around the report');
    assert.equal(contents[0], 'msg 6');
    assert.equal(contents.at(-1), 'msg 36');
    assert.equal(context.messages.filter(m => m.is_reported).length, 1);
    assert.ok(!contents.includes('unrelated conversation'), 'other conversations stay closed');
    const wide = (await one('select public.admin_dashboard_get_dm_report_context($1,$2,1000) r', [tokens.owner, report])).r;
    assert.equal(wide.radius, 25, 'radius is capped');

    await actor(null, 'postgres');
    const audit = await one("select * from private.chat_admin_audit where action='dm_report_context_viewed' order by id desc limit 1");
    assert.equal(audit.actor_username, 'owner');
    assert.equal(audit.target, 'bob');
    assert.equal(audit.details.report_id, report);
    assert.ok(!JSON.stringify(audit.details).includes('msg'), 'audit has no message content');

    await actor('owner');
    await assert.rejects(db.query("select public.admin_dashboard_resolve_dm_report($1,$2,'dismissed','',true)", [tokens.owner, report]), /actioned/);
    const resolved = (await one("select public.admin_dashboard_resolve_dm_report($1,$2,'actioned','removed',true) r", [tokens.owner, report])).r;
    assert.equal(resolved.status, 'actioned');
    assert.equal(resolved.resolved_by, 'owner');
    assert.equal(resolved.message_deleted, true);
    await actor(null, 'postgres');
    const removed = await one('select deleted, deleted_by from public.dm_messages where id=$1', [bad]);
    assert.equal(removed.deleted, true);
    assert.equal(removed.deleted_by, 'owner');
    assert.equal(current(await one("select current_setting('app.chat_admin_delete',true) v")), '', 'bypass flag does not leak');

    await actor('owner');
    const reopened = (await one("select public.admin_dashboard_resolve_dm_report($1,$2,'open','',false) r", [tokens.owner, report])).r;
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.resolved_by, null);
  } finally { await db.close(); }
});

function current(row) { return row?.v ?? ''; }

test('owner can read private-group messages and attachments through Control only; other staff cannot', async () => {
  const { db, actor, one } = await setup();
  try {
    await actor('alice');
    const group = (await one("select public.chat_create_group('Group',array['bob']) id")).id;
    await actor('bob');
    await db.query('select public.chat_respond_group_invite($1,true)', [group]);
    const path = `${group}/${ids.bob}/photo.jpg`;
    await db.query("insert into storage.objects(bucket_id,name,owner_id) values('liminal-group-media',$1,$2)", [path, ids.bob]);
    const bad = (await one("insert into public.dm_messages(dm_id,sender,content,type,media_url) values($1,'bob','','image',$2) returning id", [group, 'group-media:' + path])).id;
    const objects = async () => (await one("select count(*)::int n from storage.objects where bucket_id='liminal-group-media'")).n;

    for (const name of ['admin', 'mod', 'carol']) {
      await actor(name);
      assert.equal(await objects(), 0, `${name} cannot read group media`);
    }
    await actor('owner');
    assert.equal(await objects(), 1, 'owner can sign group attachments');
    assert.equal((await one('select count(*)::int n from public.dm_messages where dm_id=$1', [group])).n, 0, 'direct table reads stay member-only');
    const deleted = await db.query('delete from storage.objects where name=$1', [path]);
    assert.equal(deleted.affectedRows ?? 0, 0, 'owner read access does not extend to deleting member uploads');
    const direct = await db.query('update public.dm_messages set deleted=true where id=$1', [bad]);
    assert.equal(direct.affectedRows ?? 0, 0, 'direct writes still see no group rows');

    const page = (await one('select public.admin_dashboard_get_dm_messages($1,$2,null,null,50) r', [tokens.owner, group])).r;
    assert.equal(page.conversation.is_group, true);
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].media_url, 'group-media:' + path);
    assert.equal((await one('select public.admin_dashboard_remove_dm_message($1,$2,$3) r', [tokens.owner, bad, 'explicit image'])).r, true,
      'owner removal passes the group guard for this message only');
    assert.equal((await one('select public.admin_dashboard_remove_dm_message($1,$2,$3) r', [tokens.owner, bad, ''])).r, false, 'already removed');

    await actor('bob');
    assert.equal(await objects(), 1, 'members keep access');
    await db.query("insert into public.dm_messages(dm_id,sender,content) values($1,'bob','still works')", [group]);
  } finally { await db.close(); }
});

test('owner browses and searches every DM with audit entries; other staff are refused', async () => {
  const { db, actor, one } = await setup();
  try {
    await actor('alice');
    const dm = (await one("insert into public.dms(participants) values(array['alice','bob']) returning id")).id;
    const quiet = (await one("insert into public.dms(participants) values(array['alice','carol']) returning id")).id;
    for (let i = 0; i < 60; i++) {
      const sender = i % 2 ? 'bob' : 'alice';
      await actor(sender);
      await db.query("insert into public.dm_messages(dm_id,sender,content) values($1,$2,$3)", [dm, sender, i === 42 ? 'send pics 100%_real' : 'line ' + i]);
    }
    await actor(null, 'postgres');
    await db.exec("set session_replication_role = replica");
    await db.query("update public.dm_messages set created_at = timestamptz '2026-11-01' + make_interval(secs => (regexp_replace(content,'\\D','','g')::int)) where dm_id=$1 and content like 'line %'", [dm]);
    await db.query("update public.dm_messages set created_at = timestamptz '2026-11-01' + make_interval(secs => 42) where content like 'send%'");
    await db.exec("set session_replication_role = origin");

    for (const name of ['admin', 'mod']) {
      await actor(name);
      for (const [sql, params] of [
        ["select public.admin_dashboard_list_dm_conversations($1,'',50,0)", [tokens.admin]],
        ['select public.admin_dashboard_get_dm_messages($1,$2,null,null,50)', [tokens.admin, dm]],
        ["select public.admin_dashboard_search_dm_messages($1,'pics','',50)", [tokens.admin]],
        ["select public.admin_dashboard_remove_dm_message($1,gen_random_uuid(),'')", [tokens.admin]],
      ]) await assert.rejects(db.query(sql, params), /Owner access|administrator session/);
      assert.equal((await one('select count(*)::int n from public.dm_messages where dm_id=$1', [dm])).n, 0, `${name} cannot read DMs directly`);
    }

    await actor('owner');
    const list = (await one("select public.admin_dashboard_list_dm_conversations($1,'',50,0) r", [tokens.owner])).r;
    assert.equal(list.total, 2);
    assert.equal(list.conversations[0].id, dm, 'most recent activity first');
    assert.equal(list.conversations[0].message_count, 60);
    assert.equal(list.conversations[1].id, quiet);
    assert.equal(list.conversations[1].last_message_at, null);
    const filtered = (await one("select public.admin_dashboard_list_dm_conversations($1,'@CAR',50,0) r", [tokens.owner])).r;
    assert.deepEqual(filtered.conversations.map(c => c.id), [quiet]);
    const literal = (await one("select public.admin_dashboard_list_dm_conversations($1,'%',50,0) r", [tokens.owner])).r;
    assert.equal(literal.total, 0, 'LIKE wildcards are escaped');

    const newest = (await one('select public.admin_dashboard_get_dm_messages($1,$2,null,null,50) r', [tokens.owner, dm])).r;
    assert.equal(newest.messages.length, 50);
    assert.equal(newest.has_more, true);
    assert.equal(newest.messages.at(-1).content, 'line 59');
    assert.equal(newest.messages[0].content, 'line 10');
    const first = newest.messages[0];
    const older = (await one('select public.admin_dashboard_get_dm_messages($1,$2,$3,$4,50) r', [tokens.owner, dm, first.created_at, first.id])).r;
    assert.equal(older.messages.length, 10);
    assert.equal(older.messages[0].content, 'line 0');
    assert.equal(older.has_more, false);

    const found = (await one("select public.admin_dashboard_search_dm_messages($1,'100%_',' ',50) r", [tokens.owner])).r;
    assert.equal(found.messages.length, 1);
    assert.equal(found.messages[0].sender, 'alice');
    assert.deepEqual(found.messages[0].conversation.participants, ['alice', 'bob']);
    const bySender = (await one("select public.admin_dashboard_search_dm_messages($1,'','@Bob',100) r", [tokens.owner])).r;
    assert.equal(bySender.messages.length, 30);
    await assert.rejects(db.query("select public.admin_dashboard_search_dm_messages($1,'a','',50)", [tokens.owner]), /2 characters/);

    assert.equal((await one('select public.admin_dashboard_remove_dm_message($1,$2,$3) r', [tokens.owner, found.messages[0].id, 'explicit'])).r, true);

    await actor(null, 'postgres');
    const audit = (await db.query("select action,target,details from private.chat_admin_audit where actor_username='owner' order by id")).rows;
    const actions = audit.map(a => a.action);
    assert.deepEqual(actions, ['dm_conversation_viewed', 'dm_conversation_viewed', 'dm_search', 'dm_search', 'dm_message_removed']);
    assert.equal(audit[0].target, 'alice, bob');
    assert.equal(audit[2].details.query, '100%_');
    assert.ok(!audit.some(a => JSON.stringify(a.details).includes('send pics')), 'audit never stores message content');
    const removed = await one("select deleted, deleted_by from public.dm_messages where content like 'send%'");
    assert.deepEqual(removed, { deleted: true, deleted_by: 'owner' });
    await actor('alice');
    assert.equal((await one("select count(*)::int n from public.dm_messages where dm_id=$1 and not deleted", [dm])).n, 59, 'members see the removal');
  } finally { await db.close(); }
});

test('Control keeps DM safety owner-only and calls only RPCs the migration defines', async () => {
  const html = await file('Admin/liminal-admin-dashboard.html');
  const sql = await file('Backend/migrations/20261103180000_dm_reports.sql');
  assert.match(html, /const OWNER_VIEWS = \[[^\]]*"dms"/);
  assert.match(html, /class="nav-btn owner-only" data-view="dms"/);
  assert.match(html, /if \(OWNER_VIEWS\.includes\(view\) && !admin\?\.is_owner\) return;/);
  const ui = html.slice(html.indexOf('/* DM_SAFETY_UI_START */'), html.indexOf('/* DM_SAFETY_UI_END */'));
  const called = [...new Set([...ui.matchAll(/rpc\("(admin_dashboard_[a-z_]+)"/g)].map(m => m[1]))];
  assert.ok(called.length >= 7);
  for (const name of called.filter(name => name.includes('dm_'))) {
    assert.match(sql, new RegExp(`CREATE FUNCTION public\\.${name}\\(`), name);
    assert.match(sql, new RegExp(`private\\.require_chat_admin\\(p_admin_token, true\\)[\\s\\S]*?END;\\s*\\$\\$;`), name);
  }
  for (const fn of sql.matchAll(/CREATE FUNCTION public\.(admin_dashboard_\w+)\([\s\S]*?\n\$\$;/g))
    assert.match(fn[0], /require_chat_admin\(p_admin_token, true\)/, `${fn[1]} requires the owner session`);
  assert.match(html, /resetDmSafety\(\);/, 'sign-out clears loaded private messages');
});
