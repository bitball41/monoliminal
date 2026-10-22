import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html=await readFile(new URL('../Chat/liminal-chat-launcher.html',import.meta.url),'utf8');
const source=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1]
  .replace(/\nboot\(\);\nwatchForceRefresh\(\);\s*$/,'');
const chat='<html>https://trsirhyucncmyyfyiuje.supabase.co liminal:chat:ready</html>';
function harness(fetcher=async url=>url.includes('/object/info/public/')?Response.json({etag:'fixture-v1'}):new Response(chat)){
  const elements=new Map(),listeners=new Map(),requests=[],timers=new Map();let id=0;
  const element=key=>{
    if(!elements.has(key))elements.set(key,{hidden:false,disabled:false,textContent:'',style:{},contentWindow:{postMessage(){}},
      addEventListener(type,fn){this[type]=fn;},removeAttribute(key){delete this[key];}});
    return elements.get(key);
  };
  const context=vm.createContext({URL,Response,AbortController,console,Date:class extends Date{static now(){return 1800000000000;}},
    navigator:{onLine:true},location:{href:'file:///launcher.html'},
    window:{name:'',addEventListener:(type,fn)=>listeners.set(type,fn)},
    document:{documentElement:{dataset:{}},getElementById:element,querySelector:()=>element('status'),addEventListener(){}},
    fetch:async(url,options)=>{requests.push({url,options});return fetcher(url,options);},
    setTimeout(fn,ms){timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval(){},
  });
  vm.runInContext(source,context);
  const ready=()=>listeners.get('message')({source:element('chat-frame').contentWindow,data:{type:'liminal:chat:ready'}});
  return {context,elements,element,requests,timers,ready,documents:()=>requests.filter(r=>!r.url.includes('/object/info/public/'))};
}
test('normal launches share a cache URL and show Chat only after its ready message',async()=>{
  const h=harness();await h.context.boot();
  assert.equal(h.element('chat-frame').style.visibility,'hidden');
  assert.equal(h.element('chat-frame').srcdoc,chat);
  h.ready();assert.equal(h.element('chat-frame').style.visibility,'visible');
  await h.context.boot();assert.equal(h.documents()[0].url,h.documents()[1].url);
  assert.equal(h.documents()[0].options.cache,'no-cache');
  await h.context.boot('owner-refresh');assert.equal(new URL(h.documents()[2].url).searchParams.get('refresh'),'owner-refresh');
  assert.equal(h.documents()[2].options.cache,'reload');
});
test('offline startup makes no request; retries reset the error without deleting the help',async()=>{
  const h=harness();h.context.navigator.onLine=false;await h.context.boot();
  assert.equal(h.requests.length,0);assert.match(h.element('error-code').textContent,/LC_OFFLINE/);
  h.context.navigator.onLine=true;await h.context.boot();assert.equal(h.element('launch-error').hidden,true);
  assert.equal(h.element('progress').hidden,false);assert.equal(h.element('launch-actions').hidden,true);
});
test('HTTP failures have distinct useful codes',async()=>{
  for(const [status,code] of [[404,'LC_NOT_FOUND'],[403,'LC_ACCESS'],[429,'LC_RATE_LIMIT'],[503,'LC_SERVICE']]){
    const h=harness(async()=>new Response('error',{status}));await h.context.boot();
    assert.match(h.element('error-code').textContent,new RegExp(code));
    assert.match(h.element('error-code').textContent,new RegExp('HTTP '+status));
    assert.equal(h.element('chat-frame').srcdoc,undefined);
  }
});
test('unexpected or pre-migration documents never run',async()=>{
  for(const [body,code] of [['<html>Sign in to WiFi</html>','LC_BAD_RESPONSE'],['<html>liminal:chat:ready https://ucgjwrjqmexenmrpbdkh.supabase.co</html>','LC_UPDATE_REQUIRED']]){
    const h=harness(async()=>new Response(body));await h.context.boot();
    assert.match(h.element('error-code').textContent,new RegExp(code));assert.equal(h.element('chat-frame').srcdoc,undefined);
  }
});
test('startup timeout keeps the error visible and offers inspection instead of revealing a blank frame',async()=>{
  const h=harness();await h.context.boot();
  [...h.timers.values()].find(t=>t.ms===25000).fn();
  assert.match(h.element('error-code').textContent,/LC_STARTUP/);
  assert.equal(h.element('chat-frame').style.visibility,'hidden');assert.equal(h.element('show-chat').hidden,false);
  h.element('show-chat').click();assert.equal(h.element('chat-frame').style.visibility,'visible');
});
test('request timeout covers the response body, and a cancelled attempt cannot replace the retry',async()=>{
  let firstSignal,releaseBody;
  const h=harness(async(url,{signal})=>{
    if(url.includes('/object/info/public/'))return Response.json({etag:'fixture'});
    firstSignal??=signal;
    if(signal===firstSignal)return {ok:true,text:()=>new Promise(resolve=>releaseBody=resolve)};
    return new Response(chat);
  });
  const first=h.context.boot();await new Promise(resolve=>setImmediate(resolve));
  assert([...h.timers.values()].some(t=>t.ms===20000),'timeout remains active while body downloads');
  await h.context.boot('retry');assert.equal(firstSignal.aborted,true);
  releaseBody('<html>stale</html>');await first;
  assert.equal(h.element('chat-frame').srcdoc,chat);assert.equal(h.element('launch-error').hidden,true);
});
test('connection diagnostics run only when requested and check the real database',async()=>{
  const h=harness(async()=>Response.json([]));assert.equal(h.requests.length,0);
  await h.context.checkConnection();assert.equal(h.requests.length,1);
  assert.match(h.requests[0].url,/rest\/v1\/app_settings\?/);assert.match(h.element('connection-result').textContent,/database responded/);
  assert.equal(h.element('check-connection').disabled,false);
});


test('cached launches only read small metadata, while changed deployments and explicit retries download HTML',async()=>{
  let etag='v1',cached=null;
  const h=harness(async url=>url.includes('/object/info/public/')?Response.json({etag}):new Response(chat));
  h.context.chatDocumentCache=async(mode,record)=>{if(mode==='write')cached=record;return cached;};
  await h.context.boot();assert.equal(h.documents().length,1);assert.equal(cached.etag,'v1');
  await h.context.boot();assert.equal(h.documents().length,1,'unchanged HTML stays local');
  assert.equal(h.requests.at(-1).options.cache,'no-store','the version is revalidated every launch');
  etag='v2';await h.context.boot();assert.equal(h.documents().length,2);assert.equal(cached.etag,'v2');
  await h.context.boot('owner-force');assert.equal(h.documents().length,3);assert.equal(h.documents().at(-1).options.cache,'reload');
});

test('missing metadata, unavailable storage, and invalid cached HTML safely fall back to downloading',async()=>{
  for(const mode of ['metadata','storage','invalid']){
    const h=harness(async url=>url.includes('/object/info/public/')?(mode==='metadata'?Response.json({}):Response.json({etag:'v1'})):new Response(chat));
    if(mode!=='storage')h.context.chatDocumentCache=async()=>({html:mode==='invalid'?'invalid document':chat,etag:'v1',launcher:5});
    await h.context.boot();assert.equal(h.documents().length,1,mode);assert.equal(h.element('chat-frame').srcdoc,chat);
  }
});

test('IndexedDB errors and blocked opens never prevent launching Chat',async()=>{
  const h=harness();
  h.context.indexedDB={open(){throw new Error('Storage denied');}};
  await h.context.boot();assert.equal(h.element('chat-frame').srcdoc,chat);
  h.context.indexedDB={open(){const open={};setImmediate(()=>open.onblocked());return open;}};
  await h.context.boot();assert.equal(h.element('chat-frame').srcdoc,chat);
});

test('the real document cache persists between launcher instances and releases database connections',async()=>{
  const data=new Map(),stores=new Set();let closed=0;
  const indexedDB={open(){
    const open={result:{objectStoreNames:{contains:name=>stores.has(name)},
      createObjectStore:name=>stores.add(name),close(){closed++;},
      transaction(){
        const tx={objectStore(){return {
          get(key){const r={};setImmediate(()=>{r.result=structuredClone(data.get(key));r.onsuccess();tx.oncomplete();});return r;},
          put(record,key){const r={};setImmediate(()=>{data.set(key,structuredClone(record));r.onsuccess();tx.oncomplete();});return r;}
        };}};return tx;
      }}};
    setImmediate(()=>{if(!stores.size)open.onupgradeneeded();open.onsuccess();});return open;
  }};
  const first=harness();first.context.indexedDB=indexedDB;
  await first.context.boot();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(data.size,1);assert.equal(first.documents().length,1);
  const second=harness();second.context.indexedDB=indexedDB;
  await second.context.boot();assert.equal(second.documents().length,0);assert.equal(second.element('chat-frame').srcdoc,chat);
  assert.equal(closed,3,'first read/write and later read all close their connection');
});


test('a stalled metadata check times out into a normal download without cancelling startup',async()=>{
  const h=harness(async(url,{signal})=>{
    if(url.includes('/object/info/public/'))return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('metadata timeout')),{once:true}));
    return new Response(chat);
  });
  const start=h.context.boot();await new Promise(resolve=>setImmediate(resolve));
  [...h.timers.values()].find(timer=>timer.ms===3000).fn();await start;
  assert.equal(h.documents().length,1);assert.equal(h.element('chat-frame').srcdoc,chat);
});
