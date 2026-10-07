import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, verify, moveVerified } from './storage-api.mjs';

export function safePath(path, { prefix = false } = {}) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /[\\\x00-\x1f?#]/.test(path)) throw new Error('Invalid artifact path.');
  const parts = (prefix ? path.replace(/\/$/, '') : path).split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid artifact path.');
  return path;
}

export function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.deployments) || !manifest.deployments.length) throw new Error('Invalid deployment manifest.');
  const apps = new Set(), sources = new Set(), targets = new Set();
  for (const item of manifest.deployments) {
    if (!/^[a-z][a-z0-9-]*$/.test(item.app) || apps.has(item.app)) throw new Error('Invalid or duplicate app name.');
    if (item.target !== 'supabase-storage' || !/^[a-z0-9-]+$/.test(item.bucket) || typeof item.enabled !== 'boolean') throw new Error('Invalid deployment target.');
    safePath(item.source); safePath(item.objectPath); safePath(item.historyPrefix, { prefix: true });
    if (!['.html', '.htm'].includes(extname(item.source)) || extname(item.source) !== extname(item.objectPath)) throw new Error('Expected an HTML artifact with a matching destination extension.');
    if (item.historyPrefix !== `deployments/${item.app}/` || item.objectPath.includes('/')) throw new Error('Expected a canonical root object and app-specific history folder.');
    const target = `${item.bucket}/${item.objectPath}`;
    if (sources.has(item.source) || targets.has(target)) throw new Error('Duplicate artifact source or destination.');
    apps.add(item.app); sources.add(item.source); targets.add(target);
  }
  return manifest;
}

export function validateHtml(bytes) {
  if (!bytes.length || bytes.length > 50 * 1024 * 1024 || !/<html(?:\s|>)/i.test(bytes.toString('utf8'))) throw new Error('Artifact must be a nonempty HTML document under 50 MiB.');
}

export async function loadArtifact(item, root = process.cwd()) {
  const base = await realpath(root);
  const file = await realpath(resolve(base, item.source));
  const rel = relative(base, file);
  if (rel.startsWith('../') || rel === '..') throw new Error('Artifact resolves outside the repository.');
  const bytes = await readFile(file);
  validateHtml(bytes);
  return bytes;
}

export function validateHistory(item, history) {
  safePath(history);
  if (!history.startsWith(item.historyPrefix) || !['.html', '.htm'].includes(extname(history)) || history === item.objectPath) throw new Error('Rollback requires an HTML artifact in this app\'s history folder.');
  if (history.slice(item.historyPrefix.length).includes('/')) throw new Error('Choose an artifact directly in the app history folder.');
}

export async function publish({ storage, item, bytes, commit = 'local', mode = 'deploy', history = null, dryRun = false, checkCancelled = () => {}, onReport = async () => {}, log = console.log, verifyOptions }) {
  validateHtml(bytes);
  const hash = sha256(bytes);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${commit.slice(0,12).replace(/[^a-zA-Z0-9-]/g, '')}-${randomUUID()}`;
  const stem = `${item.historyPrefix}${id}`;
  const report = { app: item.app, mode, source: item.source, commit, bucket: item.bucket, objectPath: item.objectPath, sha256: hash, deployedAt: null, historySource: history, archivePath: `${stem}-previous${extname(item.objectPath)}`, temporaryPath: `${stem}-incoming${extname(item.objectPath)}`, failedPath: `${stem}-failed${extname(item.objectPath)}`, recordPath: `${stem}.json`, status: 'preflight' };
  const checkpoint = async status => { report.status = status; await onReport({ ...report }); };
  await storage.preflight();
  const old = await storage.read(item.objectPath);
  const oldHash = old === null ? null : sha256(old);
  report.previousSha256 = oldHash;
  if (dryRun) { await checkpoint('dry-run'); return report; }
  if (oldHash === hash) {
    await verify(storage, item.objectPath, hash, { ...verifyOptions, publicUrl: true });
    await checkpoint('unchanged'); return report;
  }
  checkCancelled();
  // A fresh journal survives a killed runner, even when its local report does not.
  await checkpoint('prepared');
  await storage.upload(`${stem}-prepared.json`, Buffer.from(JSON.stringify(report, null, 2)), 'application/json');
  log(`Recovery archive: ${report.archivePath}`);
  let archiveAttempted = false, promotionAttempted = false;
  try {
    if (old !== null) {
      // Refuse if a manual Storage edit changed the object since preflight.
      await verify(storage, item.objectPath, oldHash, verifyOptions);
      checkCancelled();
      archiveAttempted = true;
      await checkpoint('archiving');
      await moveVerified(storage, item.objectPath, report.archivePath, oldHash, verifyOptions);
    }
    checkCancelled();
    await checkpoint('uploading');
    await storage.upload(report.temporaryPath, bytes);
    await verify(storage, report.temporaryPath, hash, verifyOptions);
    checkCancelled();
    await checkpoint('promoting');
    promotionAttempted = true;
    await moveVerified(storage, report.temporaryPath, item.objectPath, hash, verifyOptions);
    await verify(storage, item.objectPath, hash, { ...verifyOptions, publicUrl: true });
  } catch (failure) {
    report.error = failure.message;
    try {
      await checkpoint('recovering');
      const archived = archiveAttempted ? await storage.read(report.archivePath) : null;
      const current = await storage.read(item.objectPath);
      if (archived !== null) {
        if (sha256(archived) !== oldHash) throw new Error('Recovery archive hash differs from the original.');
        if (current !== null && sha256(current) !== oldHash) {
          if (!promotionAttempted) throw new Error('Unexpected canonical object appeared before promotion; recover manually.');
          await moveVerified(storage, item.objectPath, report.failedPath, sha256(current), verifyOptions);
        }
        if (current === null || sha256(current) !== oldHash) await moveVerified(storage, report.archivePath, item.objectPath, oldHash, verifyOptions);
        await verify(storage, item.objectPath, oldHash, verifyOptions);
        await checkpoint('rolled-back');
      } else if (old !== null) {
        if (current === null || sha256(current) !== oldHash) throw new Error('Previous version is not at its original or archive path; recover manually.');
        await checkpoint('failed-no-change');
      } else {
        if (current !== null) {
          if (!promotionAttempted) throw new Error('Unexpected canonical object on first deployment; recover manually.');
          await moveVerified(storage, item.objectPath, report.failedPath, sha256(current), verifyOptions);
        }
        await checkpoint('failed-first-deploy');
      }
    } catch (recoveryFailure) {
      report.recoveryError = recoveryFailure.message;
      await checkpoint('recovery-failed');
      throw new Error(`Deployment failed AND recovery failed. Restore ${report.archivePath} manually; see the deployment report.`);
    }
    throw new Error(`Deployment failed (${report.status}); see the deployment report.`);
  }
  // The HTML is committed after both authenticated and public verification.
  // A later metadata error must never roll back an already verified deployment.
  report.deployedAt = new Date().toISOString();
  await checkpoint('deployed');
  try {
    await storage.upload(report.recordPath, Buffer.from(JSON.stringify(report, null, 2)), 'application/json');
  } catch {
    report.warning = 'HTML verified, but the Storage deployment record could not be saved. Keep the GitHub report.';
    log(`::warning::${report.warning}`);
    await onReport({ ...report });
  }
  return report;
}
