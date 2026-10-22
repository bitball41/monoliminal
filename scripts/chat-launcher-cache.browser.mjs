// Offline native Chromium check for file:// IndexedDB caching. No live service traffic.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'liminal-launcher-cache-'));
const source=await fs.readFile(new URL('../Chat/liminal-chat-launcher.html',import.meta.url),'utf8');
const file=path.join(dir,'launcher.html');
await fs.writeFile(file,source.replace('watchForceRefresh();','/* offline control fixture */'));
const browser=await chromium.launch({headless:true,...(process.env.CHAT_BROWSER_PATH?{executablePath:process.env.CHAT_BROWSER_PATH}:{})});
let version='v1',downloads=0,metadataReads=0;
try{
 const context=await browser.newContext();
 await context.route('**/*',async route=>{
  const url=route.request().url();
  if(url.startsWith('file:'))return route.continue();
  if(url.includes('/object/info/public/')){metadataReads++;return route.fulfill({contentType:'application/json',body:JSON.stringify({etag:version})});}
  if(url.includes('/object/public/liminal-apps/chat.html')){
   downloads++;
   return route.fulfill({contentType:'text/html',body:`<html><body data-version="${version}">https://trsirhyucncmyyfyiuje.supabase.co<script>parent.postMessage({type:'liminal:chat:ready'},'*')</script></body></html>`});
  }
  return route.abort();
 });
 const page=await context.newPage();
 const ready=()=>page.waitForFunction(()=>document.documentElement.dataset.stage==='ready');
 await page.goto(pathToFileURL(file).href);await ready();
 assert.equal(downloads,1);
 await page.waitForFunction(async()=>!!(await chatDocumentCache('read')));
 await page.reload();await ready();assert.equal(downloads,1,'file:// reopens reuse the stored application');
 version='v2';await page.reload();await ready();assert.equal(downloads,2,'a changed deployment is downloaded');
 await page.evaluate(()=>boot('explicit-retry'));await ready();assert.equal(downloads,3,'owner/explicit retries bypass the stored HTML');
 assert.equal(metadataReads,4);
 await context.close();
 console.log('Verified native file:// cache reuse, changed-deployment invalidation, and explicit refresh.');
}finally{await browser.close();await fs.rm(dir,{recursive:true,force:true});}
