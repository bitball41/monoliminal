import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
const launcher = await readFile(new URL('../Chat/liminal-chat-launcher.html', import.meta.url), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert(from >= 0 && to > from, 'application section exists');
  return source.slice(from, to);
}

function chatPolling() {
  let now = 1_000_000;
  const requests = [], received = [];
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    document: { visibilityState: 'visible' }, navigator: { onLine: true },
    me: { username: 'fixture' }, presenceStopped: false, presenceLeft: false,
    currentView: { type: 'channel', id: 'general' }, VOICE_CHANNEL_ID: 'voice',
    MESSAGE_COLUMNS: 'id,created_at', DM_MESSAGE_COLUMNS: 'id,created_at',
    msgCache: new Map(), viewKey: view => `${view.type}:${view.id}`,
    isLiteMode: () => false, healthy: true,
    realtimeHealthy: () => context.healthy,
    ingestMessage: (row, kind) => received.push({ row, kind }),
    reply: async () => ({ data: [] }),
    sb: { from(table) {
      const request = { table, filters: [] };
      const query = {
        select() { return this; },
        eq(column, value) { request.filters.push([column, value]); return this; },
        gt(column, value) { request.filters.push([column, value]); return this; },
        order() { return this; },
        limit(value) { request.limit = value; requests.push(request); return context.reply(); },
      };
      return query;
    } },
  });
  vm.runInContext([
    ...chat.matchAll(/    const MESSAGE_(?:RECONCILE_MS|FALLBACK_POLL_MS) = [^;]+;/g),
  ].map(match => match[0]).join('\n') + '\nlet lastCatchUpPollAt=0; let catchUpPollPromise=null;\n' +
    section(chat, '    function catchUpPoll(', '    function tickCooldown()'), context);
  return { context, requests, received, advance: ms => { now += ms; } };
}

test('healthy Chat reconciles periodically without polling for every realtime message', async () => {
  const p = chatPolling();
  await p.context.catchUpPoll();
  for (let tick = 0; tick < 30; tick++) {
    p.advance(20_000);
    await p.context.catchUpPoll({ periodic: true });
  }
  assert.equal(p.requests.length, 3, 'initial fetch plus two reconciliations in ten minutes');
  // A wake/reconnect still checks immediately, even inside the normal interval.
  await p.context.catchUpPoll();
  assert.equal(p.requests.length, 4);
});

test('Chat keeps a short message fallback when Realtime disconnects', async () => {
  const p = chatPolling();
  p.context.healthy = false;
  await p.context.catchUpPoll({ periodic: true });
  p.advance(19_000);
  await p.context.catchUpPoll({ periodic: true });
  assert.equal(p.requests.length, 1);
  p.advance(1_000);
  await p.context.catchUpPoll({ periodic: true });
  assert.equal(p.requests.length, 2);
});

test('periodic message polling stops for hidden, offline, closed and signed-out clients', async () => {
  for (const disable of [
    c => { c.document.visibilityState = 'hidden'; },
    c => { c.navigator.onLine = false; },
    c => { c.presenceStopped = true; },
    c => { c.presenceLeft = true; },
    c => { c.me = null; },
    c => { c.currentView = { type: 'forum', id: 'board' }; },
    c => { c.currentView = { type: 'channel', id: 'voice' }; },
  ]) {
    const p = chatPolling();
    disable(p.context);
    await p.context.catchUpPoll({ periodic: true });
    assert.equal(p.requests.length, 0);
  }
});

test('overlapping catch-ups share a request and retain the original message type on a view change', async () => {
  const p = chatPolling();
  let finish;
  p.context.reply = () => new Promise(resolve => { finish = resolve; });
  const first = p.context.catchUpPoll();
  const second = p.context.catchUpPoll();
  assert.equal(first, second);
  assert.equal(p.requests.length, 1);
  p.context.currentView = { type: 'dm', id: 'another-view' };
  finish({ data: [{ id: 'message', channel_id: 'general' }] });
  await first;
  assert.equal(p.received[0].kind, 'channel');
  p.context.reply = async () => ({ data: [] });
  await p.context.catchUpPoll();
  assert.equal(p.requests[1].table, 'dm_messages');
  assert.deepEqual(p.requests[1].filters, [['dm_id', 'another-view']]);
});

