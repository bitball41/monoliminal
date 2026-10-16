import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
function section(start, end) {
  const from = chat.indexOf(start), to = chat.indexOf(end, from);
  assert(from >= 0 && to > from, `application section exists: ${start}`);
  return chat.slice(from, to);
}

function messages(lite = false) {
  const context = vm.createContext({
    msgCache: new Map(), msgById: new Map(), pollCache: new Map(), pollBusy: new Set(),
    historyContexts: new Map(), isLiteMode: () => lite,
    hasMoreMap: new Map(), viewKey: view => view.key,
    currentView: { key: 'c:general' }, dms: [],
    updateMessageNode() { context.bubbleUpdates++; }, bubbleUpdates: 0,
    renderDmReceipt() { context.receiptUpdates++; }, receiptUpdates: 0,
    renderDmList() {}, $: () => ({ open: false }),
  });
  vm.runInContext(
    section('    function indexMessage(', '    function profileOf(') + '\n' +
    section('    const LIVE_MESSAGE_CAP =', '    function trimTimelineToCache(') + '\n' +
    section('    function messageRenderChanged(', '    function deleteMessage(') + '\n' +
    section('    function clearHistoryContexts(', '    function timelineHasMessage('), context);
  return context;
}

for (const lite of [false, true]) {
  test(`a long ${lite ? 'lite' : 'standard'} session releases trimmed message and poll objects`, () => {
    const c = messages(lite), key = 'c:general';
    c.setViewMessages(key, []);
    for (let i = 0; i < 10_000; i++) {
      const row = { id: i, content: `Message ${i}` };
      c.msgCache.get(key).push(row);
      c.indexMessage(row);
      c.pollCache.set(i, { message_id: i });
      c.pollBusy.add(i);
      c.trimLiveCache(key);
    }
    const rows = c.msgCache.get(key);
    assert(rows.length <= (lite ? 100 : 200) + 50);
    assert.equal(c.msgById.size, rows.length * 2, 'numeric and string aliases are both bounded');
    assert.equal(c.pollCache.size, rows.length);
    assert.equal(c.pollBusy.size, rows.length);
    assert.equal(c.findCachedMessage(0), null);
    assert.equal(c.findCachedMessage('9999'), rows.at(-1));
    assert.equal(c.hasMoreMap.get(key), true);
  });
}

test('trimming preserves unsent content and an open history window until it is closed', () => {
  const c = messages(), key = 'c:general';
  const rows = Array.from({ length: 251 }, (_, id) => ({ id: String(id) }));
  rows[0].pending = true;
  rows[1].failed = true;
  c.setViewMessages(key, rows);
  const historical = { ...rows[2], content: 'Open history' };
  c.historyContexts.set(key, { rows: [historical] });
  c.indexMessage(historical);
  c.pollCache.set('2', { message_id: '2' });
  c.trimLiveCache(key);
  assert.equal(c.msgCache.get(key).length, 202);
  assert.equal(c.findCachedMessage('0').pending, true);
  assert.equal(c.findCachedMessage('1').failed, true);
  assert.equal(c.findCachedMessage('2'), historical);
  assert(c.pollCache.has('2'));
  c.clearHistoryContexts();
  assert.equal(c.findCachedMessage('2'), null);
  assert.equal(c.msgById.size, 202);
});

test('DM read receipts update cached data without rebuilding the message bubble', () => {
  const c = messages(), key = 'dm:conversation';
  c.currentView.key = key;
  const row = { id: 'message', dm_id: 'conversation', content: 'Hi', type: 'text', read_by: ['alice'], reactions: { '👍': ['alice'] } };
  c.setViewMessages(key, [row]);
  const read = structuredClone(row);
  read.read_by.push('bob');
  c.patchCachedMessage(read);
  assert.equal(c.bubbleUpdates, 0);
  assert.equal(c.receiptUpdates, 1);
  assert.equal(c.findCachedMessage(row.id), read);
  assert.deepEqual(c.msgCache.get(key)[0].read_by, ['alice', 'bob']);
  c.patchCachedMessage({ ...read, content: 'Edited', edited: true });
  assert.equal(c.bubbleUpdates, 1);
  c.patchCachedMessage({ ...read, reactions: { '👍': ['alice', 'bob'] } });
  assert.equal(c.bubbleUpdates, 2);
});

function conversations() {
  let now = 1_000_000, requests = 0;
  const c = vm.createContext({
    console, Date: { now: () => now }, me: {}, sb: {},
    presenceStopped: false, presenceLeft: false,
    document: { visibilityState: 'visible' }, navigator: { onLine: true },
    healthy: true, realtimeHealthy: () => c.healthy,
    LIST_RECONCILE_MS: 300_000, DM_RECONCILE_MS: 20_000, lastConversationRefreshAt: 0, conversationRefresh: null,
    currentView: { type: 'channel', id: 'general' },
    loadDms: async () => { requests++; }, loadGroupInvites: async () => {},
    renderDmList() {}, renderConversationHeader() {}, applyFeatureControls() {}, groupDialogId: null,
  });
  vm.runInContext(section('    async function refreshConversations(', '    async function queueConversationRefresh('), c);
  return { c, advance: ms => { now += ms; }, requests: () => requests };
}

