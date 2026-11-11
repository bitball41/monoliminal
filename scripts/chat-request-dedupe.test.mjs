import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');

function section(start, end) {
  const from = chat.indexOf(start), to = chat.indexOf(end, from);
  assert(from >= 0 && to > from, `section ${start}`);
  return chat.slice(from, to);
}
const constant = name => chat.match(new RegExp(`    const ${name} = [^;]+;`))[0];

// The real wakeAndSync and catchUpPoll, with a counting message endpoint.
function wakeFixture() {
  let now = 10_000_000;
  const reads = [];
  const listeners = new Map();
  const c = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    document: { visibilityState: 'visible', addEventListener: (type, fn) => listeners.set(type, fn) },
    window: { addEventListener: (type, fn) => listeners.set(type, fn) },
    navigator: { onLine: true }, console,
    me: { username: 'fixture' }, presenceStopped: false, presenceLeft: false, presenceDegraded: false,
    currentView: { type: 'channel', id: 'general' }, VOICE_CHANNEL_ID: 'voice-chat',
    MESSAGE_COLUMNS: 'id,created_at', DM_MESSAGE_COLUMNS: 'id,created_at',
    msgCache: new Map(), viewKey: view => `c:${view.id}`, healthy: true,
    realtimeHealthy: () => c.healthy, ingestMessage() {}, notePerformanceWork() {},
    refreshSessionQuiet: async () => true, dbUnderPressure: () => false, recoverRealtime: async () => { reads.push('recover'); },
    ensureLivePresence() {}, refreshListsQuiet: async () => {}, scheduleRenderMembers() {},
    patchPresenceDots() {}, renderSelf() {}, retryTransientFailures: async () => {},
    snapshotComposer() {}, stopLivePresence() {}, stopPresenceFallback() {},
    lastListRefreshAt: now, LIST_RECONCILE_MS: 300000,
    sb: { from: () => {
      const query = { select() { return query; }, eq() { return query; }, gte() { return query; },
        order() { return query; }, limit: async () => { reads.push('messages'); return { data: [] }; } };
      return query;
    } },
  });
  vm.runInContext([
    constant('MESSAGE_RECONCILE_MS'), constant('MESSAGE_FALLBACK_POLL_MS'), constant('DM_RECONCILE_MS'),
    constant('CATCH_UP_OVERLAP_MS'), constant('WAKE_CATCH_UP_AWAY_MS'),
    'var lastCatchUpPollAt = 0, catchUpPollPromise = null, wakeRunning = false, lastWakeAt = 0, pageAwaySince = 0;',
    section('    async function wakeAndSync()', '    function patchPresenceDots('),
    section('    function catchUpPoll(', '    function tickCooldown()'),
  ].join('\n'), c);
  return {
    c, reads, listeners,
    advance: ms => { now += ms; }, now: () => now,
    wake: async () => { await c.wakeAndSync(); },
  };
}

test('a focus wake with healthy Realtime does not re-read messages it already received', async () => {
  const p = wakeFixture();
  await p.wake();
  assert.deepEqual(p.reads, ['messages'], 'the first wake reconciles once');
  // Alt-tabbing back to Chat fires focus every few seconds; nothing was hidden.
  for (let i = 0; i < 19; i++) { p.advance(15_000); await p.wake(); }
  assert.equal(p.reads.length, 1, 'focus wakes inside the reconcile interval add no reads');
  p.advance(30_000);
  await p.wake();
  assert.equal(p.reads.length, 2, 'the normal interval still reconciles on a later wake');
});

