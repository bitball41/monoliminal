import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = (await readFile(new URL('../Games/games.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const start = html.indexOf('    var launcherSettingsPromise =');
const end = html.indexOf('    if (!isEmbedded)', start);
assert(start > 0 && end > start);
function harness(fetcher) {
  let started = 0, migrated = 0, requests = 0, id = 0;
  const timers = new Map();
  const c = vm.createContext({
    AbortController, Promise, Math, Number, String, parseInt,
    SUPABASE_URL: 'https://fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'public-fixture',
    appStarted: false, LAUNCHER_PROTOCOL: 5, minLauncherVersion: 5, launcherVersion: 5,
    startApp() { started++; c.appStarted = true; }, showMigrate() { migrated++; },
    setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: (...args) => { requests++; return fetcher(...args); },
  });
  vm.runInContext(html.slice(start, end), c);
  return { c, timers, started: () => started, migrated: () => migrated, requests: () => requests };
}
test('launcher hello and timeout share one settings request and start Games once', async () => {
  let resolve;
  const h = harness(() => new Promise(r => { resolve = r; }));
  const hello = h.c.finishGate(false), timeout = h.c.finishGate(true);
  assert.equal(h.requests(), 1);
  resolve({ ok: true, json: async () => [] });
  await Promise.all([hello, timeout]);
  assert.equal(h.started(), 1); assert.equal(h.migrated(), 0);
  assert.equal(h.timers.size, 0);
});
test('a stalled settings request is aborted after eight seconds instead of freezing the launcher', async () => {
  const h = harness((url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }));
  const gate = h.c.finishGate(true);
  assert.equal(h.started(), 0);
  [...h.timers.values()].find(t => t.ms === 8000).fn();
  await gate;
  assert.equal(h.started(), 1); assert.equal(h.timers.size, 0);
});
test('the deadline includes the settings response body and a late hello is respected', async () => {
  const h = harness(async (url, { signal }) => ({ ok: true, json: () => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('body timeout')), { once: true });
  }) }));
  h.c.launcherVersion = 0;
  const gate = h.c.finishGate(true);
  await new Promise(resolve => setImmediate(resolve));
  h.c.launcherVersion = 5;
  const hello = h.c.finishGate(false);
  [...h.timers.values()][0].fn();
  await Promise.all([gate, hello]);
  assert.equal(h.requests(), 1); assert.equal(h.started(), 1);
});
test('a known newer launcher requirement still blocks old launchers and successful settings reads are reused', async () => {
  const h = harness(async () => ({ ok: true, json: async () => [
    { key: 'min_games_launcher_version', value: '6' },
    { key: 'games_launcher_migrate_message', value: 'Update the launcher' },
  ] }));
  await h.c.finishGate(true);
  assert.equal(h.started(), 0); assert.equal(h.migrated(), 1);
  assert.equal(h.c.migrateMessage, 'Update the launcher');
  h.c.launcherVersion = 6;
  await h.c.finishGate(false);
  assert.equal(h.requests(), 1); assert.equal(h.started(), 1);
});
