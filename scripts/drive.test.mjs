import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { drivePermissions } from '../Backend/edge-functions/liminal-drive-admin/permissions.ts';

const source = await readFile(new URL('../Backend/edge-functions/liminal-drive-admin/index.ts', import.meta.url), 'utf8');
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
test('Drive CSS is balanced and desktop cards/avatar styles remain outside media queries', async () => {
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
      if (c === '{' && stack.length === 0) selectors.add(css.slice(ruleStart, i).trim());
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
  for (const selector of ['.libraryArt', '.libraryGrid', '.libraryFooter', '.brand', '.avatar>img']) {
    assert(selectors.has(selector), `${selector} is available at desktop widths`);
  }
});