test('a real absence still catches up immediately on return', async () => {
  const p = wakeFixture();
  await p.wake();
  p.c.pageAwaySince = 0;
  // A short tab switch: hidden for 10 seconds.
  p.advance(5_000); p.c.document.visibilityState = 'hidden'; p.c.pageAwaySince = p.now();
  p.advance(10_000); p.c.document.visibilityState = 'visible';
  await p.wake();
  assert.equal(p.reads.length, 1, 'a quick switch with a live socket needs no read');
  // Hidden for a minute.
  p.advance(5_000); p.c.document.visibilityState = 'hidden'; p.c.pageAwaySince = p.now();
  p.advance(60_000); p.c.document.visibilityState = 'visible';
  await p.wake();
  assert.equal(p.reads.length, 2, 'a long absence reads immediately');
  // Frozen or page-hidden: always read, however short.
  p.advance(5_000);
  p.c.onPageHidePresence();
  p.c.presenceLeft = false;
  await p.wake();
  assert.equal(p.reads.length, 3, 'a frozen page reads on resume');
  // Unhealthy Realtime is still recovered, which includes its own catch-up.
  p.advance(5_000);
  p.c.healthy = false;
  await p.wake();
  assert.deepEqual(p.reads.slice(-1), ['recover']);
});

test('a background online event keeps the absence until the page is visible', async () => {
  const p = wakeFixture();
  await p.wake();
  p.advance(5_000); p.c.document.visibilityState = 'hidden'; p.c.pageAwaySince = p.now();
  p.advance(60_000);
  await p.wake();
  assert.equal(p.reads.length, 2, 'a hidden wake reads, as before');
  assert.notEqual(p.c.pageAwaySince, 0, 'the absence is not consumed while hidden');
  p.advance(5_000); p.c.document.visibilityState = 'visible';
  await p.wake();
  assert.equal(p.reads.length, 3, 'returning to the page still reconciles');
});

function subscribeFixture() {
  let now = 1_000;
  const reads = [];
  const c = vm.createContext({
    Date: { now: () => now },
    reloadSubroleCatalog: () => { reads.push('subroles'); },
    queueConversationRefresh: () => { reads.push('conversations'); },
  });
  // Script-level bindings become context properties the test can set.
  vm.runInContext(section('    let realtimeAttemptAt = 0,', '    function setupRealtime()').replace(/\blet /g, 'var '), c);
  return { c, reads, advance: ms => { now += ms; }, now: () => now };
}

test('SUBSCRIBED does not repeat list reads that boot or recovery already started', () => {
  const p = subscribeFixture();
  const join = () => { p.c.realtimeAttemptAt = p.now(); };
  // Boot: the join starts before loadChatExtras reads the lists.
  p.c.chatExtrasPending = true; join(); p.advance(400);
  p.c.reconcileAfterSubscribe();
  assert.deepEqual(p.reads, [], 'boot extras read after the join');
  // The extras then read every list.
  p.c.chatExtrasPending = false;
  p.c.subroleReadStartedAt = p.c.dmListReadStartedAt = p.c.groupInviteReadStartedAt = p.now();
  // Recovery: a new join, and refreshListsQuiet reads conversations right after it.
  p.advance(60_000); join();
  p.c.dmListReadStartedAt = p.c.groupInviteReadStartedAt = p.now(); p.advance(500);
  p.c.reconcileAfterSubscribe();
  assert.deepEqual(p.reads, ['subroles'], 'only the catalog was not read for this join');
  // A rejoin after an error with no reads since: everything is reconciled.
  p.reads.length = 0; p.advance(60_000); join(); p.advance(500);
  p.c.reconcileAfterSubscribe();
  assert.deepEqual(p.reads, ['subroles', 'conversations']);
});