test('healthy conversation reconciliation reduces idle requests and still responds to membership events immediately', async () => {
  const p = conversations();
  await p.c.refreshConversations();
  for (let tick = 0; tick < 10; tick++) {
    p.advance(30_000);
    await p.c.refreshConversations({ periodic: true });
  }
  assert.equal(p.requests(), 2, 'initial load and one reconciliation in five minutes');
  await p.c.refreshConversations();
  assert.equal(p.requests(), 3, 'a membership event bypasses the periodic throttle');
  p.c.healthy = false;
  p.advance(30_000);
  await p.c.refreshConversations({ periodic: true });
  assert.equal(p.requests(), 4, 'a disconnected client retains the short fallback');
});

test('background, offline and departed clients stop periodic conversation reads', async () => {
  for (const disable of [
    c => { c.document.visibilityState = 'hidden'; },
    c => { c.navigator.onLine = false; },
    c => { c.presenceStopped = true; },
    c => { c.presenceLeft = true; },
  ]) {
    const p = conversations();
    disable(p.c);
    await p.c.refreshConversations({ periodic: true });
    assert.equal(p.requests(), 0);
  }
});

test('an open DM preserves the short membership check while Realtime remains healthy', async () => {
  const p = conversations();
  p.c.currentView = { type: 'dm', id: 'group' };
  await p.c.refreshConversations();
  p.advance(30_000);
  await p.c.refreshConversations({ periodic: true });
  assert.equal(p.requests(), 2);
});

test('a failed conversation read keeps the short retry and overlapping reads share the request', async () => {
  const p = conversations();
  let finish, reads = 0;
  p.c.loadDms = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  const first = p.c.refreshConversations(), second = p.c.refreshConversations();
  assert.equal(reads, 1);
  finish(false);
  await Promise.all([first, second]);
  p.advance(30_000);
  const retry = p.c.refreshConversations({ periodic: true });
  assert.equal(reads, 2);
  finish(true);
  await retry;
});

test('Dot Field sleeps when settled, resumes for input and themes, and releases its listeners', () => {
  let sequence = 0, now = 1000, paints = 0, gradients = 0, removed = false;
  const frames = new Map(), listeners = new Map(), observers = [];
  const surface = id => ({
    hidden: false, isConnected: true,
    append() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    addEventListener: (type, fn) => listeners.set(`${id}:${type}`, fn),
    removeEventListener: type => listeners.delete(`${id}:${type}`),
  });
  const stage = surface('stage'), pointer = surface('pointer'), timeline = surface('timeline');
  const drawing = { setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, arc() {},
    fill() { paints++; }, createLinearGradient() { gradients++; return { addColorStop() {} }; } };
  const document = { ...surface('document'), hidden: false,
    createElement: () => ({ setAttribute() {}, getContext: () => drawing, remove() { removed = true; } }) };
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {} disconnect() { this.disconnected = true; }
  }
  const c = vm.createContext({
    document, ResizeObserver: Observer, MutationObserver: Observer, devicePixelRatio: 1,
    $: id => id === 'chat-background-stage' ? stage : id === 'timeline' ? timeline : pointer,
    me: { username: 'alice' }, chatBackgroundChoice: 'dotField', chatBackgroundOwner: 'alice',
    backgroundPalette: () => ({ primary: '#000000', secondary: '#ffffff', light: false }),
    backgroundCSSColor: hex => hex,
    requestAnimationFrame(fn) { const id = ++sequence; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  vm.runInContext(section('    function createDotFieldBackground()', '    /* ============================= 5. STATE'), c);
  const background = c.createDotFieldBackground();
  const settle = () => {
    let count = 0;
    while (frames.size && count++ < 500) {
      now += 40;
      const pending = Array.from(frames.values()); frames.clear();
      pending.forEach(frame => frame(now));
    }
    assert.equal(frames.size, 0, 'a stationary field stops scheduling frames');
  };
  settle();
  assert.equal(paints, 1);
  listeners.get('pointer:pointermove')({ clientX: 200, clientY: 150 });
  settle();
  assert(paints > 2, 'pointer movement animates before settling');
  assert.equal(gradients, 1, 'the gradient is reused across animation frames');
  background.updateTheme();
  assert.equal(frames.size, 1);
  settle();
  assert.equal(gradients, 2);
  listeners.get('pointer:pointermove')({ clientX: 220, clientY: 180 });
  document.hidden = true;
  listeners.get('document:visibilitychange')();
  assert.equal(frames.size, 0, 'hidden tabs cancel the outstanding frame');
  document.hidden = false;
  listeners.get('document:visibilitychange')();
  assert.equal(frames.size, 1);
  background.destroy();
  assert.equal(frames.size, 0);
  assert.equal(listeners.size, 0);
  assert(observers.every(observer => observer.disconnected));
  assert(removed);
});
