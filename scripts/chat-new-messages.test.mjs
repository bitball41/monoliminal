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
    setViewMessages(key, rows) { c.msgCache.set(key, rows); }, renderTimeline() {}, markDmRead() {},
  });
  vm.runInContext('let pendingNewCount = 0, stickyToBottom = false, applyingPin = false, timelineHoldUntil = 0, messageJumpRequest = 0;\n' +
    section('    function hideNewBadge()', '    // Long-lived tabs otherwise keep every live message') + '\n' +
    section('    async function returnToLatest()', '    /* ============================= 38. EVENT WIRING'), c);
  return { c, nodes, history() { c.historyContexts.set('c:general', { hasNewer: true, busy: false }); } };
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

test('duplicate history controls are absent and both existing buttons return to latest', () => {
  assert.doesNotMatch(chat, /history-context-bar|history-newer|history-latest/);
  for (const id of ['new-msgs-badge', 'jump-present-btn']) {
    assert(chat.includes(`$('${id}').addEventListener('click', returnToLatest)`));
  }
});
