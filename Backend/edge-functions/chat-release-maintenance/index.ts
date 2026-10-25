// One reviewed Chat artifact only; no caller-supplied paths or file contents.
// The repository deployment engine preserves and verifies its recovery archive.
import { Buffer } from 'node:buffer';
import { Storage, sha256 } from '../../../scripts/storage-api.mjs';
import { publish } from '../../../scripts/deployment.mjs';
import { releaseConfig, releaseHtml } from './runtime-config.ts';

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
const digest = async (token: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(b=>b.toString(16).padStart(2,'0')).join('');
let inFlight: Promise<unknown> | null = null;
Deno.serve(async (req: Request) => {
  const json = (data: unknown, status=200) => Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
  if (!releaseConfig.tokenHash || Date.now()>=releaseConfig.expiresAt) return json({error:'Maintenance disabled'},410);
  if (req.method!=='POST') return json({error:'POST required'},405);
  const token=req.headers.get('authorization')?.replace(/^Bearer /,'') || '';
  if (!token || token.length>256 || await digest(token)!==releaseConfig.tokenHash) return json({error:'Unauthorized'},401);
  try {
    if (!inFlight) inFlight=(async()=>{
      const bytes=Buffer.from(releaseHtml,'utf8');
      if (sha256(bytes)!==releaseConfig.expectedSha256) throw new Error('Reviewed artifact hash mismatch');
      const storage=new Storage({url:Deno.env.get('SUPABASE_URL') || '',key:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',bucket:'liminal-apps'});
      return publish({storage,bytes,commit:releaseConfig.commit,log:()=>{},item:{app:'chat',source:'Chat/chat.html',bucket:'liminal-apps',objectPath:'chat.html',historyPrefix:'deployments/chat/'}});
    })().finally(()=>{inFlight=null;});
    return json(await inFlight);
  } catch (error) {
    return json({error:error instanceof Error?error.message.slice(0,240):'Publication failed'},502);
  }
});