test('a failed message request does not leave polling locked', async () => {
  const p = chatPolling();
  p.context.reply = async () => { throw new Error('network unavailable'); };
  await p.context.catchUpPoll();
  p.context.reply = async () => ({ data: [] });
  await p.context.catchUpPoll();
  assert.equal(p.requests.length, 2);
});

function launcherPolling() {
  let now = 1_000_000, status, changed;
  const reads = [], reloads = [], timers = [], listeners = new Map();
  const client = {
    from(table) {
      const query = {
        select() { return this; }, eq() { return this; },
        maybeSingle() { reads.push(table); return context.reply(); },
      };
      return query;
    },
    channel() {
      return {
        on(type, filter, callback) { changed = callback; return this; },
        subscribe(callback) { status = callback; return this; },
      };
    },
  };
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    document: { visibilityState: 'visible', addEventListener: (type, fn) => listeners.set(type, fn) },
    navigator: { onLine: true },
    window: { supabase: { createClient: () => client }, liminalControlClient: client,
      addEventListener: (type, fn) => listeners.set(type, fn) },
    SUPABASE_URL: 'https://fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key',
    requestForceRefresh: value => reloads.push(value),
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    reply: async () => ({ data: { value: 'existing-deployment' } }),
  });
  vm.runInContext(section(launcher, 'let lastRefreshSignal=', 'let mediaRequest=') + '\n' +
    section(launcher, 'function checkForceRefresh(', 'async function boot('), context);
  return { context, reads, reloads, timers, listeners,
    status: value => status(value), changed: row => changed({ new: row }),
    advance: ms => { now += ms; } };
}

test('launcher uses Realtime for immediate updates and a low-frequency HTTP safety check', async () => {
  const p = launcherPolling();
  await p.context.watchForceRefresh();
  assert.equal(p.reloads.length, 0, 'initial value becomes a baseline instead of reloading');
  p.status('SUBSCRIBED');
  await p.context.checkForceRefresh();
  const baseline = p.reads.length;
  for (let tick = 0; tick < 10; tick++) {
    p.advance(30_000);
    await p.timers[0].fn();
  }
  assert.equal(p.reads.length, baseline + 1);
  p.changed({ value: 'new-deployment' });
  assert.equal(p.reloads.at(-1), 'new-deployment');
  assert.equal(p.reads.length, baseline + 1, 'Realtime update needs no extra HTTP read');
});

test('launcher restores the short fallback after a disconnect and stops background reads', async () => {
  const p = launcherPolling();
  await p.context.watchForceRefresh();
  p.status('CHANNEL_ERROR');
  p.advance(30_000);
  await p.context.pollForceRefresh();
  assert.equal(p.reads.length, 2);
  p.context.document.visibilityState = 'hidden';
  p.advance(30_000);
  await p.context.pollForceRefresh();
  assert.equal(p.reads.length, 2);
  p.context.document.visibilityState = 'visible';
  await p.listeners.get('visibilitychange')();
  assert.equal(p.reads.length, 3);
  p.context.navigator.onLine = false;
  p.advance(30_000);
  await p.context.pollForceRefresh();
  assert.equal(p.reads.length, 3);
});

test('launcher coalesces overlapping control reads and recovers after a failure', async () => {
  const p = launcherPolling();
  let finish;
  p.context.reply = () => new Promise(resolve => { finish = resolve; });
  const first = p.context.checkForceRefresh(true), second = p.context.checkForceRefresh();
  assert.equal(first, second);
  assert.equal(p.reads.length, 1);
  finish({ data: { value: 'baseline' } });
  await first;
  p.context.reply = async () => { throw new Error('network unavailable'); };
  await p.context.checkForceRefresh();
  p.context.reply = async () => ({ data: { value: 'new-deployment' } });
  await p.context.checkForceRefresh();
  assert.equal(p.reads.length, 3);
  assert.equal(p.reloads.at(-1), 'new-deployment');
});
