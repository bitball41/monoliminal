// Regression tests for the Postgres errors seen in production logs:
// duplicate DM threads, anonymous requests after a lost session, and
// background reads piling onto an overloaded database.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
function section(start, end) {
  const from = chat.indexOf(start), to = chat.indexOf(end, from);
  assert(from >= 0 && to > from, start);
  return chat.slice(from, to);
}

function dmTable({ existing = [], failLookups = 0, raceRow = null } = {}) {
  const rows = [...existing], log = [];
  const from = table => {
    assert.equal(table, 'dms');
    let op = 'select', filters = {}, value = null;
    const run = () => {
      if (op === 'insert') {
        log.push('insert');
        if (raceRow) { rows.push(raceRow); raceRow = null; }
        const parts = value.participants.join();
        if (rows.some(row => !row.is_group && [...row.participants].sort().join() === parts)) {
          return { error: { code: '23505', message: 'duplicate key value violates unique constraint "dms_non_luna_participants_unique_idx"' } };
        }
        const row = { id: `dm-${rows.length + 1}`, is_group: false, participants: value.participants };
        rows.push(row);
        return { data: row };
      }
      log.push('lookup');
      if (failLookups > 0) { failLookups--; return { error: { code: '57014', message: 'canceling statement due to statement timeout' } }; }
      assert.equal(filters.is_group, false, 'groups with the same members are not direct messages');
      const want = [...filters.contains].sort().join();
      return { data: rows.filter(row => row.is_group === false && [...row.participants].sort().join() === want) };
    };
    const q = {
      select() { return q; }, insert(v) { op = 'insert'; value = v; return q; },
      eq(key, v) { filters[key] = v; return q; }, contains(key, v) { filters.contains = v; return q; },
      containedBy() { return q; }, order() { return q; },
      limit() { return Promise.resolve(run()); }, single() { return Promise.resolve(run()); },
    };
    return q;
  };
  return { sb: { from }, rows, log };
}
function dmContext(table) {
  const c = vm.createContext({ sb: table.sb, me: { username: 'alice' }, Map, Promise });
  vm.runInContext(section('    const dmOpenRequests = new Map();', '    async function openDmWith('), c);
  return c;
}

test('opening a DM reuses the existing thread instead of inserting a duplicate', async () => {
  const table = dmTable({ existing: [
    { id: 'group', is_group: true, participants: ['alice', 'bob'] },
    { id: 'pair', is_group: false, participants: ['bob', 'alice'] },
  ] });
  const result = await dmContext(table).ensureDirectDm('bob');
  assert.equal(result.data.id, 'pair');
  assert.deepEqual(table.log, ['lookup']);
});

test('repeated clicks share one create request', async () => {
  const table = dmTable();
  const c = dmContext(table);
  const [a, b] = await Promise.all([c.ensureDirectDm('bob'), c.ensureDirectDm('bob')]);
  assert.equal(a.data.id, b.data.id);
  assert.deepEqual(table.log, ['lookup', 'insert']);
  assert.equal(table.rows.length, 1);
});

test('a failed lookup never falls through to an insert', async () => {
  const table = dmTable({ failLookups: 1 });
  const result = await dmContext(table).ensureDirectDm('bob');
  assert.equal(result.error.code, '57014');
  assert.deepEqual(table.log, ['lookup']);
});

test('a thread the other person created concurrently is adopted after the unique conflict', async () => {
  const table = dmTable({ raceRow: { id: 'theirs', is_group: false, participants: ['alice', 'bob'] } });
  const result = await dmContext(table).ensureDirectDm('bob');
  assert.equal(result.data.id, 'theirs');
  assert.deepEqual(table.log, ['lookup', 'insert', 'lookup']);
});

function fetchContext(overrides = {}) {
  const requests = [], refreshes = [];
  const c = vm.createContext({
    me: { username: 'alice' }, URL, Headers, AbortSignal, performance, console, Promise, setTimeout,
    runtimeSupabaseKey: 'sb_publishable_fixture',
    sb: { auth: { refreshSession: async () => { refreshes.push(Date.now()); return { data: { session: null } }; } } },
    fetch: async (input, options) => { requests.push({ input, options }); return { ok: true, status: 200 }; },
    ...overrides,
  });
  vm.runInContext(section('    const CHAT_READ_TIMEOUT_MS =', '    function missingSchema('), c);
  // The section declares its own runtime key binding; point it at the fixture.
  vm.runInContext('runtimeSupabaseKey = "sb_publishable_fixture";', c);
  return { c, requests, refreshes };
}

test('signed-in Chat does not send chat-table requests as anon after the session is lost', async () => {
  const { c, requests, refreshes } = fetchContext();
  const anon = { headers: new Headers({ apikey: 'sb_publishable_fixture', Authorization: 'Bearer sb_publishable_fixture' }) };
  for (const [path, method] of [['dm_messages', 'POST'], ['dm_blocks', 'GET']]) {
    await assert.rejects(c.chatFetch(`https://fixture.invalid/rest/v1/${path}`, { ...anon, method }), /Failed to fetch/);
  }
  assert.equal(requests.length, 0, 'nothing reaches Postgres as anon');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(refreshes.length, 1, 'one session refresh, not one per request');
  const user = { method: 'GET', headers: new Headers({ apikey: 'sb_publishable_fixture', Authorization: 'Bearer user-jwt' }) };
  await c.chatFetch('https://fixture.invalid/rest/v1/dm_blocks', user);
  assert.equal(requests.length, 1, 'a real session still goes through');
});

