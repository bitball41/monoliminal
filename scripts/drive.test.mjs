import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import {createMetadataStore, metadataKey, METADATA_PREFIX, validateMetadata} from '../Backend/edge-functions/liminal-drive-admin/metadata.ts';
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
function backend(profile, { existing = false, objects = null } = {}) {
  let handler;
  const writes = [], signatures = [];
  const context = {
    Request, Response, URL, TextEncoder, Uint8Array, console, crypto,
    drivePermissions, createMetadataStore, metadataKey, METADATA_PREFIX,
    Deno: { env: { get: key => ({ SUPABASE_URL: 'https://auth.test', SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key' })[key] }, serve: fn => { handler = fn; } },
    fetch: async url => new Response(JSON.stringify(String(url).includes('/auth/v1/user') ? { id: 'test-user' } : profile ? [profile] : [])),
    s3: { send: async command => { writes.push(command); return { ETag: 'test-etag' }; } },
    bucket: 'test-bucket', cors: {},
    json: (data, status = 200) => new Response(JSON.stringify(data), { status }),
    keyOf: value => typeof value === 'string' && value && !value.startsWith('.liminal-') ? value : null,
    exists: async () => existing,
    all: async () => [], publicUrl: key => 'https://files.test/' + key,
    manifest: async () => ({}), getSignedUrl: async (client,command,options) => {signatures.push({command,options});return 'https://upload.test';},
  };
  if(objects){
    let sequence=0;
    const get=key=>{if(!objects.has(key))throw Object.assign(new Error('Missing'),{name:'NoSuchKey',$metadata:{httpStatusCode:404}});return objects.get(key);};
    context.exists=async key=>objects.has(key);
    context.all=async(prefix='')=>[...objects].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,size:value.length,name:key.split('/').pop()}));
    context.manifest=async id=>JSON.parse(get('.liminal-trash/'+id+'/.entry.json'));
    context.s3.send=async command=>{writes.push(command);const x=command.input;
      if(command.name==='GetObjectCommand')return {ETag:'"'+get(x.Key)+'"',Body:{transformToString:async()=>get(x.Key)}};
      if(command.name==='PutObjectCommand'){objects.set(x.Key,typeof x.Body==='string'?x.Body:new TextDecoder().decode(x.Body));return {ETag:'"stored-'+(++sequence)+'"'};}
      if(command.name==='CopyObjectCommand'){objects.set(x.Key,get(x.CopySource.split('/').slice(1).map(decodeURIComponent).join('/')));return {};}
      if(command.name==='DeleteObjectsCommand'){x.Delete.Objects.forEach(({Key})=>objects.delete(Key));return {};}
      return {};
    };
  }
  for (const name of new Set(commandNames)) context[name] = class { constructor(input) { this.name = name; this.input = input; } };
  vm.runInNewContext(stripTypeScriptTypes(source.replace(/^import .*;$/gm, '')), context);
  const invoke = (action, body = {}, { token = true, method = 'POST' } = {}) => handler(new Request(method === 'PUT' ? 'https://drive.test/?key=Games/test.html' : 'https://drive.test/', {
    method, headers: { ...(token ? { authorization: 'Bearer test-jwt' } : {}), 'content-type': method === 'PUT' ? 'text/html' : 'application/json' },
    body: method === 'PUT' ? '<h1>test</h1>' : JSON.stringify({ action, ...body }),
  }));
  return { invoke, writes, signatures, context };
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

test('moderators can create files through proxy and signed URL paths', async () => {
  const b = backend({ username: 'mod', staff_role: 'mod' });
  assert.equal((await b.invoke(null, {}, { method: 'PUT' })).status, 200);
  assert.equal((await b.invoke('presign_upload', { key: 'Games/test.html' })).status, 200);
  assert.equal((await b.invoke('multipart_create', { key: 'Games/large.html' })).status, 403);
  assert.equal((await b.invoke('multipart_complete', { key: 'Games/large.html', upload_id: 'upload-test', parts: [{ partNumber: 1, etag: 'etag' }] })).status, 403);
  assert.equal((await b.invoke('create_folder', { prefix: 'Games/new/' })).status, 200);
  assert(b.writes.some(x => x.name === 'PutObjectCommand'));
  assert(!b.writes.some(x => x.name === 'CompleteMultipartUploadCommand'));
  assert(b.writes.filter(x => x.name === 'PutObjectCommand').every(x => x.input.IfNoneMatch === '*'));
  assert.equal(b.signatures[0].command.input.IfNoneMatch,'*');
  assert(b.signatures[0].options.signableHeaders.has('if-none-match'));
  const count = b.writes.length;
  for (const action of ['trash', 'delete', 'rename', 'move', 'delete_trash', 'restore']) {
    assert.equal((await b.invoke(action, { key: 'Games/test.html' })).status, 403);
  }
  assert.equal(b.writes.length, count);
});

test('admins retain multipart uploads while legacy multipart calls cannot bypass management permission', async () => {
  const b=backend({staff_role:'admin'});
  assert.equal((await b.invoke('multipart_create',{key:'Games/large.html'})).status,200);
  assert.equal((await b.invoke('multipart_complete',{key:'Games/large.html',upload_id:'upload-test',parts:[{partNumber:1,etag:'etag'}]})).status,200);
  assert(b.writes.some(x => x.name === 'CompleteMultipartUploadCommand'));
  for (const role of ['mod','manager']) {
    const restricted=backend({staff_role:role},{existing:true});
    assert.equal((await restricted.invoke('multipart_complete',{key:'Games/existing.html',upload_id:'old-upload',parts:[{partNumber:1,etag:'etag'}]})).status,403);
    assert.equal(restricted.writes.length,0);
  }
});

test('signed URLs require the create-only header until an admin explicitly requests replacement', async () => {
  for (const role of ['mod','admin']) {
    const b=backend({staff_role:role});
    const response=await b.invoke('presign_upload',{key:'Games/new.html'});
    assert.equal((await response.json()).headers['If-None-Match'],'*');
    assert.equal(b.signatures[0].command.input.IfNoneMatch,'*');
  }
  const admin=backend({staff_role:'admin'},{existing:true});
  const response=await admin.invoke('presign_upload',{key:'Games/existing.html',overwrite:true});
  assert.equal(response.status,200);
  assert.equal((await response.json()).headers['If-None-Match'],undefined);
  assert.equal(admin.signatures[0].command.input.IfNoneMatch,undefined);
  assert.deepEqual(drivePermissions({staff_role:'member',is_admin:true,is_owner:true}),{canUpload:false,canManage:false});
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
  const state = { objects: [], trash: [], view: 'games', search: '', filter: 'all', genre: 'all', catalogFilter: 'hosted', sort: 'name', prefix: '', starred: new Set(), recent: [] };
  const context = { state, CURATED: {}, write() {} };
  frontSection('const SPECIAL_GAMES=', 'Object.assign(I,', context);
  const c = frontSection('function libraryView()', 'function connection(', context);
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
  assert.equal(c.indexListing().games.filter(f => !f.virtual).length, 3);
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
    preferences: () => ({primaryAction:'details'}), libraryView: () => library, details: f => calls.push(['details', f.key]),
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

function gameLibrary(objects = []) {
  const state = { objects: [], trash: [], view: 'games', search: '', filter: 'all', genre: 'all', catalogFilter: 'all', sort: 'name', prefix: '', starred: new Set(), recent: [] };
  const context = { state, CURATED: {}, write() {}, URL, SUPABASE_URL: 'https://auth.test' };
  frontSection('const SPECIAL_GAMES=', 'Object.assign(I,', context);
  frontSection('function libraryView()', 'function connection(', context);
  state.objects = objects.map(context.normalize);
  return context;
}

test('V5 games fill catalog gaps without inventing hosted files, sizes, or missing links', () => {
  const c = gameLibrary([{ key: 'Games/balatro.html', size: 3210 }, { key: 'notes.txt', size: 15 }]);
  const index = c.indexListing();
  assert.equal(index.games.length, 18);
  assert.equal(index.games.filter(f => c.gameInfo(f).id === 'balatro').length, 1);
  assert.equal(index.games.find(f => c.gameInfo(f).id === 'balatro').virtual, undefined);
  assert.equal(index.bytes, 3225, 'original links do not count as stored bytes');
  const celeste = index.games.find(f => f.catalogId === 'celeste');
  assert.equal(c.sourceLabel(celeste), 'Google Drive link');
  assert.match(c.fileUrl(celeste, true), /^https:\/\/drive\.google\.com\/file\//);
  const unavailable = index.games.find(f => f.catalogId === '60-seconds');
  assert.equal(c.gameLink(unavailable), null);
  c.state.view = 'drive';
  assert.deepEqual(Array.from(c.visible(), f => f.key), ['Games/', 'notes.txt']);
});

test('game metadata matches accented names and bundle names without giving mods the base game rating', () => {
  const c = gameLibrary([
    { key: 'Games/poke-rogue.html' }, { key: 'Games/brotatoglm.html' },
    { key: 'Games/Kindergarten 2/index.html' }, { key: 'Games/Kindergarten 2/assets/help.html' },
  ]);
  assert.equal(c.gameInfo({ name: 'PokéRogue.html' }).id, 'pokerogue');
  const hosted = c.indexListing().games.filter(f => !f.virtual);
  assert.equal(hosted.length, 3, 'nested supporting HTML is hidden from the game catalog');
  const mod = hosted.find(f => f.name === 'brotatoglm.html');
  assert.equal(c.gameInfo(mod).title, 'Brotato · GMO');
  assert.equal(c.gameInfo(mod).status, undefined);
  assert.equal(c.gameInfo(mod).rating, undefined);
  assert(hosted.some(f => c.gameInfo(f).id === 'kindergarten-2'));
  assert(c.indexListing().games.some(f => f.catalogId === 'brotato'), 'the base game remains a separate entry');
});

test('search, genre, source, compatibility, and ratings work together on the game catalog', () => {
  const c = gameLibrary([{ key: 'Games/balatro.html' }, { key: 'Games/brotatoglm.html' }]);
  c.state.search = 'powerful jokers';
  assert.deepEqual(Array.from(c.visible(), f => f.key), ['Games/balatro.html']);
  c.state.search = ''; c.state.genre = 'Roguelike'; c.state.catalogFilter = 'hosted';
  assert.equal(c.visible().length, 2);
  c.state.catalogFilter = 'unknown';
  assert.deepEqual(Array.from(c.visible(), f => f.name), ['brotatoglm.html']);
  c.state.genre = 'all'; c.state.catalogFilter = 'issues';
  assert(c.visible().some(f => f.catalogId === 'celeste'));
  assert(c.visible().some(f => f.catalogId === '60-seconds'));
  assert(!c.visible().some(f => f.key === 'Games/balatro.html'));
  c.state.catalogFilter = 'all'; c.state.sort = 'rating';
  assert.equal(c.gameInfo(c.visible()[0]).rating, 11);
  c.state.catalogFilter = 'working';
  assert(c.visible().every(f => ['working', 'viewer', 'slow'].includes(c.gameInfo(f).status)));
});

test('original games support Starred and Recent and migrate to hosted replacements', () => {
  const c = gameLibrary();
  c.state.starred.add('special:balatro'); c.state.recent = ['special:balatro'];
  c.state.view = 'starred';
  assert.equal(c.visible()[0].catalogId, 'balatro');
  c.state.view = 'recent';
  assert.equal(c.visible()[0].catalogId, 'balatro');
  c.state.objects = [{ key: 'Games/balatro.html', size: 3210 }].map(c.normalize);
  c.indexListing();
  assert(c.state.starred.has('Games/balatro.html'));
  assert(!c.state.starred.has('special:balatro'));
  assert.deepEqual(Array.from(c.state.recent), ['Games/balatro.html']);
  assert.equal(c.visible()[0].key, 'Games/balatro.html');
});

test('game launches use external HTTPS URLs and retain the user gesture', () => {
  const opened = [], recents = [], messages = [];
  const c = { URL, SUPABASE_URL: 'https://auth.test', window: { open: (...args) => { opened.push(args); return null; } }, markRecent: f => recents.push(f.key), toast: text => messages.push(text) };
  frontSection('const SPECIAL_GAMES=', 'Object.assign(I,', c);
  c.launch({ key: 'Games/balatro.html', publicUrl: 'https://files.test/Games/balatro.html' });
  assert.equal(opened[0][0], 'https://files.test/Games/balatro.html');
  assert.equal(opened[0][2], 'noopener,noreferrer');
  for (const publicUrl of ['javascript:alert(1)', 'data:text/html,test', 'https://auth.test/session']) {
    assert.equal(c.gameLink({ publicUrl }), null);
  }
  c.launch({ key: 'special:missing', virtual: true });
  assert.equal(opened.length, 1);
  assert.equal(recents.length, 1);
  assert.match(messages[0], /No download link/);
});

test('original links never expose storage-management or source-preview actions', async () => {
  const actions = [], writes = [], messages = [];
  const c = { I: {}, state: { canManage: true, starred: new Set() }, menu: entries => actions.push(...entries), gameLink: () => 'https://files.test/game.html', toast: m => messages.push(m), requestAdmin: x => writes.push(x) };
  frontSection('function fileMenu(', 'async function copy(', c);
  const f = { key: 'special:celeste', id: 'special:celeste', virtual: true };
  c.fileMenu(f, 0, 0);
  assert(!actions.some(e => ['trash', 'rename', 'move', 'source'].includes(e[0])));
  await c.dispatch('trash', f);
  assert.equal(writes.length, 0);
  assert.match(messages[0], /managed in the Special Games catalog/);
});

test('preferences validate saved values and catalog visibility respects staff metadata', () => {
  const c=gameLibrary([{key:'Games/balatro.html',metadata:{title:'Custom Balatro',description:'A staff description',genre:'Cards',status:'broken',rating:9,category:'games'}}]);
  const prefs=c.cleanPreferences({startView:'trash',primaryAction:'javascript',includeOriginal:false,hideBroken:true,showRatings:'false',density:'compact'});
  assert.equal(prefs.startView,'games');assert.equal(prefs.primaryAction,'details');assert.equal(prefs.showRatings,true);assert.equal(prefs.density,'compact');
  c.state.preferences=prefs;assert.equal(c.visible().length,0);
  c.state.preferences.hideBroken=false;c.state.search='staff description';
  assert.equal(c.visible()[0].key,'Games/balatro.html');assert.equal(c.libraryTitle(c.visible()[0]),'Custom Balatro');
  c.state.objects=[c.normalize({key:'Games/balatro.html',metadata:{category:'files'}})];c.state.search='';c.state.preferences.includeOriginal=true;
  assert(!c.visible().some(f=>c.gameInfo(f).id==='balatro'),'Drive-only files do not reappear as original-link games');
});

test('per-file opening behavior overrides the browser preference and trash never launches',()=>{
  const calls=[],c={preferences:()=>({primaryAction:'download'}),download:f=>calls.push('download'),launch:f=>calls.push('launch'),details:f=>calls.push('details'),preview:f=>calls.push('preview'),libraryView:()=>true};
  frontSection('function openItem(f)','function preview(f)',c);
  c.openItem({type:'html'});c.openItem({type:'html',metadata:{launchMode:'details'}});c.openItem({type:'html',metadata:{launchMode:'new_tab'}});c.openItem({type:'html',trashed:true,metadata:{launchMode:'new_tab'}});
  assert.deepEqual(calls,['download','details','launch','details']);
});

function metadataFixture(){
  const objects=new Map();let version=0;
  const storage={get:async key=>{const o=objects.get(key);if(!o)throw Object.assign(new Error('Missing'),{name:'NoSuchKey'});return {ETag:o.etag,Body:{transformToString:async()=>o.body}}},put:async(key,body,condition={})=>{const old=objects.get(key);if(condition.IfNoneMatch==='*'&&old||condition.IfMatch&&condition.IfMatch!==old?.etag)throw {$metadata:{httpStatusCode:412}};const etag='"revision-'+(++version)+'"';objects.set(key,{body,etag});return {ETag:etag}}};
  return {store:createMetadataStore(storage),objects};
}

test('file metadata validates fields and rejects unsupported or executable configuration',()=>{
  assert.deepEqual(validateMetadata({title:' Name ',description:'<script>alert(1)</script>',rating:11,status:'working',category:'games',launchMode:'details'}),{title:'Name',description:'<script>alert(1)</script>',rating:11,status:'working',category:'games',launchMode:'details'});
  for(const data of [{title:'x'.repeat(121)},{rating:NaN},{rating:101},{status:'verified'},{launchMode:'javascript:alert(1)'},{launchUrl:'javascript:alert(1)'},JSON.parse('{"__proto__":"x"}'),{constructor:'x'}])assert.throws(()=>validateMetadata(data));
});

test('metadata saves persist independently of file contents and reject stale admin edits',async()=>{
  const {store}=metadataFixture(),key='Games/test.html';assert.equal((await store.read(key)).metadataRevision,null);
  const first=await store.save(key,{title:'First',rating:11},null);
  assert.equal((await store.read(key)).metadata.title,'First');
  await assert.rejects(store.save(key,{title:'Stale'},null),/Someone else changed/);
  await store.save(key,{title:'Second'},first.metadataRevision);
  await assert.rejects(store.save(key,{title:'Old revision'},first.metadataRevision),/Someone else changed/);
  assert.equal((await store.read(key)).metadata.title,'Second');
});

test('metadata follows the same paths as rename, trash and restore, including long Unicode keys',async()=>{
  const {store,objects}=metadataFixture(),key='Games/'+('é'.repeat(400))+'.html',trash='.liminal-trash/id/files/'+key;
  assert((await metadataKey(key)).length<100);
  await store.save(key,{title:'Stored name',description:'Keep this'},null);
  await store.copy(key,'Games/renamed.html');assert.equal((await store.read('Games/renamed.html')).metadata.title,'Stored name');
  await store.copy('Games/renamed.html',trash);await store.copy(trash,'Games/restored.html');
  assert.equal((await store.read('Games/restored.html')).metadata.description,'Keep this');
  const files=[{key:'Games/restored.html',size:20},{key:'Games/plain.html',size:10}];
  await store.attach(files,[...objects.keys()].map(key=>({key})));
  assert.equal(files[0].metadata.title,'Stored name');assert.equal(files[1].metadata,undefined);
});

test('only admins can edit uploaded file details and saves require a revision and an existing file',async()=>{
  for(const role of ['member','mod','manager']){const b=backend({staff_role:role},{existing:true});assert.equal((await b.invoke('update_metadata',{key:'Games/a.html',metadata:{title:'No'},revision:null})).status,403);assert.equal(b.writes.length,0);}
  const b=backend({staff_role:'admin'},{existing:true});
  assert.equal((await b.invoke('update_metadata',{key:'Games/a.html',metadata:{title:'New'}})).status,400);
  assert.equal((await b.invoke('update_metadata',{key:'Games/a.html',metadata:{title:'New'},revision:null})).status,200);
  const write=b.writes.find(x=>x.name==='PutObjectCommand');assert.match(write.input.Key,/^\.liminal-meta\/[a-f0-9]{64}\.json$/);assert.equal(write.input.IfNoneMatch,'*');
  assert.equal((await backend({staff_role:'admin'}).invoke('update_metadata',{key:'missing.html',metadata:{title:'x'},revision:null})).status,404);
});

test('metadata storage paths cannot be supplied through public or admin file endpoints',async()=>{
  const shared=await readFile(new URL('../Backend/edge-functions/liminal-drive/shared.ts',import.meta.url),'utf8');
  const c={TextEncoder};vm.runInNewContext(stripTypeScriptTypes(shared.slice(shared.indexOf('export function keyOf('),shared.indexOf('export const publicUrl')).replace('export ','')),c);
  for(const key of ['.liminal-meta/a.json','Games/.liminal-meta/a.json','.liminal-trash/id/files/a.html'])assert.equal(c.keyOf(key),null);
  assert.equal(c.keyOf('.liminal-meta/a.json',false,true),null);
  assert.equal(c.keyOf('Games/a.html'),'Games/a.html');
});

test('both deployed metadata helpers remain identical and public listings exclude their storage objects',async()=>{
  const a=await readFile(new URL('../Backend/edge-functions/liminal-drive/metadata.ts',import.meta.url),'utf8'),b=await readFile(new URL('../Backend/edge-functions/liminal-drive-admin/metadata.ts',import.meta.url),'utf8');assert.equal(a,b);
  const index=await readFile(new URL('../Backend/edge-functions/liminal-drive/index.ts',import.meta.url),'utf8');assert.match(index,/!o\.key\.startsWith\(METADATA_PREFIX\)/);
  assert(!driveHtml.includes('Your next good game.'));assert(!driveHtml.includes('Tools worth keeping.'));
});

test('admin operations preserve file bytes and metadata through rename, trash, restore and permanent deletion',async()=>{
  const objects=new Map([['Games/a.html','<h1>Original game</h1>']]),b=backend({staff_role:'admin'},{objects});
  let r=await b.invoke('update_metadata',{key:'Games/a.html',metadata:{title:'Admin title'},revision:null});assert.equal(r.status,200);assert.equal(objects.get('Games/a.html'),'<h1>Original game</h1>');
  r=await b.invoke('rename',{key:'Games/a.html',new_key:'Games/renamed.html'});assert.equal(r.status,200);
  assert(!objects.has(await metadataKey('Games/a.html')));
  r=await b.invoke('get_metadata',{key:'Games/renamed.html'});assert.equal((await r.json()).metadata.title,'Admin title');
  const trashed=await (await b.invoke('trash',{key:'Games/renamed.html'})).json();assert(trashed.ok);
  assert(!objects.has(await metadataKey('Games/renamed.html')),'new files at the old path cannot inherit the trashed metadata');
  const trashFile='.liminal-trash/'+trashed.id+'/files/Games/renamed.html';assert(objects.has(await metadataKey(trashFile)));
  r=await b.invoke('restore',{id:trashed.id});assert.equal(r.status,200);assert.equal(objects.get('Games/renamed.html'),'<h1>Original game</h1>');
  assert(!objects.has(await metadataKey(trashFile)));
  r=await b.invoke('get_metadata',{key:'Games/renamed.html'});assert.equal((await r.json()).metadata.title,'Admin title');
  const again=await (await b.invoke('trash',{key:'Games/renamed.html'})).json();await b.invoke('delete_trash',{id:again.id});
  assert.equal(objects.size,0,'permanent deletion also removes sidecars and trash manifests');
});

test('the public API returns shared customization without exposing internal metadata objects',async()=>{
  const objects=new Map([['Games/a.html','<h1>Game</h1>']]),b=backend({staff_role:'admin'},{objects});
  await b.invoke('update_metadata',{key:'Games/a.html',metadata:{title:'Shared title',status:'working'},revision:null});
  const publicSource=await readFile(new URL('../Backend/edge-functions/liminal-drive/index.ts',import.meta.url),'utf8');let handler;
  const c={...b.context,Deno:{serve:fn=>handler=fn}};
  c.HeadObjectCommand=class{constructor(input){this.input=input;this.name='HeadObjectCommand'}};
  vm.runInNewContext(stripTypeScriptTypes(publicSource.replace(/^import .*;$/gm,'')),c);
  const response=await handler(new Request('https://drive.test/')),data=await response.json();assert.equal(response.status,200);
  assert.equal(data.files.length,1);assert.equal(data.files[0].metadata.title,'Shared title');assert.equal(data.features.fileMetadata,true);
});

test('Settings is a separate sidebar button beside the account, with no duplicate toolbar controls',()=>{
  const body=driveHtml.slice(driveHtml.indexOf('<body>'),driveHtml.indexOf('<script',driveHtml.indexOf('<body>'))),stack=[],nodes=[];
  const voids=new Set(['input','img','br','hr','meta','link','source','area','base','embed','param','track','wbr']);
  for(const m of body.matchAll(/<\/?([a-z][a-z0-9-]*)\b([^>]*)>/gi)){
    const tag=m[1].toLowerCase();if(m[0].startsWith('</')){const i=stack.map(x=>x.tag).lastIndexOf(tag);if(i>=0)stack.length=i;continue;}
    const id=m[2].match(/\bid="([^"]*)"/)?.[1],node={tag,id,parents:stack.map(x=>({...x})),className:m[2].match(/\bclass="([^"]*)"/)?.[1]||''};
    if(tag==='button')assert(!stack.some(x=>x.tag==='button'),'buttons are never nested');
    if(id)nodes.push(node);if(!voids.has(tag)&&!m[0].endsWith('/>'))stack.push({tag,id,className:node.className});
  }
  const settings=nodes.filter(n=>n.id==='settingsBtn');assert.equal(settings.length,1);assert.equal(settings[0].tag,'button');
  assert(settings[0].parents.some(n=>n.tag==='aside'));assert(settings[0].parents.some(n=>n.className.split(' ').includes('self-card')));
  assert(!nodes.some(n=>n.id==='themeBtn'),'theme belongs to Settings');
  assert.equal(nodes.find(n=>n.id==='sidebarAccount').tag,'button');
});

test('resetting settings selects defaults without applying or changing current preferences',()=>{
  const c=gameLibrary(),fields=new Map();c.state.preferences={...c.defaultPreferences(),density:'compact',hideBroken:true};
  for(const [name,value]of Object.entries({...c.defaultPreferences(),libraryLayout:'list',fileLayout:'grid',theme:'rose'}))fields.set(name,{type:typeof value==='boolean'?'checkbox':'select',value:'old',checked:false});
  c.resetSettingsForm({elements:{namedItem:name=>fields.get(name)}});
  assert.equal(fields.get('libraryLayout').value,'grid');assert.equal(fields.get('fileLayout').value,'list');assert.equal(fields.get('theme').value,'midnight');
  assert.equal(fields.get('includeOriginal').checked,true);assert.equal(fields.get('hideBroken').checked,false);
  assert.equal(c.state.preferences.density,'compact');assert.equal(c.state.preferences.hideBroken,true,'nothing applies until Save settings');
});

test('the file editor locks fields during fetch and save while leaving a retry available on failure',()=>{
  const fields=[{name:'title'},{name:'description'}],elements=new Map(['#saveCustomization','#resetCustomization','#reloadCustomization','#customLoading'].map(k=>[k,{}]));
  const form={elements:fields,setAttribute(k,v){this[k]=v},querySelector:key=>elements.get(key)},c={};
  frontSection('function setEditorState(', 'async function customizeFile(',c);
  c.setEditorState(form,'loading',false);assert(fields.every(f=>f.disabled));assert.equal(form['aria-busy'],'true');assert.match(elements.get('#customLoading').textContent,/Loading/);
  c.setEditorState(form,'idle',false);assert.equal(elements.get('#saveCustomization').disabled,true);assert.equal(elements.get('#reloadCustomization').disabled,false);
  c.setEditorState(form,'idle',true);assert(fields.every(f=>!f.disabled));assert.equal(elements.get('#saveCustomization').disabled,false);
  c.setEditorState(form,'saving',true);assert(fields.every(f=>f.disabled));assert.equal(elements.get('#saveCustomization').textContent,'Saving…');
  c.setEditorState(form,'idle',true);assert.equal(elements.get('#customLoading').textContent,'');assert.equal(elements.get('#saveCustomization').textContent,'Save changes');
});

test('closing a dialog returns focus to its visible trigger or to mobile navigation',()=>{
  const calls=[],toggle={getClientRects:()=>[{}],focus:()=>calls.push('navigation')},c={$:()=>toggle};
  frontSection('function restoreDialogFocus(', 'function closeModal(',c);
  c.restoreDialogFocus({isConnected:true,getClientRects:()=>[{}],focus:()=>calls.push('settings')});
  c.restoreDialogFocus({isConnected:true,getClientRects:()=>[],focus:()=>calls.push('hidden')});
  assert.deepEqual(calls,['settings','navigation']);
});
