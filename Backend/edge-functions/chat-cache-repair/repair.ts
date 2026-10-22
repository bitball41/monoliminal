// One-time repair of public migrated assets. Storage's copy API updates the
// backing object's HTTP headers; changing storage.objects.metadata alone does not.
const BUCKETS = new Set(['liminal-media', 'liminal-pfp', 'liminal-stickers']);
export const CACHE_CONTROL = 'max-age=604800';
const encoder = new TextEncoder();

export function cacheRepairHandler(config: {
  projectUrl: string; serviceKey: string;
  tokenHash: string; expiresAt: number; fetchImpl?: typeof fetch;
}) {
  const request = config.fetchImpl || fetch;
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  return async (req: Request) => {
    if (!config.tokenHash || Date.now() >= config.expiresAt) return json({ error: 'Maintenance disabled' }, 410);
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
    const token = req.headers.get('authorization')?.replace(/^Bearer /, '') || '';
    if (token.length > 256) return json({ error: 'Unauthorized' }, 401);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (digest !== config.tokenHash) return json({ error: 'Unauthorized' }, 401);
    if (!config.serviceKey) return json({ error: 'Server credentials unavailable' }, 503);
    let items, probe = false;
    try { const body = await req.json(); items = body.items; probe = body.probe === true; } catch { return json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(items) || !items.length || items.length > 20 || items.some(item =>
      !BUCKETS.has(item.bucket) || typeof item.name !== 'string' || !item.name ||
      !/^[0-9a-f-]{36}$/i.test(item.owner) || typeof item.version !== 'string' ||
      !Number.isSafeInteger(item.size) || item.size < 0)) return json({ error: 'Invalid manifest' }, 400);

    const results = [];
    for (const item of items) {
      const path = `${encodeURIComponent(item.bucket)}/${item.name.split('/').map(encodeURIComponent).join('/')}`;
      try {
        // An ownerless service-role upsert omits owner columns, preserving
        // the existing owner on a same-key copy. Verify the result below.
        const headers: Record<string, string> = { apikey: config.serviceKey };
        if (!config.serviceKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${config.serviceKey}`;
        // Inspect the current object first. Refuse changed versions or sizes.
        const info = await request(`${config.projectUrl}/storage/v1/object/info/${path}`, { headers });
        if (!info.ok) throw new Error('info_failed_' + info.status);
        const object = await info.json();
        if (Number(object.metadata?.size ?? object.size) !== item.size) throw new Error('object_changed');
        if (object.cache_control === CACHE_CONTROL || object.metadata?.cacheControl === CACHE_CONTROL || object.cacheControl === CACHE_CONTROL) {
          results.push({ name: item.name, status: 'already_cached' }); continue;
        }
        if (object.version !== item.version) throw new Error('object_changed');
        const copied = await request(`${config.projectUrl}/storage/v1/object/copy`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'x-upsert': 'true',
            'x-metadata': btoa(unescape(encodeURIComponent(JSON.stringify(item.userMetadata || {})))) },
          body: JSON.stringify({ bucketId: item.bucket, sourceKey: item.name, sourceVersionId: item.version,
            destinationKey: item.name, copyMetadata: false, metadata: { cacheControl: CACHE_CONTROL } }),
        });
        if (!copied.ok) {
          const reason = await copied.json().catch(() => ({}));
          throw new Error('copy_failed_' + copied.status + ':' + String(reason.code || reason.error || '').slice(0, 80));
        }
        const result = await copied.json();
        if (Number(result.metadata?.size) !== item.size || result.owner_id !== item.owner ||
          (item.etag && result.metadata?.eTag !== item.etag)) throw new Error('verification_failed');
        let servedCacheControl;
        if (probe) {
          const served = await request(`${config.projectUrl}/storage/v1/object/public/${path}?cache_probe=${result.version}`, { headers: { Range: 'bytes=0-0' } });
          servedCacheControl = served.headers.get('cache-control');
          await served.body?.cancel();
        }
        results.push({ name: item.name, status: 'repaired', servedCacheControl });
      } catch (error) {
        results.push({ name: item.name, status: 'failed', error: error instanceof Error ? error.message : 'failed' });
        // Stop the batch at the first failure; no blind mutation retries.
        break;
      }
    }
    return json({ results });
  };
}