test('before sign-in, public boot reads still use the publishable key', async () => {
  const { c, requests } = fetchContext({ me: null });
  vm.runInContext('me = null;', c);
  await c.chatFetch('https://fixture.invalid/rest/v1/app_settings', { method: 'GET',
    headers: new Headers({ apikey: 'sb_publishable_fixture', Authorization: 'Bearer sb_publishable_fixture' }) });
  assert.equal(requests.length, 1);
});

test('database errors pause background reconciliation with a growing cooldown', async () => {
  let status = 500, now = 1_000_000;
  const { c } = fetchContext({
    Date: Object.assign(class extends Date { static now() { return now; } }),
    fetch: async () => ({ ok: status < 400, status }),
  });
  const user = { method: 'GET', headers: new Headers({ Authorization: 'Bearer user-jwt' }) };
  await c.chatFetch('https://fixture.invalid/rest/v1/messages', user);
  assert.equal(c.dbUnderPressure(), true);
  now += 30001; assert.equal(c.dbUnderPressure(), false);
  await c.chatFetch('https://fixture.invalid/rest/v1/messages', user);
  now += 30001; assert.equal(c.dbUnderPressure(), true, 'the second overload waits longer');
  now += 30000; status = 200;
  await c.chatFetch('https://fixture.invalid/rest/v1/messages', user);
  status = 500; await c.chatFetch('https://fixture.invalid/rest/v1/messages', user);
  now += 30001; assert.equal(c.dbUnderPressure(), false, 'a healthy response resets the backoff');
});

test('Realtime recovery is jittered, keeps its backoff until stable, and throttles list re-reads', () => {
  const schedule = section('    function scheduleRealtimeRecover()', '    async function refreshSessionQuiet()');
  assert.match(schedule, /Math\.random\(\)/);
  const recover = section('    async function recoverRealtime()', '    async function wakeAndSync()');
  assert.match(recover, /RECOVERY_LIST_MIN_MS/);
  assert.match(recover, /if \(!await refreshSessionQuiet\(\)\)/);
  assert.doesNotMatch(section('    function setupRealtime()', '    function setupLivePresence('), /realtimeRecoverAttempt = 0/);
});

function readContext(cache = [], lastReadAt = {}) {
  const c = vm.createContext({ Date, Number, String, msgCache: new Map([['c:general', cache]]), lastReadAt,
    inbox: [], unreadCounts: new Map(), me: { username: 'alice' }, saves: 0 });
  vm.runInContext(section('    function timestampMicros(', '    let lastReadSave = null;'), c);
  vm.runInContext(`function saveLastReadSoon() { saves++; } function saveInbox() {} function patchChannelUnread() {} function renderDmList() {} function updateTabBadge() {}`, c);
  vm.runInContext(section('    function markViewRead(', '    /* ============================= 11. CONTENT RENDERING'), c);
  return c;
}

test('read cursors keep microseconds, so the last message read is not counted as unread', () => {
  const c = readContext();
  const last = '2026-11-10T22:26:05.123456+00:00';
  assert.equal(c.readAfter(last, last), false, 'a message is not newer than its own cursor');
  assert.equal(c.readAfter('2026-11-10T22:26:05.123457+00:00', last), true, 'one microsecond later is newer');
  assert.equal(c.readAfter('2026-11-10T22:26:05.123+00:00', last), false);
  assert.equal(c.readAfter(last, null), true, 'no cursor: unread');
  const hydrate = section('    let unreadHydration =', '    async function hydrateChannelUnreadsLegacy(');
  assert.doesNotMatch(hydrate, /new Date\(readAt\)\.toISOString\(\)/, 'the server receives the stored cursor unchanged');
  assert.match(hydrate, /String\(readAt\)/);
});

test('a read cursor only moves forward and never falls back to this device clock', () => {
  const newer = '2026-11-10T22:26:05.123456+00:00', older = '2026-11-10T22:20:00.000001+00:00';
  const c = readContext([{ id: 'old', created_at: older }], { 'c:general': newer });
  c.markViewRead('c:general');
  assert.equal(c.lastReadAt['c:general'], newer, 'an older page does not unread newer messages');
  const empty = readContext([], { 'c:general': newer });
  assert.equal(empty.readStampFor('c:general'), newer, 'no loaded rows: keep the cursor');
  const forward = readContext([{ id: 'new', created_at: '2026-11-10T22:30:00.000001+00:00' }], { 'c:general': newer });
  forward.markViewRead('c:general');
  assert.equal(forward.lastReadAt['c:general'], '2026-11-10T22:30:00.000001+00:00');
});

test('a live delivery of an already read message does not add an unread badge', () => {
  const ingest = section('    function ingestMessage(', '    function autogrow(');
  assert.match(ingest, /readAfter\(m\.created_at, lastReadAt\[unreadKey\]\)/);
  assert.match(section('    async function loadFreshViewMessages(', '    function ingestMessage('), /readAfter\(row\.created_at, lastReadAt\[key\]\)/);
});
