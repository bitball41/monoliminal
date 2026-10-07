import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { drivePermissions } from '../Backend/edge-functions/liminal-drive-admin/permissions.ts';

const source = await readFile(new URL('../Backend/edge-functions/liminal-drive-admin/index.ts', import.meta.url), 'utf8');
const driveHtml = await readFile(new URL('../Drive/Liminal-Drive.html', import.meta.url), 'utf8');
const frontend = [...driveHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
function frontSection(start, end, context) {
  const from = frontend.indexOf(start), to = frontend.indexOf(end, from);
  assert(from >= 0 && to > from, 'frontend section exists');
  vm.runInNewContext(frontend.slice(from, to), context);
  return context;
}
const commandNames = [...source.matchAll(/new (\w+Command)\(/g)].map(m => m[1]);
function backend(profile, { existing = false } = {}) {
  let handler;
  const writes = [];
  const context = {
    Request, Response, URL, TextEncoder, Uint8Array, console, crypto,
    drivePermissions,
    Deno: { env: { get: key => ({ SUPABASE_URL: 'https://auth.test', SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key' })[key] }, serve: fn => { handler = fn; } },
    fetch: async url => new Response(JSON.stringify(String(url).includes('/auth/v1/user') ? { id: 'test-user' } : profile ? [profile] : [])),
    s3: { send: async command => { writes.push(command); return { ETag: 'test-etag' }; } },
    bucket: 'test-bucket', cors: {},
    json: (data, status = 200) => new Response(JSON.stringify(data), { status }),
    keyOf: value => typeof value === 'string' && value && !value.startsWith('.liminal-') ? value : null,
    exists: async () => existing,
    all: async () => [], publicUrl: key => 'https://files.test/' + key,
    manifest: async () => ({}), getSignedUrl: async () => 'https://upload.test',
  };
  for (const name of new Set(commandNames)) context[name] = class { constructor(input) { this.name = name; this.input = input; } };
  vm.runInNewContext(stripTypeScriptTypes(source.replace(/^import .*;$/gm, '')), context);
  const invoke = (action, body = {}, { token = true, method = 'POST' } = {}) => handler(new Request(method === 'PUT' ? 'https://drive.test/?key=Games/test.html' : 'https://drive.test/', {
    method, headers: { ...(token ? { authorization: 'Bearer test-jwt' } : {}), 'content-type': method === 'PUT' ? 'text/html' : 'application/json' },
    body: method === 'PUT' ? '<h1>test</h1>' : JSON.stringify({ action, ...body }),
  }));
  return { invoke, writes };
}

test('every Chat staff role has upload rights, with management reserved for admins', () => {
  for (const role of ['mod', 'manager', 'admin', 'super_mega_tuff_admin', 'dusty', 'co_owner', 'owner', 'preston']) {
    assert.equal(drivePermissions({ staff_role: role }).canUpload, true, role);
    assert.equal(drivePermissions({ staff_role: role }).canManage, !['mod', 'manager'].includes(role), role);
  }
  for (const profile of [null, {}, { staff_role: 'member' }, { staff_role: 'unknown' }, { staff_role: 'mod', is_banned: true }, { is_admin: true, is_banned: true }]) {
    assert.deepEqual(drivePermissions(profile), { canUpload: false, canManage: false });
  }
  assert.equal(drivePermissions({ is_admin: true }).canUpload, true);
});

test('members can retrieve their real profile without acquiring write access', async () => {
  const b = backend({ username: 'viewer', display_name: 'Viewer', staff_role: 'member' });
  const result = await b.invoke('status');
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.displayName, 'Viewer');
  assert.equal(data.canUpload, false);
  for (const action of ['presign_upload', 'create_folder', 'trash']) {
    assert.equal((await b.invoke(action, { key: 'a.html', prefix: 'folder/' })).status, 403);
  }
  assert.equal((await b.invoke(null, {}, { method: 'PUT' })).status, 403);
  assert.equal(b.writes.length, 0);
});

test('moderators can upload through proxy, signed URL, and multipart paths', async () => {
  const b = backend({ username: 'mod', staff_role: 'mod' });
  assert.equal((await b.invoke(null, {}, { method: 'PUT' })).status, 200);
  assert.equal((await b.invoke('presign_upload', { key: 'Games/test.html' })).status, 200);
  assert.equal((await b.invoke('multipart_create', { key: 'Games/large.html' })).status, 200);
  assert.equal((await b.invoke('multipart_complete', { key: 'Games/large.html', upload_id: 'upload-test', parts: [{ partNumber: 1, etag: 'etag' }] })).status, 200);
  assert.equal((await b.invoke('create_folder', { prefix: 'Games/new/' })).status, 200);
  assert(b.writes.some(x => x.name === 'PutObjectCommand'));
  assert(b.writes.some(x => x.name === 'CompleteMultipartUploadCommand'));
  const count = b.writes.length;
  for (const action of ['trash', 'delete', 'rename', 'move', 'delete_trash', 'restore']) {
    assert.equal((await b.invoke(action, { key: 'Games/test.html' })).status, 403);
  }
  assert.equal(b.writes.length, count);
});

test('moderators cannot overwrite shared files, including through signed URLs', async () => {
  const b = backend({ username: 'mod', staff_role: 'mod' }, { existing: true });
  assert.equal((await b.invoke('presign_upload', { key: 'existing.html' })).status, 409);
  for (const action of ['presign_upload', 'multipart_create']) {
    assert.equal((await b.invoke(action, { key: 'existing.html', overwrite: true })).status, 403);
  }
  assert.equal(b.writes.length, 0);
});

test('no token, banned profiles, and missing profiles never reach storage', async () => {
  for (const [profile, token] of [[{ staff_role: 'admin' }, false], [{ staff_role: 'owner', is_banned: true }, true], [null, true]]) {
    const b = backend(profile);
    assert.equal((await b.invoke('presign_upload', { key: 'Games/test.html' }, { token })).status, 401);
    assert.equal(b.writes.length, 0);
  }
});

// A malformed responsive rule can silently put every later rule behind a
// viewport condition. JavaScript interaction checks do not detect that.
test('Drive CSS is balanced and the Chat shell/auth/file styles apply at desktop widths', async () => {
  const html = await readFile(new URL('../Drive/Liminal-Drive.html', import.meta.url), 'utf8');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert(css, 'Drive has an embedded stylesheet');
  const stack = [], selectors = new Set();
  let quote = '', comment = false, ruleStart = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i], next = css[i + 1];
    if (comment) { if (c === '*' && next === '/') { comment = false; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '/' && next === '*') { comment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if ('{(['.includes(c)) {
      if (c === '{' && stack.length === 0) selectors.add(css.slice(ruleStart, i).replace(/\/\*[\s\S]*?\*\//g, '').trim());
      stack.push(c);
      if (c === '{') ruleStart = i + 1;
    } else if ('})]'.includes(c)) {
      const expected = { '}': '{', ')': '(', ']': '[' }[c];
      assert.equal(stack.pop(), expected, `CSS delimiter mismatch near character ${i}`);
      if (c === '}') ruleStart = i + 1;
    }
  }
  assert.equal(stack.length, 0, 'CSS blocks are closed');
  assert.equal(quote, '', 'CSS strings are closed');
  assert.equal(comment, false, 'CSS comments are closed');
  for (const selector of ['.auth-screen', '.auth-card', '.fileRow', '.brand', '.avatar img']) {
    assert(selectors.has(selector), `${selector} is available at desktop widths`);
  }
});

test('library indexing preserves bundles and reuses the listing across searches and tabs', () => {
  const state = { objects: [], trash: [], view: 'games', search: '', filter: 'all', sort: 'name', prefix: '', starred: new Set(), recent: [] };
  const c = frontSection('function libraryView()', 'function connection(', { state, CURATED: {}, write() {} });
  state.objects = [
    { key: 'Games/bundle/index.html', size: 10, lastModified: '2026-10-06' },
    { key: 'Games/bundle/help.html', size: 20, lastModified: '2026-10-07' },
    { key: 'Games/bundle/assets/main.js', size: 30 },
    { key: 'Games/standalone.html', size: 40 },
    { key: 'Apps/tool.html', size: 50 },
    { key: 'empty/.liminal-folder', size: 0 },
  ].map(c.normalize);
  const index = c.indexListing();
  assert.deepEqual(Array.from(c.visible(), f => f.key), ['Games/bundle/index.html', 'Games/standalone.html']);
  assert.equal(index.bytes, 150);
  const bundle = c.folders().find(f => f.key === 'Games/bundle/');
  assert.equal(bundle.childCount, 3);
  assert.equal(bundle.size, 60);
  assert.equal(bundle.modified, '2026-10-07');
  state.search = 'standalone';
  assert.equal(c.visible().length, 1);
  state.search = ''; state.view = 'apps';
  assert.equal(c.visible()[0].key, 'Apps/tool.html');
  state.view = 'starred'; state.starred.add('folder:Games/bundle/');
  assert.equal(c.visible()[0].key, 'Games/bundle/');
  assert.equal(c.indexListing(), index, 'navigation/search do not rebuild folder or entrypoint indexes');
  state.objects = [...state.objects, c.normalize({ key: 'Games/new.html' })];
  assert.notEqual(c.indexListing(), index, 'a refreshed listing invalidates the index');
  assert.equal(c.indexListing().games.length, 3);
});

test('cached public listings load before refresh without caching account permissions', () => {
  const storage = new Map();
  const state = { objects: [], trash: [], loading: true, canUpload: false, canManage: false };
  const api = 'https://drive.test/list';
  const c = frontSection('const LIST_CACHE_KEY=', 'async function refresh(', {
    state, API_URL: api, read: key => storage.get(key), write: (key, value) => storage.set(key, value),
    normalize: x => ({ ...x, id: x.key }), window: { requestIdleCallback: fn => fn() },
  });
  const data = { files: [{ key: 'Games/a.html' }], trash: [], canManage: true };
  c.cacheListing(data);
  assert.equal(c.restoreListing(), true);
  assert.equal(state.objects[0].id, 'Games/a.html');
  assert.equal(state.loading, false);
  assert.equal(state.canManage, false);
  assert.equal(state.canUpload, false);
  const cached = storage.get('ld-listing-v1');
  assert.equal('canManage' in cached, false);
  cached.savedAt = Date.now() - 86400001;
  assert.equal(c.restoreListing(), false, 'expired snapshots are ignored');
  cached.savedAt = Date.now(); cached.api = 'https://other.test';
  assert.equal(c.restoreListing(), false, 'snapshots belong to one public API');
  cached.api = api; cached.files = [null];
  assert.equal(c.restoreListing(), false, 'broken cache entries do not break startup');
});

test('unchanged account updates preserve avatar nodes while role changes still render', () => {
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, {
      writes: 0, classList: { toggle() {} }, style: { setProperty() {}, removeProperty() {} }, setAttribute() {},
      set innerHTML(value) { this.writes++; this.html = value; },
    });
    return elements.get(id);
  };
  const state = { view: 'games', auth: { username: 'mod' }, profile: { username: 'mod', displayName: 'Mod', pfp: 'https://avatar.test/a.gif', role: 'mod' }, canUpload: true };
  const c = frontSection('const ROLE_CLASSES=', 'function applySession(', { state, $, I: { check: '' }, ROLE_LABELS: { mod: 'Mod', admin: 'Admin' }, esc: String });
  c.updateAccount();
  const avatar = $('#sideAvatar'), firstMarkup = avatar.html;
  state.view = 'apps'; c.updateAccount(); c.updateAccount();
  assert.equal(avatar.writes, 1, 'unchanged avatars are not decoded/restarted on UI updates');
  assert.equal(avatar.html, firstMarkup);
  state.profile = { ...state.profile, role: 'admin' }; c.updateAccount();
  assert.match($('#accountName').html, /Admin/);
  assert.equal(avatar.writes, 1, 'role updates preserve the same profile image');
});


test('HTML files open download details while ordinary files keep their preview', () => {
  const calls = [];
  let library = true;
  const c = frontSection('function openItem(f)', 'function preview(f)', {
    libraryView: () => library, details: f => calls.push(['details', f.key]),
    preview: f => calls.push(['preview', f.key]), navigate: key => calls.push(['folder', key]),
  });
  c.openItem({ type: 'html', key: 'Games/a.html' });
  library = false;
  c.openItem({ type: 'html', key: 'a.html' });
  c.openItem({ type: 'image', key: 'a.png' });
  c.openItem({ type: 'folder', key: 'folder/' });
  assert.deepEqual(calls, [['details', 'Games/a.html'], ['details', 'a.html'], ['preview', 'a.png'], ['folder', 'folder/']]);
});

test('Account opens immediately while server verification is still pending', () => {
  const calls = [], elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); };
  const state = { auth: { username: 'viewer' }, profile: { displayName: 'Viewer' }, canUpload: false };
  const c = frontSection('function account(){', 'function validName(', {
    state, $, esc: String, roleCheck: () => '', fillAvatar() {}, I: { close: '' },
    showModal: () => { calls.push('open'); return {}; },
    loadAccount: () => { calls.push('verify'); return new Promise(() => {}); },
  });
  c.account();
  assert.deepEqual(calls, ['open', 'verify']);
  assert.equal(typeof $('#signOut').onclick, 'function');
});

test('signup validates confirmation and creates the shared Chat account before signing in', async () => {
  const elements = new Map(Object.entries({
    '#signup-username': { value: 'newuser' }, '#signup-display-name': { value: 'New User' },
    '#signup-password': { value: 'test-password' }, '#signup-confirm': { value: 'wrong-password' },
    '#signup-error': {}, '#signup-submit': {},
  }));
  const requests = [], signIns = [], closed = [];
  const c = frontSection('async function submitSignup(', 'function account(){', {
    state: { authDialog: {} }, $: id => elements.get(id),
    CHAT_AUTH_URL: 'https://liminal.test/functions/v1/chat-auth', PUBLISHABLE_KEY: 'public-test-key',
    deviceId: () => 'shared-liminal-device',
    net: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({}) }; },
    signInAccount: async (username, password) => signIns.push({ username, password }),
    closeAuth: value => closed.push(value),
  });
  await c.submitSignup({ preventDefault() {} });
  assert.equal(requests.length, 0);
  assert.match(elements.get('#signup-error').textContent, /match/);
  elements.get('#signup-confirm').value = 'test-password';
  await c.submitSignup({ preventDefault() {} });
  assert.equal(requests[0].url, 'https://liminal.test/functions/v1/chat-auth');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    action: 'signup', username: 'newuser', display_name: 'New User',
    password: 'test-password', device_id: 'shared-liminal-device',
  });
  assert.deepEqual(signIns, [{ username: 'newuser', password: 'test-password' }]);
  assert.deepEqual(closed, [true]);
});
