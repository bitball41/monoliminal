import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const migration = '20261026045434_optimize_chat_analytics_summary.sql';

test('analytics preserves every field and permission while counting visible history from a compact index', async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const one = async (sql, args) => (await db.query(sql, args)).rows[0];
  const actor = async (number, role = 'authenticated') => {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [number ? (await one("select md5('analytics-user-' || $1::text)::uuid::text id", [number])).id : '']);
    await db.exec('set role ' + role);
  };
  const summary = async () => (await one('select private.chat_analytics_summary() data')).data;
  const denied = async query => {
    await db.exec('savepoint denied_call');
    await assert.rejects(db.query(query));
    await db.exec('rollback to savepoint denied_call; release savepoint denied_call');
  };
  const definition = async () => (await one("select pg_get_functiondef('private.chat_analytics_summary()'::regprocedure) definition")).definition;
  const visiblePlan = async () => {
    // Explain the actual count used in the function, so a stale copied query
    // cannot claim that the dashboard benefits from an unused index.
    const query = (await definition()).match(/'visible_messages',\(([\s\S]*?)\),\s*'devices_total'/)[1];
    return (await one('explain (analyze, buffers, format json) ' + query))['QUERY PLAN'][0];
  };
  const acl = async () => (await db.query(`select n.nspname,p.proname,p.prosecdef,p.provolatile,p.proacl,p.proconfig
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.proname in ('chat_analytics_summary','chat_get_analytics','admin_dashboard_get_state')
    order by n.nspname,p.proname`)).rows;
  const timed = async () => {
    const times = [];
    for (let i = 0; i < 3; i++) { const start = performance.now(); await summary(); times.push(performance.now() - start); }
    return times.sort((a, b) => a - b)[1];
  };
  try {
    await db.exec(await file('Backend/tests/authorization-fixture.sql'));
    for (const name of (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(name => name.endsWith('.sql') && name !== migration).sort()) {
      await db.exec(await file('Backend/migrations/' + name));
    }
    // Comparable scale to the measured project: 46 identities, 64k messages,
    // 74k ledger rows, shared browsers, removed channels and historical actors.
    // All rows are synthetic. User triggers are suspended only while building
    // the local fixture, then restored before comparisons and permission checks.
    await db.exec(`
      insert into auth.users(id) select md5('analytics-user-'||i)::uuid from generate_series(1,46)i;
      insert into public.profiles(username,display_name,user_id,staff_role,is_banned,is_test_account)
        select 'bench_'||i,'Bench '||i,md5('analytics-user-'||i)::uuid,
          case when i in (1,45) then 'owner' when i=2 then 'admin' else 'member' end,i=45,i=46
        from generate_series(1,46)i;
      select set_config('request.jwt.claim.sub',md5('analytics-user-1')::uuid::text,false);
      insert into public.channels(id,label,kind)
        select 'bench_'||i,'Bench channel '||i,case when i=10 then 'forum' else 'chat' end from generate_series(1,10)i;
      alter table public.messages disable trigger user;
      insert into public.messages(id,channel_id,sender,content,created_at,deleted,owner_preview,type)
        select md5('message-'||i)::uuid,'bench_'||(i%12+1),'bench_'||(i%46+1),repeat('Synthetic message ',8),
          now()-(i%50)*interval '1 day'-(i%86400)*interval '1 second',i%20=0,i%29=0,
          case when i%41=0 then 'system' else 'text' end from generate_series(1,64321)i;
      alter table public.messages enable trigger user;
      truncate private.chat_message_facts;
      insert into private.chat_message_facts(scope,message_id,actor_key,channel_id,kind,sent_at,excluded)
        select case when i<=60000 then 'channel' else 'dm' end,md5('fact-'||i)::uuid,
          case when i%59=0 then 'legacy:removed' else md5('analytics-user-'||(i%46+1))::uuid::text end,
          case when i%13=0 then null else 'bench_'||(i%12+1) end,'text',
          now()-(i%50)*interval '1 day'-(i%86400)*interval '1 second',i%47=0 from generate_series(1,74053)i;
      insert into private.chat_activity_days
        select (now() at time zone 'America/Chicago')::date-i%36,md5('analytics-user-'||(i%46+1))::uuid,
          'analytics-browser-'||(i%57),now()-(i%36)*interval '1 day',now()-(i%36)*interval '1 day'
        from generate_series(1,1800)i on conflict do nothing;
      insert into public.chat_devices(username,device_id,last_seen_at)
        select 'bench_'||(i%46+1),'analytics-browser-'||(i%57),now()-(i%40)*interval '1 day'
        from generate_series(1,100)i on conflict do nothing;
    `);
    await db.exec('vacuum analyze');
    await db.exec('begin'); // now(), generated_at and rolling windows stay identical.
    await db.exec(`insert into private.chat_message_facts(scope,message_id,actor_key,channel_id,kind,sent_at,excluded)
      select 'channel',md5('boundary-'||i)::uuid,'boundary','bench_1','text',sent_at,false
      from unnest(array[now()-interval '24 hours',now()-interval '48 hours',now()-interval '7 days',
        ((now() at time zone 'America/Chicago')::date::timestamp at time zone 'America/Chicago')-interval '1 second',
        ((now() at time zone 'America/Chicago')::date::timestamp at time zone 'America/Chicago')+interval '1 second',
        now()+interval '1 day']) with ordinality b(sent_at,i)`);
    const before = await summary(), permissions = await acl(), beforePlan = await visiblePlan();
    const beforeMs = await timed();
    await db.exec(await file('Backend/migrations/' + migration));
    assert.deepEqual(await summary(), before, 'all counts, daily rows, top channels, timestamps and unknown-history values match');
    assert.deepEqual(await acl(), permissions, 'replacement preserves the private function and public bridge permissions');
    const afterPlan = await visiblePlan(), afterMs = await timed();
    const nodes = [];
    function walk(node) { nodes.push(node); (node.Plans || []).forEach(walk); }
    walk(afterPlan.Plan);
    const index = nodes.find(node => node['Index Name'] === 'messages_analytics_visible_sender_idx');
    assert.equal(index?.['Node Type'], 'Index Only Scan');
    assert.equal(index['Heap Fetches'], 0, 'historical visible counts avoid revisiting every message heap row');
    assert.ok(afterPlan.Plan['Shared Hit Blocks'] < beforePlan.Plan['Shared Hit Blocks'] / 4,
      'the measured count uses materially fewer buffers, independent of host timing');
    t.diagnostic(JSON.stringify({ syntheticFacts: 74059, syntheticMessages: 64321,
      visibleCountSharedHits: [beforePlan.Plan['Shared Hit Blocks'], afterPlan.Plan['Shared Hit Blocks']],
      functionMedianMs: [Math.round(beforeMs), Math.round(afterMs)],
      indexBytes: (await one("select pg_relation_size('public.messages_analytics_visible_sender_idx') bytes")).bytes }));
    await actor(1);
    assert.deepEqual((await one('select public.chat_get_analytics() data')).data, before);
    await denied('select private.chat_analytics_summary()');
    await actor(2);
    assert.deepEqual((await one('select public.chat_get_analytics() data')).data, before, 'staff bridge still works');
    for (const number of [3, 45, null]) {
      await actor(number, number ? 'authenticated' : 'anon');
      await denied('select public.chat_get_analytics()');
      await denied('select private.chat_analytics_summary()');
    }
    await db.exec('rollback; reset role');
    await db.exec(await file('Backend/migrations/' + migration));
    await db.exec(await file('Backend/migrations/' + migration));
    assert.equal((await one("select count(*)::int n from pg_indexes where indexname='messages_analytics_visible_sender_idx'")).n, 1,
      'replaying the migration does not duplicate the index');
  } finally { await db.close(); }
});
