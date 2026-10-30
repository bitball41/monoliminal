import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = chat.indexOf(start), to = chat.indexOf(end, from);
  assert(from >= 0 && to > from, `${start} exists`);
  return chat.slice(from, to);
};

function ordering() {
  const context = vm.createContext({});
  vm.runInContext(section('    function placeByTime(', '    function appendToTimeline('), context);
  return context.placeByTime;
}

const row = (id, second, extra = {}) => ({ id, created_at: `2026-10-30T11:00:${String(second).padStart(2, '0')}.000000+00:00`, ...extra });

test('a late-delivered row moves back among delivered rows', () => {
  const placeByTime = ordering();
  const late = row('late', 2);
  const cache = [row('a', 1), row('b', 3), row('c', 4), late];
  assert.equal(placeByTime(cache, late), true);
  assert.deepEqual(cache.map(m => m.id), ['a', 'late', 'b', 'c']);
});

test('in-order rows and rows behind only pending sends stay where they are', () => {
  const placeByTime = ordering();
  const next = row('next', 5);
  const cache = [row('a', 1), row('b', 3), next];
  assert.equal(placeByTime(cache, next), false);
  assert.deepEqual(cache.map(m => m.id), ['a', 'b', 'next']);

  // A pending send stamped by a fast local clock does not pull remote rows above it.
  const remote = row('remote', 6);
  const withPending = [row('a', 1), row('pending:1', 59, { pending: true }), remote];
  assert.equal(placeByTime(withPending, remote), false);
  assert.deepEqual(withPending.map(m => m.id), ['a', 'pending:1', 'remote']);
});

test('a late row moves above newer delivered rows but keeps pending sends below it', () => {
  const placeByTime = ordering();
  const late = row('late', 2);
  const cache = [row('a', 1), row('b', 4), row('pending:1', 5, { pending: true }), late];
  assert.equal(placeByTime(cache, late), true);
  assert.deepEqual(cache.map(m => m.id), ['a', 'late', 'b', 'pending:1']);
});

test('typing indicators expire on the receiving clock', () => {
  assert.match(section('    function onTypingBroadcast(', '    function scheduleTypingExpiry('),
    /until: Date\.now\(\) \+ TYPING_TTL_MS/);
});

test('read marks use the newest delivered server timestamp', () => {
  const context = vm.createContext({
    msgCache: new Map([['c:general', [row('a', 1), row('b', 3), row('pending:1', 59, { pending: true })]]]),
    Date, LS: { set() {} }, addEventListener() {},
  });
  vm.runInContext(section('    function readStampFor(', '    function markViewRead('), context);
  assert.equal(context.readStampFor('c:general'), row('b', 3).created_at);
  assert.match(context.readStampFor('c:empty'), /^\d{4}-\d\d-\d\dT/);
});

test('only network failures are retried automatically, oldest first, with a limit', async () => {
  const sent = [];
  const navigator = { onLine: true };
  const failed = (id, second, extra = {}) => ({ ...row(id, second), failed: true, autoRetry: true, ...extra });
  const context = vm.createContext({
    navigator, me: { username: 'alice' }, sent,
    msgCache: new Map([
      ['c:one', [row('ok', 1), failed('second', 5)]],
      ['dm:two', [failed('first', 2), failed('refused', 3, { autoRetry: false })]],
    ]),
    retryFailedSend: async msg => { sent.push(msg.id); },
    addEventListener() {}, setTimeout,
    pendingSends: [], currentView: {}, viewKey: () => 'none', updateMessageNode() {}, toast() {},
  });
  vm.runInContext(section('    function isTransientSendError(', '    function discardFailedSend('), context);
  assert.equal(context.isTransientSendError({ message: 'TypeError: Failed to fetch', code: '' }), true);
  assert.equal(context.isTransientSendError({ name: 'AbortError', message: 'signal timed out' }), true);
  assert.equal(context.isTransientSendError({ message: 'new row violates row-level security policy', code: '42501' }), false);
  navigator.onLine = false;
  assert.equal(context.isTransientSendError({ message: 'anything', code: 'P0001' }), true);
  navigator.onLine = true;

  await context.retryTransientFailures();
  assert.deepEqual(sent, ['first', 'second']);

  const placeholder = { autoRetries: 3 };
  context.failPendingSend({ placeholder, key: 'c:one' }, '', { message: 'Failed to fetch' });
  assert.equal(placeholder.autoRetry, false, 'gives up after the retry limit');
  const refused = {};
  context.failPendingSend({ placeholder: refused, key: 'c:one' }, 'Direct messages are unavailable for this conversation.', { message: 'Failed to fetch' });
  assert.equal(refused.autoRetry, false);
});

test('a profile broadcast refetches only when Realtime missed the row change', () => {
  let now = 10_000;
  const timers = [], fetched = [], applied = [];
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
    handleProfileChange: payload => applied.push(payload.new.username),
  });
  vm.runInContext(section('    const PROFILE_REFRESH_GRACE_MS', '    async function refreshProfile(') +
    '\nasync function refreshProfile(username) { fetched.push(username); }', context);
  context.fetched = fetched;
  const run = () => { const due = timers.splice(0); now = Math.max(now, ...due.map(t => t.at)); due.forEach(t => t.fn()); };

  context.onProfileRealtime({ new: { username: 'alice' } });
  now += 200;
  context.scheduleProfileRefresh('alice');
  context.scheduleProfileRefresh('alice');
  assert.equal(timers.length, 1, 'repeated broadcasts share one check');
  run();
  assert.deepEqual(fetched, [], 'row arrived just before the broadcast');

  context.scheduleProfileRefresh('bob');
  now += 300;
  context.onProfileRealtime({ new: { username: 'bob' } });
  run();
  assert.deepEqual(fetched, [], 'row arrived after the broadcast');

  now += 60_000;
  context.scheduleProfileRefresh('carol');
  run();
  assert.deepEqual(fetched, ['carol'], 'missed row change is still fetched');
  assert.deepEqual(applied, ['alice', 'bob']);
});
