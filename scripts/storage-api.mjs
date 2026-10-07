// Dependency-free implementation of the Supabase Storage REST operations.
// Request shapes match supabase/storage-js (see docs/deployment.md).
import { randomUUID, createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const encodePath = path => path.split('/').map(encodeURIComponent).join('/');

export function credentialHeaders(key) {
  if (!key || /\s/.test(key)) throw new Error('Set SUPABASE_DEPLOY_KEY to a server-only secret or service_role key.');
  if (key.startsWith('sb_secret_')) return { apikey: key };
  try {
    const parts = key.split('.');
    if (parts.length === 3 && JSON.parse(Buffer.from(parts[1], 'base64url')).role === 'service_role') {
      return { apikey: key, Authorization: `Bearer ${key}` };
    }
  } catch { /* Reject public keys and malformed credentials without logging them. */ }
  throw new Error('SUPABASE_DEPLOY_KEY must be a secret or legacy service_role key, not a public key.');
}

export class StorageError extends Error {
  constructor(method, status, code) {
    const safeCode = /^[a-zA-Z0-9_]+$/.test(code ?? '') ? code : 'Unknown';
    super(`Storage ${method} failed (HTTP ${status}, ${safeCode}).`);
    this.status = status;
    this.code = safeCode;
  }
}

export class Storage {
  constructor({ url, key, bucket, fetchImpl = fetch, timeoutMs = 20000 }) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new Error('SUPABASE_URL must be an HTTPS project origin, without a path or query.');
    }
    this.base = `${parsed.origin}/storage/v1`;
    this.headers = credentialHeaders(key);
    this.bucket = bucket;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(route, { method = 'GET', body, headers = {}, binary = false, authenticated = true } = {}) {
    let response;
    try {
      response = await this.fetch(`${this.base}/${route}`, {
        method, body,
        headers: { ...(authenticated ? this.headers : {}), ...headers },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new StorageError(method, response.status, error.code ?? error.error);
      }
      return binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      // Fetch errors can embed request/response details. Never print those.
      throw new Error(`Storage ${method} network/response failure; the operation may have completed.`);
    }
  }

  async preflight() {
    const bucket = await this.request(`bucket/${encodeURIComponent(this.bucket)}`);
    if (bucket.id !== this.bucket || bucket.public !== true) {
      throw new Error('Expected the configured public app bucket. Refusing deployment.');
    }
    return bucket;
  }

  async info(path) {
    try {
      return await this.request(`object/info/${encodeURIComponent(this.bucket)}/${encodePath(path)}`);
    } catch (error) {
      // Only explicit missing-object codes count as absence. A generic 404,
      // NoSuchBucket, an authorization error or a network error is fatal.
      if (error instanceof StorageError && [400, 404].includes(error.status) && ['NoSuchKey', 'not_found'].includes(error.code)) return null;
      throw error;
    }
  }

  async download(path, { publicUrl = false } = {}) {
    const route = `object/${publicUrl ? 'public/' : ''}${encodeURIComponent(this.bucket)}/${encodePath(path)}`;
    return this.request(`${route}?liminal_verify=${randomUUID()}`, {
      binary: true, authenticated: !publicUrl,
      headers: { 'Cache-Control': 'no-cache' },
    });
  }

  async read(path) {
    return await this.info(path) ? this.download(path) : null;
  }

  async upload(path, bytes, contentType = 'text/html;charset=UTF-8') {
    return this.request(`object/${encodeURIComponent(this.bucket)}/${encodePath(path)}`, {
      method: 'POST', body: bytes,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'max-age=0', 'x-upsert': 'false' },
    });
  }

  async move(from, to) {
    return this.request('object/move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucketId: this.bucket, sourceKey: from, destinationKey: to }),
    });
  }
}

export async function verify(storage, path, expectedHash, { publicUrl = false, attempts = 3, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      if (sha256(await storage.download(path, { publicUrl })) !== expectedHash) throw new Error('Downloaded artifact hash differs from source.');
      return;
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await delay(1000 * (i + 1));
    }
  }
  throw lastError;
}

export async function moveVerified(storage, from, to, expectedHash, verifyOptions) {
  let requestError;
  try { await storage.move(from, to); } catch (error) { requestError = error; }
  // Reconcile an ambiguous response using both paths; never blindly repeat a move.
  try {
    await verify(storage, to, expectedHash, verifyOptions);
    if (await storage.info(from)) throw new Error('Move source still exists; refusing to continue.');
  } catch (error) {
    throw requestError ?? error;
  }
}
