import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = async path => (await readFile(new URL('../' + path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const games = await read('Games/games.html');
const admin = await read('Admin/liminal-admin-dashboard.html');
const slice = (source, first, last) => {
  const start = source.indexOf(first), end = source.indexOf(last, start);
  assert(start >= 0 && end > start, first);
  return source.slice(start, end);
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function gamesHarness() {
  let now = 1000000, handler = async () => ({ usage_day: 'today' });
  const requests = [], applied = [];
  const c = vm.createContext({
    Promise, Math, String, Error, Date: { now: () => now }, navigator: { onLine: true }, document: { hidden: false },
    recordingOpen: null, openNextAttemptAt: 0, openRetryMs: 60000, USAGE_REFRESH_MS: 300000, USAGE_MAX_RETRY_MS: 900000,
    usageRefreshTask: null, usageNextPollAt: 0, usageRetryMs: 60000,
    lastRecordedVisitorId: 'visitor', lastRecordedDay: 'today',
    getVisitorId: () => 'visitor', applyUsage: data => applied.push(data),
    rpc: (...args) => { requests.push(args); return handler(...args); },
  });
  vm.runInContext(slice(games, '    function recordOpen(){', '    function recordLaunch('), c);
  return { c, requests, applied, advance(ms) { now += ms; }, setHandler(fn) { handler = fn; } };
}

test('Games periodic usage waits five minutes and skips hidden/offline tabs', async () => {
  const h = gamesHarness();
  await h.c.pollUsage(); assert.equal(h.requests.length, 1);
  for (let i = 0; i < 4; i++) { h.advance(60000); await h.c.pollUsage(); }
  assert.equal(h.requests.length, 1);
  h.advance(60000); h.c.document.hidden = true; await h.c.pollUsage();
  h.c.document.hidden = false; h.c.navigator.onLine = false; await h.c.pollUsage();
  assert.equal(h.requests.length, 1);
  h.c.navigator.onLine = true; await h.c.pollUsage();
  assert.equal(h.requests.length, 2);
  await h.c.pollUsage(); assert.equal(h.requests.length, 2, 'focus/pageshow do not repeat fresh reads');
  assert.match(games, /document\.addEventListener\("visibilitychange", pollUsage\)/);
  assert.match(games, /window\.addEventListener\("online", pollUsage\)/);
});

test('Games shares concurrent polls and refreshes once more after a launch during an earlier read', async () => {
  const h = gamesHarness(), first = deferred(), follow = deferred();
  h.setHandler(() => h.requests.length === 1 ? first.promise : follow.promise);
  const poll = h.c.pollUsage();
  const peers = Array.from({ length: 25 }, () => h.c.pollUsage());
  assert.equal(h.requests.length, 1);
  const launches = Array.from({ length: 25 }, () => h.c.refreshUsage());
  first.resolve({ usage_day: 'today', unique_today: 1 }); await flush();
  assert.equal(h.requests.length, 2);
  follow.resolve({ usage_day: 'today', unique_today: 2 }); await Promise.all([poll, ...peers, ...launches]);
  assert.equal(h.requests.length, 2);
  assert.equal(h.applied.at(-1).unique_today, 2);
  await h.c.refreshUsage(); assert.equal(h.requests.length, 3, 'launch refresh bypasses the healthy interval');
});

test('Games failure retries back off to fifteen minutes and resume after recovery', async () => {
  const h = gamesHarness(); h.setHandler(async () => { throw new Error('offline'); });
  const delays = [60000, 120000, 240000, 480000, 900000, 900000];
  for (let i = 0; i < delays.length; i++) {
    await h.c.pollUsage(); assert.equal(h.requests.length, i + 1);
    h.advance(delays[i] - 1); await h.c.pollUsage(); assert.equal(h.requests.length, i + 1);
    h.advance(1);
  }
  h.setHandler(async () => ({ usage_day: 'today' })); await h.c.pollUsage();
  h.advance(299999); await h.c.pollUsage(); assert.equal(h.requests.length, 7);
  h.advance(1); await h.c.pollUsage(); assert.equal(h.requests.length, 8);
});

test('Games initial device registration supplies usage without a duplicate simultaneous poll', async () => {
  const h = gamesHarness(), initial = deferred(); h.setHandler(() => initial.promise);
  const open = h.c.recordOpen(), poll = h.c.pollUsage();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0][0], 'games_record_device_open');
  initial.resolve({ usage_day: 'today', ok: true }); await Promise.all([open, poll]);
  assert.equal(h.requests.length, 1);
});

function adminHarness() {
  let now = 1000000, handler = async () => ({ generated_at: 'fresh' });
  const requests = [], renders = [], toasts = [], busy = [], events = {}, timers = [];
  const fields = new Map();
  const c = vm.createContext({
    Promise, Math, Error, String, Date: { now: () => now }, performance: { now: () => now },
    navigator: { onLine: true }, document: { hidden: false, addEventListener: (name, fn) => events[name] = fn },
    window: { addEventListener: (name, fn) => events[name] = fn },
    admin: { token: 'one', username: 'owner' }, dashboardOpen: true, dashboardSessionGeneration: 1,
    autoRefreshEnabled: true, autoRefreshTimer: null, STATE_REFRESH_MS: 120000, STATE_MAX_RETRY_MS: 900000,
    stateRefreshTask: null, stateNextPollAt: 0, stateRetryMs: 120000, state: null, lastRefreshDuration: 0,
    $: id => { if (!fields.has(id)) fields.set(id, { classList: { add() {}, remove() {} }, textContent: '' }); return fields.get(id); },
    setBusy: value => busy.push(value), renderAll: () => renders.push(c.state),
    toast: (...args) => toasts.push(args), logout() { c.dashboardOpen = false; c.admin = null; c.dashboardSessionGeneration++; },
    showNotStaff() { c.dashboardOpen = false; c.admin = null; },
    rpc: (...args) => { requests.push(args); return handler(...args); },
    clearInterval() {}, setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; },
  });
  vm.runInContext(slice(admin, '    function refreshState(', '    async function restoreSession('), c);
  vm.runInContext(slice(admin, '    function startAutoRefresh()', '    function showView('), c);
  return { c, requests, renders, toasts, busy, events, timers, advance(ms) { now += ms; }, setHandler(fn) { handler = fn; } };
}

test('Control automatic state reads run every two minutes only while visible and online', async () => {
  const h = adminHarness();
  await h.c.refreshState(); h.c.startAutoRefresh();
  assert.equal(h.requests.length, 1);
  h.advance(119999); await h.c.catchUpDashboard(); assert.equal(h.requests.length, 1);
  h.advance(1); h.c.document.hidden = true; h.c.catchUpDashboard(); await flush();
  h.c.document.hidden = false; h.c.navigator.onLine = false; h.c.catchUpDashboard(); await flush();
  assert.equal(h.requests.length, 1);
  h.c.navigator.onLine = true; h.events.online(); await flush(); assert.equal(h.requests.length, 2);
  h.events.pageshow(); h.events.visibilitychange(); await flush(); assert.equal(h.requests.length, 2);
  h.advance(120000); h.c.autoRefreshEnabled = false; h.c.catchUpDashboard(); await flush(); assert.equal(h.requests.length, 2);
  await h.c.refreshState(); assert.equal(h.requests.length, 3, 'manual refresh still works while automatic reads are paused');
});

test('Control coalesces overlapping polls and reads after completed mutations', async () => {
  const h = adminHarness(), first = deferred(), next = deferred();
  h.setHandler(() => h.requests.length === 1 ? first.promise : next.promise);
  const poll = h.c.refreshState(true, { periodic: true });
  for (let i = 0; i < 25; i++) h.c.catchUpDashboard();
  assert.equal(h.requests.length, 1);
  const mutations = Array.from({ length: 25 }, () => h.c.refreshState(true));
  first.resolve({ version: 'before' }); await flush(); assert.equal(h.requests.length, 2);
  next.resolve({ version: 'after' }); await Promise.all([poll, ...mutations]);
  assert.equal(h.requests.length, 2); assert.equal(h.c.state.version, 'after');
});

test('Control bounds automatic failure retries, keeps previous data and allows manual retry', async () => {
  const h = adminHarness(); await h.c.refreshState(); const previous = h.c.state;
  h.advance(120000); h.setHandler(async () => { throw new Error('network failed'); });
  const delays = [120000, 240000, 480000, 900000, 900000];
  for (let i = 0; i < delays.length; i++) {
    await h.c.refreshState(true, { periodic: true }); assert.equal(h.requests.length, i + 2);
    h.advance(delays[i] - 1); await h.c.refreshState(true, { periodic: true }); assert.equal(h.requests.length, i + 2);
    h.advance(1);
  }
  assert.equal(h.c.state, previous); assert.equal(h.toasts.length, 0, 'automatic network failures do not flood toasts');
  h.setHandler(async () => ({ recovered: true })); await h.c.refreshState();
  assert.equal(h.c.state.recovered, true); assert.equal(h.c.stateRetryMs, 120000);
});

test('Control ignores old-session responses and lets a replacement session refresh immediately', async () => {
  const h = adminHarness(), stale = deferred(); h.setHandler(() => stale.promise);
  const old = h.c.refreshState();
  h.c.logout(); h.c.admin = { token: 'two', username: 'other' }; h.c.dashboardOpen = true; h.c.dashboardSessionGeneration++;
  h.setHandler(async () => ({ account: 'other' })); await h.c.refreshState();
  stale.resolve({ account: 'owner' }); await old;
  assert.equal(h.c.state.account, 'other'); assert.deepEqual(h.renders.map(x => x.account), ['other']);
});

test('Control ignores late errors after logout instead of changing sign-in UI', async () => {
  const h = adminHarness(), stale = deferred(); h.setHandler(() => stale.promise);
  const old = h.c.refreshState(); h.c.logout(); stale.reject(new Error('invalid administrator credentials')); await old;
  assert.equal(h.c.state, null); assert.equal(h.renders.length, 0); assert.equal(h.toasts.length, 0);
});

test('Control does not renew an expired token after logout or overwrite a replacement session', async () => {
  const c = vm.createContext({
    admin: { token: 'one' }, dashboardSessionGeneration: 1, adminMintTask: null, writes: [],
    writeAdminCache(value) { c.writes.push(value); },
  });
  c.adminMintTask = null;
  vm.runInContext(slice(admin, '    async function rpc(', '    async function callChatAuth('), c);
  let request = deferred(), calls = 0;
  c.sb = { rpc: () => { calls++; return request.promise; } };
  const old = c.rpc('admin_dashboard_get_state', { p_admin_token: 'one' });
  c.admin = null; c.dashboardSessionGeneration++;
  request.resolve({ error: { message: 'expired administrator session' } });
  await assert.rejects(old); assert.equal(calls, 1); assert.equal(c.writes.length, 0);
  request = deferred(); c.admin = { token: 'two' };
  const renewal = c.mintAdmin(); c.admin = { token: 'three' }; c.dashboardSessionGeneration++;
  request.resolve({ data: { token: 'stale' } });
  await assert.rejects(renewal, /Control session changed/);
  assert.equal(c.admin.token, 'three'); assert.equal(c.writes.length, 0);
});

test('Control still renews an expired token for the active session', async () => {
  const requests = [], writes = [];
  const c = vm.createContext({
    admin: { token: 'one', username: 'owner' }, dashboardSessionGeneration: 1,
    writeAdminCache(value) { writes.push(value); },
    sb: { rpc: async (name, params) => {
      requests.push([name, params]);
      if (requests.length === 1) return { error: { message: 'expired administrator session' } };
      if (name === 'admin_dashboard_sign_in_auth') return { data: { token: 'renewed', username: 'owner' } };
      return { data: { fresh: true } };
    } },
  });
  c.adminMintTask = null;
  vm.runInContext(slice(admin, '    async function rpc(', '    async function callChatAuth('), c);
  assert.equal((await c.rpc('admin_dashboard_get_state', { p_admin_token: 'one' })).fresh, true);
  assert.equal(requests.length, 3); assert.equal(requests[2][1].p_admin_token, 'renewed');
  assert.equal(c.admin.token, 'renewed'); assert.equal(writes.at(-1).token, 'renewed');
});

test('Games announcement refresh skips offline work and bounds failed foreground retries', async () => {
  let now = 1000000, requests = 0, fail = false;
  const events = {}, nav = { onLine: true }, fields = new Map();
  const field = id => {
    if (!fields.has(id)) fields.set(id, { hidden: true, addEventListener() {}, replaceChildren() {}, childElementCount: 0 });
    return fields.get(id);
  };
  const c = vm.createContext({
    JSON, String, Array, URL, AbortController, Math, Date: { now: () => now },
    window: { navigator: nav, addEventListener: (name, fn) => events[name] = fn },
    document: { hidden: false, getElementById: field, addEventListener: (name, fn) => events[name] = fn },
    localStorage: { getItem() { return null; } }, setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    fetch: async () => { requests++; if (fail) throw new Error('network'); return { ok: true, json: async () => [] }; },
  });
  vm.runInContext(games.match(/<script id="gamesPageContent">([\s\S]*?)<\/script>/)[1], c);
  await flush(); assert.equal(requests, 1);
  now += 120000; nav.onLine = false; events.online(); await flush(); assert.equal(requests, 1);
  nav.onLine = true; c.document.hidden = true; events.visibilitychange(); await flush(); assert.equal(requests, 1);
  c.document.hidden = false; fail = true;
  for (const wait of [120000, 240000, 480000, 900000, 900000]) {
    const before = requests; events.online(); await flush(); assert.equal(requests, before + 1);
    now += wait - 1; events.focus(); await flush(); assert.equal(requests, before + 1); now++;
  }
  fail = false; events.pageshow(); await flush();
  const recovered = requests; events.focus(); events.online(); await flush(); assert.equal(requests, recovered);
});

test('Games missing/declined visit responses back off independently from successful usage reads', async () => {
  const h = gamesHarness(); let registrations = 0;
  h.setHandler(async name => {
    if (name === 'games_record_device_open') { registrations++; return registrations === 1 ? null : { ok: false }; }
    return { usage_day: 'tomorrow' };
  });
  await h.c.recordOpen(); assert.equal(registrations, 1);
  await h.c.recordOpen(); assert.equal(registrations, 1, 'a null REST fallback response has a retry deadline');
  h.advance(60000); await h.c.pollUsage(); assert.equal(registrations, 2);
  assert.equal(h.c.openRetryMs, 240000, 'successful usage reads do not reset failed registration backoff');
  await h.c.recordOpen(); assert.equal(registrations, 2);
  h.advance(120000); await h.c.recordOpen(); assert.equal(registrations, 3);
  h.c.navigator.onLine = false; h.advance(900000); await h.c.recordOpen(); assert.equal(registrations, 3);
});

function renewalHarness() {
  const initial = new Map(), retried = [], renew = deferred(); let mints = 0;
  const c = vm.createContext({
    admin: { token: 'old', username: 'owner' }, dashboardSessionGeneration: 1, adminMintTask: null,
    writeAdminCache() {},
    sb: { rpc(name, params) {
      if (name === 'admin_dashboard_sign_in_auth') { mints++; return renew.promise; }
      if (params.p_admin_token === 'fresh') { retried.push(name); return Promise.resolve({ data: { ok: true } }); }
      const pending = deferred(); initial.set(name, pending); return pending.promise;
    } },
  });
  vm.runInContext(slice(admin, '    async function rpc(', '    async function callChatAuth('), c);
  return { c, initial, retried, renew, mints: () => mints };
}

test('Control reuses a token already renewed while a concurrent mutation received its expired response', async () => {
  const h = renewalHarness();
  const state = h.c.rpc('state', { p_admin_token: 'old' });
  const mutation = h.c.rpc('mutation', { p_admin_token: 'old' });
  h.initial.get('state').resolve({ error: { message: 'expired administrator session' } }); await flush();
  h.renew.resolve({ data: { token: 'fresh', username: 'owner' } }); await state;
  h.initial.get('mutation').resolve({ error: { message: 'expired administrator session' } });
  assert.equal((await mutation).ok, true); assert.equal(h.mints(), 1);
  assert.deepEqual(h.retried, ['state', 'mutation']);
});

test('Control shares simultaneous token renewals within one active account generation', async () => {
  const h = renewalHarness();
  const state = h.c.rpc('state', { p_admin_token: 'old' });
  const mutation = h.c.rpc('mutation', { p_admin_token: 'old' });
  for (const pending of h.initial.values()) pending.resolve({ error: { message: 'expired administrator session' } });
  await flush(); assert.equal(h.mints(), 1);
  h.renew.resolve({ data: { token: 'fresh', username: 'owner' } });
  const result = await Promise.all([state, mutation]); assert(result.every(x => x.ok));
  assert.deepEqual(h.retried, ['state', 'mutation']);
});
