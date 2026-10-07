import test from 'node:test';
import assert from 'node:assert/strict';
import { publish, validateHistory, validateManifest, validateHtml } from './deployment.mjs';
import { Storage, credentialHeaders, sha256 } from './storage-api.mjs';

const old = Buffer.from('<html>old</html>');
const fresh = Buffer.from('<html>new</html>');
const item = { app: 'chat', source: 'Chat/chat.html', bucket: 'liminal-apps', target: 'supabase-storage', objectPath: 'chat.html', historyPrefix: 'deployments/chat/', enabled: true };
const options = { attempts: 1, delay: async () => {} };

class MemoryStorage {
  constructor(initial = old) {
    this.objects = new Map(initial === null ? [] : [['chat.html', initial]]);
    this.operations = [];
    this.before = async () => {};
    this.after = async () => {};
  }
  async preflight() { await this.before('preflight'); }
  async info(path) { await this.before('info', path); return this.objects.has(path) ? { id: path } : null; }
  async read(path) { return await this.info(path) ? this.download(path) : null; }
  async download(path, options = {}) {
    await this.before(options.publicUrl ? 'public' : 'download', path);
    if (!this.objects.has(path)) throw new Error('Missing');
    return this.objects.get(path);
  }
  async upload(path, bytes) {
    await this.before('upload', path);
    assert.equal(this.objects.has(path), false, 'never overwrite any object');
    this.objects.set(path, bytes);
    this.operations.push(['upload', path]);
    await this.after('upload', path);
  }
  async move(from, to) {
    await this.before('move', from, to);
    assert.equal(this.objects.has(from), true);
    assert.equal(this.objects.has(to), false, 'never overwrite a destination');
    this.objects.set(to, this.objects.get(from));
    this.objects.delete(from);
    this.operations.push(['move', from, to]);
    await this.after('move', from, to);
  }
}

async function run(storage, extra = {}) {
  let report;
  try {
    const result = await publish({ storage, item, bytes: fresh, verifyOptions: options, log: () => {}, onReport: async value => { report = value; }, ...extra });
    return { result, report };
  } catch (error) { return { error, report }; }
}

test('archive, fresh upload, promote and verify; keep previous history and report', async () => {
  const storage = new MemoryStorage();
  const { result, error } = await run(storage);
  assert.equal(error, undefined);
  assert.equal(result.status, 'deployed');
  assert.deepEqual(storage.objects.get('chat.html'), fresh);
  assert.deepEqual(storage.objects.get(result.archivePath), old);
  assert.equal(storage.objects.has(result.temporaryPath), false);
  const mutations = storage.operations.filter(([op, path]) => !path.endsWith('.json'));
  assert.deepEqual(mutations.map(([op]) => op), ['move', 'upload', 'move']);
  assert.equal(JSON.parse(storage.objects.get(result.recordPath)).sha256, sha256(fresh));
});

test('dry run does not write even a journal', async () => {
  const storage = new MemoryStorage();
  const { result } = await run(storage, { dryRun: true });
  assert.equal(result.status, 'dry-run');
  assert.equal(storage.operations.length, 0);
});

test('identical artifact is verified without replacing it', async () => {
  const storage = new MemoryStorage(fresh);
  const { result } = await run(storage);
  assert.equal(result.status, 'unchanged');
  assert.equal(storage.operations.length, 0);
});

test('first deployment needs no previous object', async () => {
  const storage = new MemoryStorage(null);
  const { result } = await run(storage);
  assert.equal(result.status, 'deployed');
  assert.deepEqual(storage.objects.get('chat.html'), fresh);
});

for (const stage of ['upload', 'promotion', 'public-verification', 'interruption']) {
  test(`${stage} failure restores the old canonical file`, async () => {
    const storage = new MemoryStorage();
    let failed = false;
    storage.before = async (op, path, to) => {
      if (!failed && ((stage === 'upload' && op === 'upload' && path.includes('-incoming')) || (stage === 'promotion' && op === 'move' && to === 'chat.html') || (stage === 'public-verification' && op === 'public'))) {
        failed = true; throw new Error('Injected failure');
      }
    };
    let checks = 0;
    const { error, report } = await run(storage, { checkCancelled: () => { if (stage === 'interruption' && ++checks === 3) throw new Error('Interrupted'); } });
    assert.ok(error);
    assert.equal(report.status, 'rolled-back');
    assert.deepEqual(storage.objects.get('chat.html'), old);
  });
}

