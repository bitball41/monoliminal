import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../Admin/liminal-admin-dashboard.html', import.meta.url), 'utf8');

function broadcastHarness(failKey) {
  const fields = Object.fromEntries(['announcement', 'whats-new', 'luna-custom-status', 'announcement-preview', 'announcement-count', 'whats-new-count', 'luna-custom-status-count', 'save-broadcast'].map(id => [id, { value: '', dataset: {}, addEventListener(type, callback) { this[type] = callback; } }]));
  const writes = [];
  const notices = [];
  const context = vm.createContext({
    $: id => fields[id], document: { activeElement: null },
    state: { settings: { announcement: 'Old banner', whats_new: 'Old release' } },
    admin: { token: 'test', is_owner: true },
    setBusy() {}, console: { error() {} }, toast: (...args) => notices.push(args),
    rpc: async (name, params) => {
      if (params.p_key === failKey) throw new Error('Save failed');
      writes.push([params.p_key, params.p_value]);
      return true;
    },
    renderAll() { vm.runInContext('renderBroadcast()', context); }
  });
  for (const [start, end] of [
    ['    function fillIdle(', '    function renderUsers('],
    ['    async function setSetting(', '    async function setLunaCustomStatus('],
    ['    $("save-broadcast").addEventListener', '    $("clear-announcement").addEventListener'],
    ['    for (const id of ["announcement", "whats-new", "luna-custom-status"])', '    $("announcement").addEventListener("input",']
  ]) {
    const from = html.indexOf(start);
    assert.ok(from >= 0, start);
    vm.runInContext(html.slice(from, html.indexOf(end, from)), context);
  }
  return { fields, writes, notices, context };
}

test('broadcast drafts survive a refresh after losing focus and publish together', async () => {
  const { fields, writes, context } = broadcastHarness();
  vm.runInContext('renderBroadcast()', context);
  fields.announcement.value = 'New banner';
  fields.announcement.input();
  fields['whats-new'].value = 'New release';
  fields['whats-new'].input();
  vm.runInContext('renderBroadcast()', context);
  assert.equal(fields.announcement.value, 'New banner');
  assert.equal(fields['whats-new'].value, 'New release');
  await fields['save-broadcast'].click();
  assert.deepEqual(writes, [['announcement', 'New banner'], ['whats_new', 'New release']]);
  assert.equal(fields['whats-new'].dataset.broadcastDirty, undefined);
});

test('failed banner save keeps drafts and stops the second save', async () => {
  const { fields, writes, notices, context } = broadcastHarness('announcement');
  fields.announcement.value = 'New banner';
  fields.announcement.input();
  fields['whats-new'].value = 'New release';
  fields['whats-new'].input();
  await fields['save-broadcast'].click();
  vm.runInContext('renderBroadcast()', context);
  assert.deepEqual(writes, []);
  assert.equal(fields.announcement.value, 'New banner');
  assert.equal(fields['whats-new'].value, 'New release');
  assert.deepEqual(notices, [['Save failed', true]]);
});

test('failed release save retains the release draft after the banner succeeds', async () => {
  const { fields, writes, context } = broadcastHarness('whats_new');
  fields.announcement.value = 'New banner';
  fields.announcement.input();
  fields['whats-new'].value = 'New release';
  fields['whats-new'].input();
  await fields['save-broadcast'].click();
  vm.runInContext('renderBroadcast()', context);
  assert.deepEqual(writes, [['announcement', 'New banner']]);
  assert.equal(fields['whats-new'].value, 'New release');
  assert.equal(fields['whats-new'].dataset.broadcastDirty, 'true');
});

test('control reuses the chat session instead of a separate tab login', () => {
  assert.match(html, /storage:\s*localStorage/);
  assert.doesNotMatch(html, /storage:\s*sessionStorage/);
  assert.match(html, /sb\.auth\.getSession\(\)/);
  assert.match(html, /admin_dashboard_sign_in_auth/);
  assert.match(html, /accounts\.liminal\.invalid/);
  assert.match(html, /showNotStaff\(/);
  assert.match(html, /Checking your chat session/);
});

test('control keeps the staff tools and the chat visual system', () => {
  for (const marker of [
    'admin_dashboard_get_state',
    'admin_dashboard_ban_user',
    'admin_dashboard_set_setting',
    'admin_dashboard_force_refresh',
    'create_dev',
    'data-view="moderation"',
    'data-view="deploys"',
    'id="turn-servers"',
    'Pacifico',
    '--bg: #09003d',
  ]) assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
