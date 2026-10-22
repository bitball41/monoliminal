import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cacheRepairHandler, CACHE_CONTROL } from '../Backend/edge-functions/chat-cache-repair/repair.ts';

const token = 'fixture-secret';
const item = { bucket: 'liminal-pfp', name: 'user/avatar.gif', owner: '00000000-0000-4000-8000-000000000001', version: 'original', size: 123, userMetadata: { label: 'Café' } };
const req = (items = [item], auth = token) => new Request('https://fixture.invalid/repair', {
  method: 'POST', headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
});
const config = { projectUrl: 'https://fixture.invalid', serviceKey: 'fixture-server-key',
  tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 60000 };

test('repair is disabled by default, authenticates before reading data, and excludes private/app buckets', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not call'); };
  assert.equal((await cacheRepairHandler({ ...config, tokenHash: '', fetchImpl })(req())).status, 410);
  assert.equal((await cacheRepairHandler({ ...config, fetchImpl })(req([item], 'wrong'))).status, 401);
  for (const bucket of ['liminal-apps', 'liminal-group-media'])
    assert.equal((await cacheRepairHandler({ ...config, fetchImpl })(req([{ ...item, bucket }]))).status, 400);
  assert.equal((await cacheRepairHandler({ ...config, serviceKey: '', fetchImpl })(req())).status, 503);
  assert.equal(calls, 0);
});

test('repair uses a server-side copy with original owner, bytes and custom metadata preserved', async () => {
  const calls = [];
  const handler = cacheRepairHandler({ ...config, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return Response.json({ version: 'original', metadata: { size: 123, cacheControl: 'max-age=0' } });
    return Response.json({ owner_id: item.owner, metadata: { size: 123, cacheControl: CACHE_CONTROL } });
  } });
  assert.equal((await (await handler(req())).json()).results[0].status, 'repaired');
  const copy = calls[1];
  const body = JSON.parse(copy.options.body);
  assert.equal(body.sourceKey, body.destinationKey);
  assert.equal(body.sourceVersionId, item.version);
  assert.equal(body.metadata.cacheControl, CACHE_CONTROL);
  assert.equal(body.copyMetadata, false);
  assert.equal(copy.options.headers.Authorization, 'Bearer fixture-server-key');
  assert.deepEqual(JSON.parse(Buffer.from(copy.options.headers['x-metadata'], 'base64').toString()), item.userMetadata);
});

test('repair refuses changed objects and stops a batch on an error', async () => {
  let calls = 0;
  const handler = cacheRepairHandler({ ...config, fetchImpl: async () => { calls++; return Response.json({ version: 'newer', size: 123 }); } });
  const { results } = await (await handler(req([item, item]))).json();
  assert.equal(calls, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].error, 'object_changed');
});
