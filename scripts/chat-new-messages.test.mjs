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
function fixture() {
  const nodes = new Map(['new-msgs-badge', 'new-msgs-count', 'viewing-older', 'jump-present-btn']
    .map(id => [id, { hidden: true, disabled: false, textContent: '' }]));
  const c = vm.createContext({
    $: id => { assert(nodes.has(id), `existing control: ${id}`); return nodes.get(id); },
    currentView: { key: 'c:general', type: 'channel' }, viewKey: view => view.key,
    historyContexts: new Map(), msgCache: new Map(), messageLoadErrors: new Map(),
    isNearBottom: () => c.near, near: false, timelineHeld: () => false,
    releaseBottomPin() { vm.runInContext('stickyToBottom = false', c); },
    loadHistoryPage(direction) { c.pages.push(direction); }, pages: [],
    markViewRead(key) { c.reads.push(key); }, reads: [],
    scrollToBottom() { vm.runInContext('stickyToBottom = true', c); },
    fetchMessages: async () => [], clearHistoryContexts() { c.historyContexts.clear(); },
    setViewMessages(key, rows) { c.msgCache.set(key, rows); }, markDmRead() {},
    renderTimeline(options) { c.renders.push(options?.preserve ? 'preserve' : 'rebuild'); }, renders: [],
    hasMoreMap: new Map(), trimLiveCache() { return false; },
  });
  vm.runInContext('let pendingNewCount = 0, stickyToBottom = false, applyingPin = false, timelineHoldUntil = 0, messageJumpRequest = 0;\n' +
    section('    function hideNewBadge()', '    // Long-lived tabs otherwise keep every live message') + '\n' +
    section('    async function returnToLatest()', '    /* ============================= 38. EVENT WIRING'), c);
  // By default the page being read ends before anything the live cache holds.
  return { c, nodes, history(rows = [{ id: 'h', created_at: '2026-10-21T11:00:00Z' }], extra = {}) {
    c.historyContexts.set('c:general', { rows, hasOlder: true, hasNewer: true, busy: false, ...extra });
  } };
}

test('scrolling and incoming messages share mutually exclusive existing indicators', () => {
  const { c, nodes, history } = fixture();
  c.updateViewingOlder(false);
  assert.equal(nodes.get('viewing-older').hidden, false);
  assert.equal(nodes.get('new-msgs-badge').hidden, true);
  history();
  for (let i = 0; i < 3; i++) c.bumpNewBadge();
  assert.equal(nodes.get('viewing-older').hidden, true);
  assert.equal(nodes.get('new-msgs-badge').hidden, false);
  assert.equal(nodes.get('new-msgs-count').textContent, 3);
});

test('history keeps Jump To Present available even at the bottom of its loaded page', () => {
  const { c, nodes, history } = fixture();
  history(); c.near = true; c.updateTimelineReadState(true, false);
  assert.equal(nodes.get('viewing-older').hidden, false);
  assert.equal(nodes.get('new-msgs-badge').hidden, true);
  assert.equal(c.reads.length, 0);
});

test('reaching a historical page end preserves unread count and loads newer rows on downward scroll', () => {
  const { c, nodes, history } = fixture();
  history(); c.bumpNewBadge(); c.near = true;
  c.updateTimelineReadState(true, true);
  assert.equal(nodes.get('new-msgs-badge').hidden, false);
  assert.equal(nodes.get('new-msgs-count').textContent, 1);
  assert.equal(c.reads.length, 0);
  assert.deepEqual(c.pages, ['newer']);
  c.historyContexts.get('c:general').busy = true;
  c.updateTimelineReadState(true, true);
  assert.equal(c.pages.length, 1);
});

test('reading the live bottom clears the count and both indicators', () => {
  const { c, nodes } = fixture();
  c.bumpNewBadge(); c.near = true; c.updateTimelineReadState(true, true);
  assert.equal(nodes.get('new-msgs-badge').hidden, true);
  assert.equal(nodes.get('viewing-older').hidden, true);
  assert.deepEqual(c.reads, ['c:general']);
});

test('failed return to latest preserves unread state and re-enables both existing buttons', async () => {
  const { c, nodes, history } = fixture();
  history(); c.bumpNewBadge();
  c.fetchMessages = async () => { c.messageLoadErrors.set('c:general', Error('offline')); return []; };
  assert.equal(await c.returnToLatest(), false);
  assert(c.historyContexts.has('c:general'));
  assert.equal(nodes.get('new-msgs-badge').hidden, false);
  assert.equal(nodes.get('new-msgs-badge').disabled, false);
  assert.equal(nodes.get('jump-present-btn').disabled, false);
  assert.equal(c.reads.length, 0);
});

