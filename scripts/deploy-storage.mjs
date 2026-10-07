import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Storage } from './storage-api.mjs';
import { validateManifest, loadArtifact, validateHistory, validateHtml, publish } from './deployment.mjs';

const env = process.env;
const app = env.DEPLOY_APP ?? process.argv[2];
const mode = env.DEPLOY_MODE ?? 'deploy';
const dryRun = env.DEPLOY_DRY_RUN === 'true' || process.argv.includes('--dry-run');
const reportFile = resolve(env.DEPLOY_REPORT ?? '.deployment-report.json');
let cancelled = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cancelled = true; });
const save = async report => {
  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
};

try {
  if (env.GITHUB_ACTIONS && env.GITHUB_REF !== 'refs/heads/main') throw new Error('Production deployment workflows must run from main.');
  if (!['deploy', 'rollback'].includes(mode)) throw new Error('Invalid deployment mode.');
  const manifest = validateManifest(JSON.parse(await readFile('config/deployments.json', 'utf8')));
  const item = manifest.deployments.find(entry => entry.app === app);
  if (!item) throw new Error('Select a known app from config/deployments.json.');
  if (!item.enabled && !dryRun) throw new Error('This artifact is disabled in config/deployments.json.');
  if (mode === 'rollback') validateHistory(item, env.DEPLOY_HISTORY ?? '');
  let bytes = mode === 'deploy' ? await loadArtifact(item) : null;
  if (dryRun && !env.SUPABASE_URL && !env.SUPABASE_DEPLOY_KEY && mode === 'deploy') {
    const report = { app, status: 'offline-plan', source: item.source, bucket: item.bucket, objectPath: item.objectPath, note: 'Local validation only; credentials were absent, so Storage access was not checked.' };
    await save(report);
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (!env.SUPABASE_URL || !env.SUPABASE_DEPLOY_KEY) throw new Error('Add SUPABASE_URL and SUPABASE_DEPLOY_KEY in GitHub Settings → Secrets and variables → Actions.');
    const storage = new Storage({ url: env.SUPABASE_URL, key: env.SUPABASE_DEPLOY_KEY, bucket: item.bucket });
    if (mode === 'rollback') {
      await storage.preflight();
      bytes = await storage.read(env.DEPLOY_HISTORY);
      if (bytes === null) throw new Error('Selected rollback artifact does not exist.');
      validateHtml(bytes);
    }
    const report = await publish({ storage, item, bytes, mode, history: env.DEPLOY_HISTORY || null, dryRun, commit: env.DEPLOY_COMMIT ?? 'local', onReport: save, checkCancelled: () => { if (cancelled) throw new Error('Deployment interrupted.'); } });
    console.log(`${app}: ${report.status}`);
  }
} catch (error) {
  console.error(error.message);
  // Preserve the detailed transaction report if publish already wrote one.
  try { await readFile(reportFile); } catch { await save({ app, mode, status: 'preflight-failed', error: error.message }); }
  process.exitCode = 1;
} finally {
  if (env.GITHUB_STEP_SUMMARY) {
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    await appendFile(env.GITHUB_STEP_SUMMARY, `### ${app ?? 'Deployment'}: ${report.status}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
  }
}
