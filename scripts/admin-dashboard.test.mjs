import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../Admin/liminal-admin-dashboard.html', import.meta.url), 'utf8');

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