test('return to latest merges arrivals during the fetch and clears the history indicators', async () => {
  const { c, nodes, history } = fixture();
  history(); c.bumpNewBadge();
  c.fetchMessages = async () => {
    c.msgCache.set('c:general', [{ id: 'b', created_at: '2026-10-21T12:01:00Z' }]);
    return [{ id: 'a', created_at: '2026-10-21T12:00:00Z' }];
  };
  assert.equal(await c.returnToLatest(), true);
  assert.equal(c.historyContexts.size, 0);
  assert.deepEqual(Array.from(c.msgCache.get('c:general'), row => row.id), ['a', 'b']);
  assert.equal(nodes.get('viewing-older').hidden, true);
  assert.equal(nodes.get('new-msgs-badge').hidden, true);
});

const row = (id, minute, extra = {}) => ({ id, created_at: `2026-10-21T12:${String(minute).padStart(2, '0')}:00Z`, ...extra });

test('scrolling back to a page the live cache continues rejoins live mode without a fetch or rebuild', () => {
  const { c, nodes, history } = fixture();
  history([row('a', 0), row('b', 1)]);
  c.msgCache.set('c:general', [row('b', 1), row('c', 2)]);
  c.bumpNewBadge(); c.near = true;
  c.updateTimelineReadState(true, true);
  assert.equal(c.historyContexts.size, 0);
  assert.deepEqual(Array.from(c.msgCache.get('c:general'), m => m.id), ['a', 'b', 'c']);
  assert.deepEqual(c.pages, [], 'no network page for rows the live cache already has');
  assert.deepEqual(c.renders, ['preserve'], 'mounted rows are reconciled, not rebuilt');
  assert.equal(vm.runInContext('stickyToBottom', c), true);
  assert.deepEqual(c.reads, ['c:general']);
  assert.equal(nodes.get('new-msgs-badge').hidden, true);
  assert.equal(nodes.get('viewing-older').hidden, true);
  assert.equal(c.hasMoreMap.get('c:general'), true, 'older history stays reachable');
});

test('rejoining keeps late rows in time order and unsent rows last', () => {
  const { c, history } = fixture();
  history([row('a', 0), row('c', 2)], { hasOlder: false });
  c.msgCache.set('c:general', [row('c', 2), row('d', 3), row('p', 9, { pending: true }), row('late', 1)]);
  c.near = true;
  c.updateTimelineReadState(true, true);
  assert.deepEqual(Array.from(c.msgCache.get('c:general'), m => m.id), ['a', 'late', 'c', 'd', 'p']);
  assert.equal(c.hasMoreMap.get('c:general'), false);
});

test('a page that ends before the live cache, a busy page, or a held timeline stays in history', () => {
  const { c, history } = fixture();
  history([row('a', 0)]);
  c.msgCache.set('c:general', [row('x', 30), row('y', 31)]);
  c.near = true;
  c.updateTimelineReadState(true, true);
  assert(c.historyContexts.has('c:general'));
  assert.deepEqual(c.pages, ['newer']);
  c.msgCache.set('c:general', [row('a', 0), row('b', 1)]);
  c.historyContexts.get('c:general').busy = true;
  c.updateTimelineReadState(true, true);
  c.historyContexts.get('c:general').busy = false;
  c.timelineHeld = () => true;
  c.updateTimelineReadState(true, true);
  assert(c.historyContexts.has('c:general'), 'an anchored jump is not pulled to the bottom');
});

test('jump to present reuses a live cache that continues the page instead of refetching', async () => {
  const { c, history } = fixture();
  history([row('a', 0), row('b', 1)]);
  c.msgCache.set('c:general', [row('b', 1), row('c', 2)]);
  c.fetchMessages = async () => { throw Error('should not refetch'); };
  assert.equal(await c.returnToLatest(), true);
  assert.equal(c.historyContexts.size, 0);
  assert.deepEqual(Array.from(c.msgCache.get('c:general'), m => m.id), ['a', 'b', 'c']);
  assert.deepEqual(c.renders, ['preserve']);
});

test('an incoming message at the bottom of a history page rejoins instead of badging', () => {
  const source = section('    function ingestMessage(m, kind)', "      if (kind !== 'dm' && m.type === 'poll'");
  assert.match(source, /if \(readingContext && isNearBottom\(\) && !timelineHeld\(\) && rejoinLiveFromHistory\(key\)\) \{\s*readingContext = false;/);
  const page = section('    async function loadHistoryPage(direction)', '    async function returnToLatest()');
  assert.match(page, /if \(!older && historyContexts\.get\(key\) === context && viewKey\(currentView\) === key && isNearBottom\(\)\) rejoinLiveFromHistory\(key\);/);
});

test('duplicate history controls are absent and both existing buttons return to latest', () => {
  assert.doesNotMatch(chat, /history-context-bar|history-newer|history-latest/);
  for (const id of ['new-msgs-badge', 'jump-present-btn']) {
    assert(chat.includes(`$('${id}').addEventListener('click', returnToLatest)`));
  }
});
