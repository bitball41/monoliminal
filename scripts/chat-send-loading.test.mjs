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
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('boot paints and opens the first conversation while optional services remain stalled', async () => {
  const calls = [], extras = deferred();
  const c = vm.createContext({
    me: null, profiles: new Map(), channels: [{ id: 'general' }], activeLayout: 'classic',
    Date, LS: { get() {} }, $: () => ({ hidden: true }),
    appSettings: {}, isOwner: () => false, channelIsHome: () => true,
    loadAppSettings: async () => {}, loadProfiles: async () => {}, loadChannels: async () => {},
    loadAccountInbox() {}, lastListRefreshAt: 0,
    setupRealtime() { calls.push('live'); }, openView: async () => { calls.push('history'); },
    loadChatExtras() { calls.push('extras'); return extras.promise; },
    finishStartup() { calls.push('paint'); },
    setTimeout() {},
  });
  for (const name of ['startPerformanceDiagnostics','restoreChatBackground','renderSelf','renderChannels',
    'renderDmList','renderMembers','renderAnnouncement','updateAdminUi','applyFeatureControls',
    'startTimers','startChatActivity','updateTimeoutUi','maybeShowWhatsNew']) c[name] = () => {};
  vm.runInContext(section('    async function bootApp(', '    async function runChatLoads('), c);
  await c.bootApp({ username: 'alice' });
  assert.deepEqual(calls, ['paint', 'live', 'history', 'extras']);
});

test('settings loads share one request across launcher, session restore and app boot', async () => {
  let calls = 0;
  const reply = deferred();
  const c = vm.createContext({ Date, appSettings: {}, bannedWords: [], syncCoOwnerRegistry() {}, primeAppUpdateMarker() {},
    sb: { from() { calls++; return { select: () => ({ retry: () => reply.promise }) }; } },
  });
  vm.runInContext(section('    let appSettingsLoad =', '    function applyFeatureControls('), c);
  const jobs = [c.loadAppSettings(), c.loadAppSettings(), c.loadAppSettings()];
  assert.equal(calls, 1);
  reply.resolve({ data: [{ key: 'messages_enabled', value: 'true' }] });
  await Promise.all(jobs); await c.loadAppSettings();
  assert.equal(calls, 1);
  assert.equal(c.appSettings.messages_enabled, 'true');
});

test('message reads time out, preserve an existing cancellation, and leave mutations to their own handler', async () => {
  const requests = [];
  const c = vm.createContext({ URL, AbortSignal, performance, fetch: async (input, options) => { requests.push({ input, options }); return {}; } });
  vm.runInContext(section('    const CHAT_READ_TIMEOUT_MS =', '    function missingSchema('), c);
  const cancel = new AbortController();
  await c.chatFetch('https://fixture.invalid/rest/v1/messages', { method: 'GET', signal: cancel.signal });
  assert(requests[0].options.signal);
  cancel.abort(); assert(requests[0].options.signal.aborted);
  await c.chatFetch('https://fixture.invalid/rest/v1/rpc/chat_get_my_profile', { method: 'POST' });
  assert(requests[1].options.signal);
  await c.chatFetch('https://fixture.invalid/rest/v1/messages', { method: 'POST' });
  assert.equal(requests[2].options.signal, undefined);
});

test('one unread request covers all channels, coalesces refreshes and preserves reads and live arrivals', async () => {
  let calls = 0, release, now = 1_000_000;
  const c = vm.createContext({ console, Date: Object.assign(class extends Date { static now() { return now; } }), me: { username: 'alice' },
    channels: Array.from({ length: 8 }, (_, n) => ({ id: String(n), kind: 'chat' })),
    channelIsVisible: () => true, lastReadAt: {}, unreadCounts: new Map([['c:2', 5]]), updateTabBadge() {},
    forumThreadBoard: new Map(), realtimeHealthy: () => true, LIST_RECONCILE_MS: 300000,
    missingSchema: () => false, logChatWarning() {},
    sb: { rpc(name, args) {
      assert.equal(name, 'chat_unread_counts'); assert.equal(Object.keys(args.p_read_cursors).length, 8); calls++;
      return new Promise(resolve => { release = () => resolve({ data: c.channels.map(ch => ({ channel_id: ch.id, unread_count: ch.id === '2' ? 5 : 100, thread_ids: [] })) }); });
    } },
  });
  vm.runInContext(section('    let unreadHydration =', '    async function hydrateChannelUnreadsLegacy('), c);
  const work = c.hydrateChannelUnreads(), duplicate = c.hydrateChannelUnreads();
  assert.equal(calls, 1);
  c.lastReadAt['c:0'] = 'just-opened'; c.unreadCounts.set('c:2', 6);
  release(); await Promise.all([work, duplicate]);
  assert.equal(c.unreadCounts.has('c:0'), false);
  assert.equal(c.unreadCounts.get('c:1'), 100); assert.equal(c.unreadCounts.get('c:2'), 6);
  await c.hydrateChannelUnreads(); assert.equal(calls, 1, 'healthy unchanged state reuses its reconciliation');
  now += 300001; const later = c.hydrateChannelUnreads(); assert.equal(calls, 2); release(); await later;
});