test('the realtime channel marks errors so a same-generation rejoin reconciles', () => {
  const realtime = section('    function realtimeChangeHandlers()', '    // Keep the existing topic');
  assert.match(realtime, /realtimeAttemptAt = Date\.now\(\);\s*\n\s*updateConnection\('connecting'\)/);
  const failure = realtime.slice(realtime.indexOf("status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'"));
  assert(failure.indexOf('realtimeAttemptAt = Date.now();') >= 0 && failure.indexOf('realtimeAttemptAt = Date.now();') < failure.indexOf('scheduleRealtimeRecover()'),
    'an error marks the attempt before recovering');
  assert.match(realtime, /reconcileAfterSubscribe\(\)/);
  assert.doesNotMatch(realtime, /reloadSubroleCatalog\(\);\s*\n\s*queueConversationRefresh\(\)/);
  for (const [fn, stamp] of [['loadSubroles', 'subroleReadStartedAt'], ['loadDms', 'dmListReadStartedAt'], ['loadGroupInvites', 'groupInviteReadStartedAt']]) {
    assert.match(section(`    async function ${fn}()`, '\n    }\n'), new RegExp(`${stamp} = Date\\.now\\(\\)`), `${fn} records when its read starts`);
  }
  const boot = section('    async function bootApp(', '    async function runChatLoads(');
  assert(boot.indexOf('chatExtrasPending = true') < boot.indexOf('setupRealtime()'));
  assert.match(section('    async function loadChatExtras(', '    function showStartupFailure('), /chatExtrasPending = false/);
});

test('opening a DM for the first time does not re-read the rows it just loaded', () => {
  const open = section('    async function openView(view) {', '    async function fetchMessages(');
  assert.match(open, /const cached = msgCache\.has\(key\);/);
  assert.match(open, /view\.type === 'dm' && cached && viewKey\(currentView\) === key\) catchUpPoll\(\)/);
});

test('an older page leaves the live window\'s has-more flag alone', async () => {
  const hasMoreMap = new Map([['c:general', true]]);
  const c = vm.createContext({
    PAGE_SIZE: 60, MESSAGE_COLUMNS: 'id', DM_MESSAGE_COLUMNS: 'id', hasMoreMap, messageLoadErrors: new Map(), newestSeenTs: null,
    viewKey: view => `c:${view.id}`, toast() {}, rememberId() {}, loadPollsForMessages: async () => {},
    sb: { from: () => {
      const query = { select() { return query; }, eq() { return query; }, lt() { return query; },
        order() { return query; }, limit() { return query; },
        retry: async () => ({ data: [{ id: 'a', created_at: '1' }] }) };
      return query;
    } },
  });
  vm.runInContext(section('    async function fetchMessages(', '    async function loadOlder('), c);
  const page = {};
  await c.fetchMessages({ type: 'channel', id: 'general' }, '2026-01-01', page);
  assert.equal(page.hasMore, false, 'a short older page has no more history');
  assert.equal(hasMoreMap.get('c:general'), true, 'the live window still offers Load older');
  await c.fetchMessages({ type: 'channel', id: 'general' }, null);
  assert.equal(hasMoreMap.get('c:general'), false, 'a fresh load still sets the live flag');
});

test('a banner without a saved position is centred, not pinned to the corner', () => {
  const c = vm.createContext({ JSON });
  vm.runInContext(section('    function cssBannerUrl(', '    function cropWindow('), c);
  const style = {};
  c.applyBannerStyle({ style }, JSON.stringify({ v: 1, url: 'https://x.invalid/b.png', zoom: 1, w: 640, h: 200 }));
  assert.equal(style.backgroundPosition, '50% 50%');
  c.applyBannerStyle({ style }, JSON.stringify({ v: 1, url: 'https://x.invalid/b.png', x: 0, y: 1 }));
  assert.equal(style.backgroundPosition, '0% 100%', 'saved edges are kept');
});

test('confirmed sends keep tail containment, dropped slurs stay out of the composer', () => {
  const resolve = section('    function resolvePendingSend(', '    function rememberId(');
  assert.match(resolve, /node\.replaceWith\([^\n]+\n(?:\s*\/\/[^\n]*\n)*\s*markTimelineTail\(\);\s*\n\s*paintUnreadMarker\(\);/);
  const send = section('    async function sendMessage(', '    const noelleRequests');
  assert.match(send, /verdict === 'silent'\) \{[^}]*return 'silent'; \}/);
  assert.match(section('    function deleteMessage(', '    function editLastOwnMessage('), /const table = msg\.dm_id \? 'dm_messages' : 'messages';/);
});
