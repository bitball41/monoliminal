import { readFile } from 'node:fs/promises';
import { validateManifest, loadArtifact } from './deployment.mjs';

const manifest = validateManifest(JSON.parse(await readFile('config/deployments.json', 'utf8')));
for (const item of manifest.deployments) {
  await loadArtifact(item);
  const workflow = await readFile(`.github/workflows/deploy-${item.app}.yml`, 'utf8');
  if (!workflow.includes(`- '${item.source}'`) || !workflow.includes(`app: ${item.app}`)) throw new Error(`Workflow does not match the manifest: ${item.app}`);
}
console.log(`Validated ${manifest.deployments.length} HTML artifacts and deployment mappings.`);