for (const stage of ['archive', 'promotion']) {
  test(`lost ${stage} response is reconciled without a duplicate move`, async () => {
    const storage = new MemoryStorage();
    let lost = false;
    storage.after = async (op, from, to) => {
      if (!lost && op === 'move' && (stage === 'archive' ? to.includes('-previous') : to === 'chat.html')) {
        lost = true; throw new Error('Response lost after server committed');
      }
    };
    const { result, error } = await run(storage);
    assert.equal(error, undefined);
    assert.equal(result.status, 'deployed');
    assert.equal(storage.operations.filter(([op]) => op === 'move').length, 2);
  });
}

test('archive failure before a move leaves production untouched', async () => {
  const storage = new MemoryStorage();
  storage.before = async (op, from, to) => { if (op === 'move' && to.includes('-previous')) throw new Error('Archive failed'); };
  const { error, report } = await run(storage);
  assert.ok(error);
  assert.equal(report.status, 'failed-no-change');
  assert.deepEqual(storage.objects.get('chat.html'), old);
});

test('corrupt temporary upload is rejected before promotion', async () => {
  const storage = new MemoryStorage();
  storage.after = async (op, path) => { if (op === 'upload' && path.includes('-incoming')) storage.objects.set(path, Buffer.from('corrupt')); };
  const { error, report } = await run(storage);
  assert.ok(error);
  assert.equal(report.status, 'rolled-back');
  assert.deepEqual(storage.objects.get('chat.html'), old);
});

test('failed recovery is explicitly reported and retains the archive', async () => {
  const storage = new MemoryStorage();
  storage.before = async (op, path, to) => {
    if (op === 'upload' && path.includes('-incoming')) throw new Error('Upload failed');
    if (op === 'move' && to === 'chat.html') throw new Error('Restore failed');
  };
  const { error, report } = await run(storage);
  assert.match(error.message, /AND recovery failed/);
  assert.equal(report.status, 'recovery-failed');
  assert.deepEqual(storage.objects.get(report.archivePath), old);
});

test('metadata failure after verification does not undo the published HTML', async () => {
  const storage = new MemoryStorage();
  storage.before = async (op, path) => { if (op === 'upload' && path.endsWith('.json') && !path.includes('-prepared')) throw new Error('Metadata failed'); };
  const { result } = await run(storage);
  assert.equal(result.status, 'deployed');
  assert.ok(result.warning);
  assert.deepEqual(storage.objects.get('chat.html'), fresh);
});

test('first-deployment public verification failure removes failed canonical by moving it aside', async () => {
  const storage = new MemoryStorage(null);
  storage.before = async op => { if (op === 'public') throw new Error('Bad public copy'); };
  const { error, report } = await run(storage);
  assert.ok(error);
  assert.equal(report.status, 'failed-first-deploy');
  assert.equal(storage.objects.has('chat.html'), false);
  assert.deepEqual(storage.objects.get(report.failedPath), fresh);
});

test('rollback validates app scope and preserves the selected history object', async () => {
  const history = 'deployments/chat/earlier-previous.html';
  validateHistory(item, history);
  assert.throws(() => validateHistory(item, 'deployments/drive/old.html'));
  assert.throws(() => validateHistory(item, 'deployments/chat/../old.html'));
  const storage = new MemoryStorage(fresh);
  storage.objects.set(history, old);
  const { result } = await run(storage, { bytes: old, mode: 'rollback', history });
  assert.equal(result.status, 'deployed');
  assert.deepEqual(storage.objects.get(history), old);
  assert.deepEqual(storage.objects.get(result.archivePath), fresh);
});

test('manifest rejects duplicate destinations, traversals and empty documents', () => {
  assert.throws(() => validateManifest({ schemaVersion: 1, deployments: [item, { ...item, app: 'other', source: 'Other/chat.html', historyPrefix: 'deployments/other/' }] }));
  assert.throws(() => validateManifest({ schemaVersion: 1, deployments: [{ ...item, source: '../chat.html' }] }));
  assert.throws(() => validateHtml(Buffer.from('')));
});

