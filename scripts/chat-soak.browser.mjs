// Long-session soak for Chat: offline fixture, real application timers and
// Realtime callbacks, simulated traffic for many minutes. Samples heap, DOM,
// listeners and main-thread work over time, and flags a timeline that is at
// the bottom but no longer live. No production requests are made.
//
//   CHAT_MEDIA_DIR=/path/to/gifs SOAK_MIN=25 node scripts/chat-soak.browser.mjs [Chat/chat.html] [label] [--busy] [--blip] [--verify]
//
// --busy   faster messages, DM traffic, animated names and channel switches
// --blip   drop and restore the Realtime socket every five minutes
// --verify fail on page errors, unbounded growth or a stuck timeline
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright':'playwright');
const repo=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2),flags=new Set(args.filter(a=>a.startsWith('--'))),positional=args.filter(a=>!a.startsWith('--'));
const source=positional[0]||path.join(repo,'Chat/chat.html'),label=positional[1]||'soak';
const busy=flags.has('--busy'),blip=flags.has('--blip'),verify=flags.has('--verify');
const minutes=Number(process.env.SOAK_MIN||25),throttle=Number(process.env.SOAK_THROTTLE||4);
const out=process.env.CHAT_AUDIT_OUTPUT||path.join(os.tmpdir(),'liminal-chat-soak');
const mediaDir=process.env.CHAT_MEDIA_DIR;
if(!mediaDir)throw Error('Set CHAT_MEDIA_DIR to a directory of representative animated GIF test files.');
await fs.mkdir(out,{recursive:true});
let html=await fs.readFile(source,'utf8');
html=html.replace(/    initAuthRays\(\);\s*whenSupabaseReady\(\)\.then\(\(ready\) => \{[\s\S]*?\n    \}\);/,'    window.__auditReady=true;');
const files=(await fs.readdir(mediaDir)).filter(x=>x.endsWith('.gif'));
if(!files.length)throw Error('CHAT_MEDIA_DIR contains no .gif files');
const assets=await Promise.all(files.map(f=>fs.readFile(path.join(mediaDir,f))));
const browser=await chromium.launch({...(process.env.CHAT_BROWSER_PATH?{executablePath:process.env.CHAT_BROWSER_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const log=[],say=(...a)=>{const line=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ');log.push(line);console.log(line)};
try{
const page=await browser.newPage({viewport:{width:1366,height:768},userAgent:'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36',reducedMotion:'no-preference'});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);say('PAGEERROR',e.message)});
await page.route('**/*',route=>{
 const url=new URL(route.request().url());
 if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
 if(url.pathname.startsWith('/media/'))return route.fulfill({contentType:'image/gif',headers:{'cache-control':'max-age=3600'},body:assets[Number(url.pathname.split('/')[2])%assets.length]});
 return route.fulfill({status:200,contentType:'application/json',body:'{}'});
});
await page.goto('https://liminal.test/');
await page.waitForFunction(()=>window.__auditReady);
const cdp=await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate',{rate:throttle});
await cdp.send('Performance.enable');
await page.evaluate(({assetCount,busy})=>{
 Object.defineProperty(navigator,'deviceMemory',{configurable:true,get:()=>8});
 const S=window.__soak={work:[],agg:{},longTasks:[],loafs:[],depth:0,req:{},gen:{}};
 new PerformanceObserver(list=>list.getEntries().forEach(e=>S.longTasks.push({t:e.startTime,ms:e.duration}))).observe({type:'longtask',buffered:true});
 new PerformanceObserver(list=>list.getEntries().forEach(e=>{if(e.duration>=50)S.loafs.push({t:e.startTime,ms:e.duration,blocking:e.blockingDuration,scripts:e.scripts.map(s=>({fn:s.sourceFunctionName,ms:Math.round(s.duration)}))})})).observe({type:'long-animation-frame'});
 // Attribute top-level synchronous work to the application's own functions.
 for(const name of Object.keys(window)){
  if(['esc','$','qs','qsa','supabase','makeClient'].includes(name)||name.startsWith('__')||name.startsWith('fixture'))continue;
  let fn;try{fn=window[name]}catch{continue}
  if(typeof fn!=='function'||/\[native code\]/.test(Function.prototype.toString.call(fn))||(fn.prototype&&Object.getOwnPropertyNames(fn.prototype).length>1))continue;
  try{window[name]=function(...a){
   if(new.target)return Reflect.construct(fn,a,new.target);
   const top=S.depth===0;S.depth++;const start=performance.now();
   try{return fn.apply(this,a)}finally{S.depth--;const ms=performance.now()-start;const g=S.agg[name]||(S.agg[name]={n:0,topMs:0,max:0});g.n++;if(ms>g.max)g.max=ms;
    if(top){g.topMs+=ms;if(ms>=8){S.work.push({t:start,name,ms:+ms.toFixed(1)});if(S.work.length>30000)S.work.splice(0,10000)}}}
  }}catch{}
 }
 const roster=Array.from({length:71},(_,i)=>({username:`member_${i}`,display_name:`Member ${i}`,user_id:`user-${i}`,status:'online',staff_role:'member',
  pfp:i<17?`https://liminal.test/media/${i%assetCount}/avatar-${i}.gif`:'',ring:i%3===0?JSON.stringify({type:'gradient',from:'#a78bfa',to:'#f472b6',anim:true}):'',
  name_style:busy&&i%4===0?JSON.stringify({font:i%8?'script':'display',effect:i%8?'shift':'fade',from:'#a78bfa',to:'#f472b6',speed:'normal'}):'',
  bio:'',banner:'',created_at:'2026-10-01T12:00:00Z',last_seen:'2026-10-18T02:00:00Z'}));
 window.fixtureRoster=roster;
 const channelRows=['general','random','media'].map((id,i)=>({id,label:id,kind:'chat',icon:'#',category:'Community',position:i}));
 const dmRows=Array.from({length:16},(_,i)=>({id:`dm-${i}`,participants:['member_0',`member_${i+1}`],created_at:'2026-10-01T12:00:00Z'}));
 window.fixtureRow=(i,sender)=>({id:`message-${String(i).padStart(6,'0')}`,channel_id:'general',sender:sender||`member_${1+i%3}`,type:i%18===0?'gif':'text',
  media_url:i%18===0?`https://liminal.test/media/${i%assetCount}/message-${i}.gif`:'',content:`Message ${i} with ordinary **formatted** text`,
  created_at:new Date().toISOString(),reactions:{},deleted:false,edited:false});
 window.fixtureMessages=Array.from({length:700},(_,i)=>({...fixtureRow(i),created_at:new Date(Date.now()-86400000+i*60000).toISOString()}));
 window.fixtureChannels=[];
 const makeQuery=table=>{
  const state={filters:[],limit:null,single:false,asc:true,verb:'select'};
  const q=new Proxy({},{get(_,key){
   if(key==='then')return(resolve,reject)=>{S.req[table]=(S.req[table]||0)+1;let data=[];
    if(table==='profiles')data=roster;if(table==='channels')data=channelRows;if(table==='dms')data=dmRows;
    if(table==='app_settings')data=[{key:'whats_new',value:''}];if(table==='messages')data=fixtureMessages.slice();
    for(const [op,col,value] of state.filters){if(op==='eq')data=data.filter(x=>x[col]===value);if(op==='lt')data=data.filter(x=>x[col]<value);if(op==='gt')data=data.filter(x=>x[col]>value);if(op==='gte')data=data.filter(x=>x[col]>=value)}
    if(!state.asc)data=data.slice().reverse();if(state.limit)data=data.slice(0,state.limit);if(state.verb!=='select')data=[];
    return Promise.resolve({data:state.single?data[0]||null:data,count:0,error:null}).then(resolve,reject)};
   return(...a)=>{if(['eq','lt','gt','gte'].includes(key))state.filters.push([key,...a]);if(key==='or'){const m=a[0].match(/created_at\.(lt|gt)\.([^,]+)/);if(m)state.filters.push([m[1],'created_at',m[2]])}
    if(key==='order')state.asc=a[1]?.ascending!==false;if(key==='limit')state.limit=a[0];if(key==='maybeSingle'||key==='single')state.single=true;if(['insert','upsert','delete','update'].includes(key))state.verb=key;return q};
  }});return q;
 };
 const online=()=>roster.slice(0,window.fixtureOnline||4);
 const client={auth:{getSession:async()=>({data:{session:{expires_at:Math.floor(Date.now()/1000)+3600}}}),refreshSession:async()=>({data:{}})},
  realtime:{isConnected:()=>window.fixtureSocketUp!==false},from:makeQuery,
  rpc:async name=>{S.req[name]=(S.req[name]||0)+1;let data=[];if(name==='chat_get_my_profile')data=roster[0];if(name==='chat_check_device_ban')data=null;if(name==='chat_register_device')data=true;if(name==='chat_list_conversations')data=dmRows;return{data,error:null}},
  channel(name){const handlers=[];const ch={name,state:'closed',handlers,on(type,filter,fn){handlers.push({type,filter,fn});return ch},
   subscribe(fn){ch.cb=fn;queueMicrotask(()=>{ch.state='joined';fn('SUBSCRIBED')});return ch},
   presenceState(){return Object.fromEntries(online().map(p=>[p.username,[{username:p.username}]]))},
   track:async()=>{queueMicrotask(()=>handlers.filter(h=>h.type==='presence').forEach(h=>h.fn({})));return'ok'},untrack:async()=>'ok',send:async()=>'ok'};
   fixtureChannels.push(ch);return ch},
  removeChannel:async ch=>{ch.state='closed';fixtureChannels.splice(fixtureChannels.indexOf(ch),1);return'ok'},removeAllChannels:async()=>{fixtureChannels.length=0},getChannels:()=>fixtureChannels};
 const handlersOf=type=>fixtureChannels.flatMap(ch=>ch.handlers).filter(h=>h.type===type);
 // Database changes arrive as private broadcasts (6.1) or, in fallback mode, postgres_changes.
 window.fixtureEmit=(table,eventType,row)=>{handlersOf('postgres_changes').filter(h=>h.filter.table===table).forEach(h=>h.fn({eventType,new:row,old:row}));
  handlersOf('broadcast').filter(h=>h.filter.event===table).forEach(h=>h.fn({payload:{op:eventType,new:eventType==='DELETE'?null:row,old:row}}))};
 window.fixtureBroadcast=(event,payload)=>handlersOf('broadcast').filter(h=>h.filter.event===event).forEach(h=>h.fn({payload}));
 window.fixturePresence=()=>handlersOf('presence').forEach(h=>h.fn({}));
 // Like a dropped socket: every channel errors, then those still subscribed rejoin.
 window.fixtureBlip=()=>{window.fixtureSocketUp=false;const chs=fixtureChannels.slice();chs.forEach(ch=>{ch.state='errored';ch.cb?.('CHANNEL_ERROR')});
  setTimeout(()=>{window.fixtureSocketUp=true;chs.forEach(ch=>{if(fixtureChannels.includes(ch)){ch.state='joined';ch.cb?.('SUBSCRIBED')}})},1500)};
 makeClient=()=>client;
 settings.theme='midnight';LS.set('lc_seen_whats_new','');LS.set('lc_background:member_0','off');
 init();
},{assetCount:assets.length,busy});
await page.waitForFunction(()=>!document.getElementById('app-shell').hidden&&typeof pendingTimers!=='undefined'&&pendingTimers.length===5,{timeout:30000});
await page.evaluate(()=>chooseChatBackground('off',false));
await page.evaluate(busy=>{
 let i=100000;const g=window.__soak.gen,bump=k=>{g[k]=(g[k]||0)+1};
 setInterval(()=>{const row=fixtureRow(i++,`member_${[1,2,3,4,8][i%5]}`);fixtureMessages.push(row);fixtureEmit('messages','INSERT',row);bump('messages')},busy?3000:12000);
 if(busy)setInterval(()=>{const d=1+Math.floor(Math.random()*15);fixtureEmit('dm_messages','INSERT',{id:'dmm-'+(i++),dm_id:`dm-${d}`,sender:`member_${d+1}`,type:'text',content:'hey',created_at:new Date().toISOString(),reactions:{},deleted:false,edited:false,media_url:''});bump('dm')},20000);
 setInterval(()=>{fixtureBroadcast('typing',{username:'member_2',view:viewKey(currentView),typing:true,at:Date.now()});bump('typing')},5000);
 setInterval(()=>{window.fixtureOnline=3+Math.floor(Math.random()*3);fixturePresence();bump('presence')},45000);
 setInterval(()=>{const p=fixtureRoster[1+Math.floor(Math.random()*20)];fixtureEmit('profiles','UPDATE',{...p,bio:'bio '+Date.now()});bump('profile')},90000);
 setInterval(()=>{window.dispatchEvent(new Event('focus'));bump('focus')},180000);
},busy);
const frameWindow=ms=>page.evaluate(ms=>new Promise(resolve=>{const gaps=[];let last=0;const end=performance.now()+ms;
 const tick=t=>{if(last)gaps.push(t-last);last=t;if(t<end){requestAnimationFrame(tick);return}
  gaps.sort((a,b)=>a-b);const pct=p=>+gaps[Math.min(gaps.length-1,Math.floor(gaps.length*p))].toFixed(1);
  resolve({frames:gaps.length,p50:pct(.5),p95:pct(.95),max:+gaps.at(-1).toFixed(1),over50:gaps.filter(x=>x>50).length})};
 requestAnimationFrame(tick)}),ms);
const metric=(r,k)=>r.metrics.find(m=>m.name===k)?.value||0;
const samples=[],frameWindows=[],badgeTaps=[];let stuckAtBottom=0,last={lt:0,loaf:0,work:0};
const start=Date.now(),elapsed=()=>+((Date.now()-start)/60000).toFixed(2);
let nextScroll=start+60000,nextFrames=start+30000,nextSwitch=start+240000,nextBlip=start+150000;
while(Date.now()-start<minutes*60000){
 await page.waitForTimeout(10000);
 // Read a little above the bottom, then come back, with the pointer over messages.
 if(Date.now()>nextScroll){nextScroll=Date.now()+60000;await page.mouse.move(700,350);
  for(let k=0;k<20;k++){await page.mouse.wheel(0,-80);await page.waitForTimeout(30)}
  for(let k=0;k<25;k++){await page.mouse.wheel(0,80);await page.waitForTimeout(30)}}
 if(Date.now()>nextFrames){nextFrames=Date.now()+240000;frameWindows.push({min:elapsed(),...await frameWindow(15000)});say('F',frameWindows.at(-1))}
 if(blip&&Date.now()>nextBlip){nextBlip=Date.now()+300000;const w0=await page.evaluate(()=>__soak.work.length);const fw=frameWindow(8000);
  await page.evaluate(()=>fixtureBlip());say('BLIP',{frames:await fw,work:await page.evaluate(w0=>__soak.work.slice(w0).map(w=>w.name+':'+w.ms),w0)})}
 if(busy&&Date.now()>nextSwitch){nextSwitch=Date.now()+240000;await page.evaluate(()=>openView({type:'channel',id:'random'}));await page.waitForTimeout(8000);await page.evaluate(()=>openView({type:'channel',id:'general'}))}
 // At the bottom, a live timeline shows new messages. A visible badge there is
 // tapped, as a member would, and the work it causes is recorded.
 const state=await page.evaluate(()=>({badge:!$('new-msgs-badge').hidden,dist:Math.round(distanceFromBottom()),history:historyContexts.has(viewKey(currentView))}));
 if(state.history&&state.dist<60)stuckAtBottom++;
 if(state.badge&&state.dist<60){const w0=await page.evaluate(()=>__soak.work.length);await page.click('#new-msgs-badge').catch(()=>{});await page.waitForTimeout(1500);
  badgeTaps.push({min:elapsed(),work:await page.evaluate(w0=>__soak.work.slice(w0).map(x=>x.name+':'+x.ms),w0)});say('BADGE',badgeTaps.at(-1))}
 const m=await cdp.send('Performance.getMetrics');
 const app=await page.evaluate(last=>{const S=__soak;const cache=(msgCache.get(viewKey(currentView))||[]).length;
  const lt=S.longTasks.slice(last.lt),lo=S.loafs.slice(last.loaf),wk=S.work.slice(last.work);
  return{elements:document.getElementsByTagName('*').length,images:document.images.length,mounted:document.querySelectorAll('#message-list .msg').length,cache,
   animations:document.getAnimations().length,longTasks:lt.length,longTaskMax:Math.round(Math.max(0,...lt.map(x=>x.ms))),longFrames:lo.length,
   topWork:wk.sort((a,b)=>b.ms-a.ms).slice(0,3).map(w=>`${w.name}:${w.ms}`),next:{lt:S.longTasks.length,loaf:S.loafs.length,work:S.work.length}}},last);
 last=app.next;delete app.next;
 samples.push({min:elapsed(),heapMB:+(metric(m,'JSHeapUsedSize')/1048576).toFixed(1),nodes:metric(m,'Nodes'),listeners:metric(m,'JSEventListeners'),documents:metric(m,'Documents'),...app});
 say('S',samples.at(-1));
}
const final=await page.evaluate(()=>{const S=__soak;return{gen:S.gen,requests:S.req,longTasks:S.longTasks.length,longFrames:S.loafs.length,
 work:Object.entries(S.agg).map(([fn,v])=>({fn,calls:v.n,topMs:+v.topMs.toFixed(1),maxMs:+v.max.toFixed(1)})).sort((a,b)=>b.topMs-a.topMs).slice(0,25)}});
const report={source:path.basename(source),minutes,throttle,busy,blip,stuckAtBottom,badgeTaps,frameWindows,samples,errors,...final};
await fs.writeFile(path.join(out,label+'.json'),JSON.stringify(report,null,1));
say('RESULT',{stuckAtBottom,badgeTaps:badgeTaps.length,errors:errors.length,heapMB:samples.map(s=>s.heapMB).sort((a,b)=>a-b).at(-1),mountedMax:Math.max(...samples.map(s=>s.mounted))});
if(verify){
 assert.deepEqual(errors,[],'no uncaught application errors');
 assert.equal(stuckAtBottom,0,'a timeline at the bottom stays live');
 assert(samples.every(s=>s.mounted<=250&&s.cache<=250),'mounted rows and live cache stay bounded');
 assert(samples.every(s=>s.documents<=5),'no retained documents');
}
}finally{await fs.writeFile(path.join(out,label+'-log.txt'),log.join('\n'));await browser.close()}