test('ambiguous writes and duplicate retry IDs recover the committed row instead of sending another message', async () => {
  for (const error of [{ code: '', message: 'timeout' }, { code: '23505' }]) {
    const inserted = [], lookedUp = [];
    const row = { id: 'same-message-id', content: 'hello' };
    const c = vm.createContext({ AbortSignal, sb: { from() {
      let writing = false;
      const q = { insert(value) { inserted.push(value); writing = true; return q; }, select() { return q; },
        single() { return q; }, abortSignal(signal) { assert(signal); return Promise.resolve({ error, status: 0 }); },
        eq(key, value) { assert(!writing); assert.equal(key, 'id'); lookedUp.push(value); return q; },
        maybeSingle() { return q; }, retry: () => Promise.resolve({ data: row }) };
      return q;
    } } });
    vm.runInContext(section('    async function insertChatMessage(', '    async function sendMessage('), c);
    assert.equal((await c.insertChatMessage('messages', row, 'id')).data, row);
    assert.equal(inserted.length, 1); assert.deepEqual(lookedUp, [row.id]);
  }
});

test('equal messages arriving out of order resolve their own placeholders; late success repairs a failed bubble', () => {
  const key = 'c:general', a = { id: 'pending:a', clientMessageId: 'a' }, b = { id: 'pending:b', clientMessageId: 'b' };
  const entries = [a, b].map(row => ({ tempId: row.id, serverId: row.clientMessageId, key, content: 'same', type: 'text', media_url: '' }));
  const c = vm.createContext({ me: { username: 'alice' }, msgCache: new Map([[key, [a, b]]]), pendingSends: entries,
    currentView: {}, viewKey: () => 'other', unindexMessage() {}, indexMessage() {},
  });
  vm.runInContext(section('    function pendingKeyFor(', '    function beginPendingSend(') + '\n' +
    section('    function resolvePendingSend(', '    function rememberId('), c);
  assert(c.resolvePendingSend({ id: 'b', sender: 'alice', channel_id: 'general', content: 'same' }, 'channel'));
  assert.equal(c.msgCache.get(key)[0], a); assert.equal(c.msgCache.get(key)[1].id, 'b');
  assert(entries[0].serverId === 'a');
  entries.length = 0; a.failed = true;
  assert(c.resolvePendingSend({ id: 'a', sender: 'alice', channel_id: 'general', content: 'same' }, 'channel'));
  assert.deepEqual(c.msgCache.get(key).map(row => row.id), ['a', 'b']);
});

test('history responses retain a message sent or confirmed while the request was in flight', () => {
  const c = vm.createContext({ msgCache: new Map([['c:general', [{ id: 'pending:1', created_at: '2', pending: true }]]]),
    rememberId() {}, resolvePendingSend() {}, setViewMessages(key, rows) { c.msgCache.set(key, rows); } });
  vm.runInContext(section('    const loadingViewKeys =', '    async function loadFreshViewMessages('), c);
  c.holdLiveMessage('c:general', { id: 'live', created_at: '3' });
  assert.deepEqual(Array.from(c.commitLoadedView('c:general', [{ id: 'old', created_at: '1' }]), row => row.id), ['old', 'pending:1', 'live']);
});

test('a history response confirming an optimistic message removes its placeholder without duplicating the row', () => {
  const key = 'c:general', pending = { tempId: 'pending:1', serverId: 'confirmed', key };
  const c = vm.createContext({ me: { username: 'alice' }, currentView: {}, viewKey: () => 'other',
    msgCache: new Map([[key, [{ id: 'pending:1', clientMessageId: 'confirmed', pending: true, created_at: '2' }]]]),
    pendingSends: [pending], unindexMessage() {}, indexMessage() {}, rememberId() {},
    setViewMessages(key, rows) { c.msgCache.set(key, rows); } });
  vm.runInContext(section('    function pendingKeyFor(', '    function beginPendingSend(') + '\n' +
    section('    function resolvePendingSend(', '    function rememberId(') + '\n' +
    section('    const loadingViewKeys =', '    async function loadFreshViewMessages('), c);
  const rows = c.commitLoadedView(key, [{ id: 'confirmed', channel_id: 'general', sender: 'alice', created_at: '1' }]);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'confirmed');
  assert.equal(pending.confirmed, true); assert.equal(c.pendingSends.length, 0);
});