test('server credential formats and request encoding', async () => {
  assert.deepEqual(credentialHeaders('sb_secret_test'), { apikey: 'sb_secret_test' });
  assert.throws(() => credentialHeaders('sb_publishable_test'));
  const jwt = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
  assert.equal(credentialHeaders(jwt).Authorization, `Bearer ${jwt}`);
  const requests = [];
  const storage = new Storage({ url: 'https://example.supabase.co', key: 'sb_secret_test', bucket: 'liminal-apps', fetchImpl: async (url, request) => { requests.push({ url, request }); return Response.json({ id: 'ok' }); } });
  await storage.upload('folder/My file.html', fresh);
  await storage.move('old.html', 'history/new.html');
  assert.match(requests[0].url, /folder\/My%20file.html$/);
  assert.equal(requests[0].request.headers['x-upsert'], 'false');
  assert.equal(requests[0].request.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(requests[1].request.body), { bucketId: 'liminal-apps', sourceKey: 'old.html', destinationKey: 'history/new.html' });
});

test('only an explicit missing-object error counts as absence', async () => {
  const make = (status, code) => new Storage({ url: 'https://example.supabase.co', key: 'sb_secret_test', bucket: 'liminal-apps', fetchImpl: async () => Response.json({ code }, { status }) });
  assert.equal(await make(404, 'NoSuchKey').info('chat.html'), null);
  for (const [status, code] of [[403, 'AccessDenied'], [404, 'NoSuchBucket'], [404, 'Unknown'], [401, 'InvalidJWT']]) await assert.rejects(make(status, code).info('chat.html'));
});

test('authentication failure never mutates production', async () => {
  const storage = new MemoryStorage();
  storage.before = async op => { if (op === 'preflight') throw new Error('Unauthorized'); };
  const { error } = await run(storage);
  assert.ok(error);
  assert.equal(storage.operations.length, 0);
});

test('full publish uses the real REST client against a fake Storage server', async () => {
  const objects = new Map([['chat.html', old]]);
  const requests = [];
  const storage = new Storage({ url: 'https://example.supabase.co', key: 'sb_secret_test', bucket: 'liminal-apps', fetchImpl: async (url, request) => {
    const route = decodeURIComponent(new URL(url).pathname.replace('/storage/v1/', ''));
    requests.push([request.method, route]);
    if (route === 'bucket/liminal-apps') return Response.json({ id: 'liminal-apps', public: true });
    if (route.startsWith('object/info/liminal-apps/')) {
      const path = route.replace('object/info/liminal-apps/', '');
      return objects.has(path) ? Response.json({ id: path }) : Response.json({ code: 'NoSuchKey' }, { status: 404 });
    }
    if (route === 'object/move') {
      const { sourceKey, destinationKey } = JSON.parse(request.body);
      if (!objects.has(sourceKey) || objects.has(destinationKey)) return Response.json({ code: 'InvalidRequest' }, { status: 400 });
      objects.set(destinationKey, objects.get(sourceKey)); objects.delete(sourceKey);
      return Response.json({ message: 'Successfully moved' });
    }
    const path = route.replace(/^object\/(public\/)?liminal-apps\//, '');
    if (request.method === 'POST') {
      assert.equal(request.headers['x-upsert'], 'false');
      if (objects.has(path)) return Response.json({ code: 'ResourceAlreadyExists' }, { status: 409 });
      objects.set(path, request.body);
      return Response.json({ Id: path, Key: `liminal-apps/${path}` });
    }
    return objects.has(path) ? new Response(objects.get(path)) : Response.json({ code: 'NoSuchKey' }, { status: 404 });
  } });
  const { result, error } = await run(storage);
  assert.equal(error, undefined);
  assert.equal(result.status, 'deployed');
  assert.deepEqual(objects.get('chat.html'), fresh);
  assert.ok(requests.some(([method, route]) => method === 'GET' && route === 'object/public/liminal-apps/chat.html'));
});
