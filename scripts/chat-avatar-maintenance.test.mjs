import test from 'node:test';
import assert from 'node:assert/strict';
import {avatarMaintenanceHandler} from '../Backend/edge-functions/chat-avatar-maintenance/handler.ts';
const token='temporary-test-capability';
const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(b=>b.toString(16).padStart(2,'0')).join('');
const projectUrl='https://example.supabase.co',id='00000000-0000-4000-8000-000000000001',original=projectUrl+'/storage/v1/object/public/liminal-pfp/'+id+'/original.gif';
const thumbnail=btoa('RIFF0000WEBPtest');
const req=(body={},authorized=true)=>new Request(projectUrl+'/functions/v1/chat-avatar-maintenance',{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({user_id:id,expected_pfp:original,thumbnail,...body})});
test('avatar maintenance rejects unauthorized, expired and malformed requests before reaching Storage',async()=>{
 let calls=0;const config={projectUrl,serviceKey:'server-test-key',tokenHash:digest,expiresAt:Date.now()+60000,fetchImpl:async()=>{calls++;throw new Error('unexpected request')}};
 const handler=avatarMaintenanceHandler(config);
 assert.equal((await handler(req({},false))).status,401);
 assert.equal((await avatarMaintenanceHandler({...config,expiresAt:0})(req())).status,410);
 assert.equal((await handler(req({expected_pfp:'https://elsewhere.test/secret'}))).status,400);
 assert.equal((await handler(req({thumbnail:btoa('not webp')}))).status,400);
 assert.equal(calls,0);
});
test('avatar migration checks the original, verifies the uploaded asset, then conditionally sets only the thumbnail',async()=>{
 const calls=[];
 const handler=avatarMaintenanceHandler({projectUrl,serviceKey:'server-test-key',tokenHash:digest,expiresAt:Date.now()+60000,fetchImpl:async(url,options={})=>{
  calls.push({url,options});
  if(calls.length===1)return Response.json([{pfp:original,pfp_thumbnail:''}]);
  if(url.includes('/storage/v1/object/public/'))return new Response(Uint8Array.from(atob(thumbnail),c=>c.charCodeAt(0)),{headers:{'content-type':'image/webp','cache-control':'public, max-age=604800'}});
  if(options.method==='PATCH')return Response.json([{user_id:id}]);
  return Response.json({Key:'thumbnail'});
 }});
 assert.equal((await handler(req())).status,200);
 const patch=calls.find(c=>c.options.method==='PATCH');
 assert.match(patch.url,/pfp=eq\./);assert.match(patch.url,/pfp_thumbnail=eq\./);
 assert.deepEqual(Object.keys(JSON.parse(patch.options.body)),['pfp_thumbnail']);
 assert(calls.findIndex(c=>c.url.includes('/storage/v1/object/public/'))<calls.indexOf(patch),'verify the object before referencing it');
 assert(calls.every(c=>!c.url.endsWith('/original.gif')||c.options.method===undefined),'originals are never rewritten');
});
test('an avatar changed during preparation is skipped without uploading anything',async()=>{
 let calls=0;
 const handler=avatarMaintenanceHandler({projectUrl,serviceKey:'server-test-key',tokenHash:digest,expiresAt:Date.now()+60000,fetchImpl:async()=>{calls++;return Response.json([{pfp:'new avatar',pfp_thumbnail:''}])}});
 assert.equal((await handler(req())).status,409);assert.equal(calls,1);
});
