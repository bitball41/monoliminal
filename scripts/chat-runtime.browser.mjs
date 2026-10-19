import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
// Full offline boot, real timers and Realtime callbacks. No production requests.
const repo=fileURLToPath(new URL('../',import.meta.url));
const root=process.env.CHAT_AUDIT_OUTPUT||path.join(os.tmpdir(),'liminal-chat-performance');
const mediaDir=process.env.CHAT_MEDIA_DIR;
if(!mediaDir)throw Error('Set CHAT_MEDIA_DIR to a directory of representative animated GIF test files.');
await fs.mkdir(root,{recursive:true});
const verify=process.argv.includes('--verify');
const source=process.argv[2]||path.join(repo,'Chat/chat.html');
const label=process.argv[3]||'audit-before';
const quick=process.argv.includes('--quick');
const noMedia=process.argv.includes('--no-media');
const realistic=process.argv.includes('--realistic');
let html=await fs.readFile(source,'utf8');
html=html.replace(/    initAuthRays\(\);\s*whenSupabaseReady\(\)\.then\(\(ready\) => \{[\s\S]*?\n    \}\);/,'    window.__auditReady=true;');
const files=(await fs.readdir(mediaDir)).filter(x=>x.endsWith('.gif'));
if(!files.length)throw Error('CHAT_MEDIA_DIR contains no .gif files');
const assets=await Promise.all(files.map(f=>fs.readFile(path.join(mediaDir,f))));
const browser=await chromium.launch({...(process.env.CHAT_BROWSER_PATH?{executablePath:process.env.CHAT_BROWSER_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
const page=await browser.newPage({viewport:{width:1366,height:768},userAgent:'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36',reducedMotion:'no-preference'});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message)});
await page.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
 if(url.pathname.startsWith('/media/'))return route.fulfill({contentType:'image/gif',body:assets[Number(url.pathname.split('/')[2])%assets.length]});
 return route.fulfill({status:200,contentType:'application/json',body:'{}'});
});
await page.goto('https://liminal.test/');await page.waitForFunction(()=>window.__auditReady);
const cdp=await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
await cdp.send('Performance.enable');
await cdp.send('Tracing.start',{categories:'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,disabled-by-default-devtools.timeline.frame',transferMode:'ReturnAsStream'});
 await page.evaluate(({assetCount,noMedia,realistic})=>{
 Object.defineProperty(navigator,'deviceMemory',{configurable:true,get:()=>8});
 window.__audit={calls:{},longTasks:[],loafs:[],frames:[],requests:{},phases:[],lastFrame:0};
 new PerformanceObserver(list=>list.getEntries().forEach(e=>__audit.longTasks.push({start:e.startTime,ms:e.duration}))).observe({type:'longtask',buffered:true});
 if(PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'))new PerformanceObserver(list=>list.getEntries().forEach(e=>__audit.loafs.push({start:e.startTime,ms:e.duration,blocking:e.blockingDuration,renderStart:e.renderStart,style:e.styleAndLayoutStart,scripts:e.scripts.map(s=>({name:s.sourceFunctionName,line:s.sourceCharPosition,duration:s.duration,layout:s.forcedStyleAndLayoutDuration,invoker:s.invoker,type:s.invokerType}))}))).observe({type:'long-animation-frame',buffered:true});
 const tick=t=>{if(__audit.lastFrame)__audit.frames.push({at:t,ms:t-__audit.lastFrame});__audit.lastFrame=t;requestAnimationFrame(tick)};requestAnimationFrame(tick);
 for(const name of ['renderMembers','renderDmList','renderChannels','patchPresenceDots','pinToBottom','autogrow','renderTimeline','refreshTimelineForAuthor','handleProfileChange','ingestMessage','applyFeatureControls','renderSelf','markViewRead','refreshPollTimers','catchUpPoll','refreshConversations','scheduleRealtimeRecover','attachLinkPreview']){
  const original=window[name];window[name]=function(...args){const start=performance.now();try{return original.apply(this,args)}finally{const item=__audit.calls[name]||={count:0,ms:0,max:0};const duration=performance.now()-start;item.count++;item.ms+=duration;item.max=Math.max(item.max,duration)}};
 }
 const roster=Array.from({length:71},(_,i)=>({username:`member_${i}`,display_name:`Member ${i}`,user_id:`user-${i}`,status:'online',staff_role:'member',pfp:noMedia||i>=(realistic?17:51)?'':`https://liminal.test/media/${i%assetCount}/avatar-${i}.gif`,ring:i%3===0?JSON.stringify({type:'gradient',from:'#a78bfa',to:'#f472b6',anim:true}):'',bio:'',banner:'',created_at:'2026-10-01T12:00:00Z',last_seen:'2026-10-18T02:00:00Z'}));
 const channelRows=['general','random','media'].map((id,i)=>({id,label:id,kind:'chat',icon:'#',category:'Community',position:i}));
 const dmRows=Array.from({length:16},(_,i)=>({id:`dm-${i}`,participants:['member_0',`member_${i+1}`],created_at:'2026-10-01T12:00:00Z'}));
 window.fixtureRow=i=>({id:`message-${String(i).padStart(5,'0')}`,channel_id:'general',sender:`member_${i%3}`,type:!noMedia&&i%(realistic?18:4)===0?'gif':'text',media_url:!noMedia&&i%(realistic?18:4)===0?`https://liminal.test/media/${i%assetCount}/message-${i}.gif`:'',content:`Message ${i} with ordinary **formatted** text.`,created_at:new Date(Date.UTC(2026,9,18,2,0,i)).toISOString(),reactions:{},deleted:false,edited:false});
 window.fixtureMessages=Array.from({length:700},(_,i)=>fixtureRow(i));
 window.fixtureChannels=[];
 const makeQuery=table=>{
  const state={filters:[],limit:null,head:false,single:false,asc:true,columns:'*',verb:'select'};
  const q=new Proxy({}, {get(_,key){
   if(key==='then')return (resolve,reject)=>{__audit.requests[table]=(__audit.requests[table]||0)+1;let data=[];
    if(table==='profiles')data=roster;
    if(table==='channels')data=channelRows;
    if(table==='dms')data=dmRows;
    if(table==='app_settings')data=[{key:'whats_new',value:''}];
    if(table==='messages')data=fixtureMessages.slice();
    for(const [op,col,value] of state.filters){if(op==='eq')data=data.filter(x=>x[col]===value);if(op==='lt')data=data.filter(x=>x[col]<value);if(op==='gt')data=data.filter(x=>x[col]>value);if(op==='gte')data=data.filter(x=>x[col]>=value)}
    if(!state.asc)data=data.slice().reverse();if(state.limit)data=data.slice(0,state.limit);
    if(state.verb!=='select')data=[];
    return Promise.resolve({data:state.single?data[0]||null:data,count:0,error:null}).then(resolve,reject)};
   return (...args)=>{if(['eq','lt','gt','gte'].includes(key))state.filters.push([key,...args]);if(key==='or'){const m=args[0].match(/created_at\.(lt|gt)\.([^,]+)/);if(m)state.filters.push([m[1],'created_at',m[2]])}if(key==='select'){state.columns=args[0];state.head=!!args[1]?.head}if(key==='order')state.asc=args[1]?.ascending!==false;if(key==='limit')state.limit=args[0];if(key==='maybeSingle'||key==='single')state.single=true;if(['insert','upsert','delete','update'].includes(key))state.verb=key;return q};
  }});return q;
 };
 const client={auth:{getSession:async()=>({data:{session:{expires_at:Math.floor(Date.now()/1000)+3600}}}),refreshSession:async()=>({data:{}})},realtime:{isConnected:()=>true},from:makeQuery,rpc:async(name)=>{
  __audit.requests[name]=(__audit.requests[name]||0)+1;
  let data=[];if(name==='chat_get_my_profile')data=roster[0];if(name==='chat_check_device_ban')data=null;if(name==='chat_register_device')data=true;if(name==='chat_list_conversations')data=dmRows;if(name==='chat_list_subroles')data=[];
  return {data,error:null};
 },channel(name){const handlers=[];const ch={name,state:'closed',handlers,on(type,filter,fn){handlers.push({type,filter,fn});return ch},subscribe(fn){queueMicrotask(()=>{ch.state='joined';fn('SUBSCRIBED')});return ch},presenceState(){return Object.fromEntries(roster.slice(0,3).map(p=>[p.username,[{username:p.username}]]))},track:async()=>{queueMicrotask(()=>handlers.filter(h=>h.type==='presence').forEach(h=>h.fn({})));return'ok'},untrack:async()=>'ok',send:async()=>'ok'};fixtureChannels.push(ch);return ch},removeChannel:async ch=>{ch.state='closed';fixtureChannels.splice(fixtureChannels.indexOf(ch),1)}};
 window.fixtureEmit=(table,eventType,row)=>{fixtureChannels.flatMap(ch=>ch.handlers).filter(h=>h.type==='postgres_changes'&&h.filter.table===table).forEach(h=>h.fn({eventType,new:row,old:row}))};
 makeClient=()=>client;
 settings.theme='midnight';LS.set('lc_seen_whats_new','');LS.set('lc_background:member_0','off');
 init();
},{assetCount:assets.length,noMedia,realistic});
await page.waitForFunction(()=>!document.getElementById('app-shell').hidden&&typeof pendingTimers!=='undefined'&&pendingTimers.length===6,{timeout:20000});
await page.evaluate(()=>chooseChatBackground('off',false));
await page.waitForTimeout(3000);
const results={};
if(verify){
 assert.equal(await page.locator('#chat-background-stage canvas').count(),0);
 await page.evaluate(()=>{window.fixtureRetainedNode=$('message-list').querySelectorAll('.msg')[10];window.fixtureRetainedImage=$('message-list').querySelector('.msg-media img')});
}
async function phase(name,ms,work){
 const before=await cdp.send('Performance.getMetrics');
 await page.evaluate(name=>{__audit.phase={name,start:performance.now(),calls:JSON.parse(JSON.stringify(__audit.calls))};performance.mark(name+':start')},name);
 if(work)await work();
 await page.waitForTimeout(ms);
 const after=await cdp.send('Performance.getMetrics');
 const result=await page.evaluate(()=>{const {start,calls,name}=__audit.phase;const frames=__audit.frames.filter(f=>f.at>=start);const sorted=frames.map(f=>f.ms).sort((a,b)=>a-b);const pct=p=>+(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]||0).toFixed(1);const changed={};for(const [n,c]of Object.entries(__audit.calls)){const prior=calls[n]||{count:0,ms:0};if(c.count!==prior.count)changed[n]={count:c.count-prior.count,ms:+(c.ms-prior.ms).toFixed(1),max:+c.max.toFixed(1)}}performance.mark(name+':end');return {duration:performance.now()-start,frames:frames.length,p50:pct(.5),p95:pct(.95),p99:pct(.99),worst:pct(1),gaps:frames.filter(f=>f.ms>45),longTasks:__audit.longTasks.filter(e=>e.start>=start),loafs:__audit.loafs.filter(e=>e.start>=start),calls:changed,dom:document.querySelectorAll('*').length,messages:document.querySelectorAll('#message-list .msg').length,images:document.images.length,canvases:document.querySelectorAll('canvas').length,requests:__audit.requests}});
 const metric=(r,k)=>r.metrics.find(m=>m.name===k)?.value||0;
 for(const key of ['LayoutCount','RecalcStyleCount','LayoutDuration','RecalcStyleDuration','ScriptDuration','TaskDuration','JSHeapUsedSize'])result[key]=+(metric(after,key)-metric(before,key)).toFixed(4);
 results[name]=result;console.log(name,JSON.stringify(result));
}
await phase('idle',quick?6000:21000);
await phase('messages',quick?3500:10000,()=>page.evaluate(()=>{let i=700;window.fixtureMessageTimer=setInterval(()=>{const row=fixtureRow(i++);fixtureMessages.push(row);fixtureEmit('messages','INSERT',row);if(i>=706)clearInterval(fixtureMessageTimer)},450)}));
await phase('history',quick?4000:10000,async()=>{for(let i=0;i<3;i++){await page.evaluate(()=>loadOlder());if(verify)assert(await page.evaluate(()=>fixtureRetainedNode.isConnected&&(!fixtureRetainedImage||fixtureRetainedImage.isConnected)),'history retains existing message/image nodes')}await page.evaluate(()=>{releaseBottomPin();$('timeline').scrollTop=0})});
await phase('typing',quick?3500:6000,()=>page.evaluate(()=>{window.fixtureTypingTimer=setInterval(()=>{const ta=$('message-input');ta.value+='typing ';ta.dispatchEvent(new Event('input',{bubbles:true}));if(ta.value.length>120)clearInterval(fixtureTypingTimer)},120)}));
await phase('presence',quick?1500:4000,()=>page.evaluate(()=>{for(let i=0;i<71;i++)fixtureEmit('profiles','UPDATE',{...profiles.get(`member_${i}`),last_seen:new Date().toISOString()});window.dispatchEvent(new Event('focus'))}));
await phase('return-latest',quick?1500:4000,()=>page.evaluate(()=>scrollToBottom(true)));
if(verify){
 await phase('long-session',quick?2500:60000,()=>page.evaluate(()=>{let next=1000;window.fixtureBurstTimer=setInterval(()=>{for(let batch=0;batch<25;batch++){const row={...fixtureRow(next++),type:'text',media_url:'',sender:'member_1'};fixtureMessages.push(row);fixtureEmit('messages','INSERT',row)}if(next>=2000)clearInterval(fixtureBurstTimer)},40)}));
 const bounds=await page.evaluate(()=>({live:msgCache.get(viewKey(currentView)).length,history:historyContexts.get(viewKey(currentView)).rows.length,mounted:$('message-list').querySelectorAll('.msg').length}));
 assert(bounds.live<=250&&bounds.history<=200&&bounds.mounted<=200,JSON.stringify(bounds));
 const beforeAuthor=await page.evaluate(()=>{const node=fixtureRetainedNode;window.fixtureAuthorMedia=node.querySelector('.msg-cards');const p=profiles.get(node.dataset.sender);handleProfileChange({new:{...p,display_name:'Renamed fixture',tag:'New tag'}});return node.dataset.id});
 assert(await page.evaluate(()=>fixtureRetainedNode.isConnected&&fixtureAuthorMedia===fixtureRetainedNode.querySelector('.msg-cards')),'profile changes retain timeline/media identity');
 assert.equal(await page.locator(`[data-id="${beforeAuthor}"] .msg-author`).textContent(),'Renamed fixture');
 await page.evaluate(()=>openSettings('security'));
 const download=page.waitForEvent('download');await page.click('#export-performance-btn');const artifact=await download;const reportPath=path.join(root,label+'-download.json');await artifact.saveAs(reportPath);
 const report=JSON.parse(await fs.readFile(reportPath,'utf8'));assert.equal(report.counts.backgroundCanvases,0);assert(!JSON.stringify(report).includes('member_'));assert(report.samples.length<=120);
 await page.evaluate(()=>$('settings-dialog').close());
 // Confirm the actual Latest control, late media growth and composer resizing
 // still keep the final message in view after the scroll scheduler changed.
 await page.evaluate(()=>returnToLatest());
 await page.waitForFunction(()=>!historyContexts.has(viewKey(currentView))&&distanceFromBottom()<2);
 await page.evaluate(()=>{
  const media=document.createElement('div');media.className='msg-media';
  const image=document.createElement('img');image.id='fixture-late-image';
  image.src='https://liminal.test/media/0/late-image.gif';media.append(image);
  $('message-list').lastElementChild.querySelector('.msg-body').append(media);
 });
 await page.waitForFunction(()=>$('fixture-late-image').naturalWidth>0&&distanceFromBottom()<2);
 await page.evaluate(()=>{const ta=$('message-input');ta.value='A line of text\n'.repeat(10);ta.dispatchEvent(new Event('input',{bubbles:true}))});
 await page.waitForFunction(()=>distanceFromBottom()<2&&$('message-input').clientHeight>38);
 await page.evaluate(()=>{pinToBottom();releaseBottomPin();$('timeline').scrollTop=0});
 await page.waitForTimeout(200);
 assert(await page.evaluate(()=>$('timeline').scrollTop<20),'user scroll cancels the queued pin');
 const offscreen=await page.evaluate(()=>{
  const image=document.querySelector('.avatar[data-media-visible="false"] img');
  if(!image)return null;
  window.fixtureOffscreenImage=image;return{src:image.getAttribute('src'),visibility:getComputedStyle(image).visibility};
 });
 if(offscreen){
  assert.equal(offscreen.visibility,'hidden');
  await page.evaluate(()=>fixtureOffscreenImage.closest('.member-row,.dm-button,.msg')?.scrollIntoView({block:'center'}));
  await page.waitForFunction(()=>getComputedStyle(fixtureOffscreenImage).visibility==='visible');
  assert.equal(await page.evaluate(()=>fixtureOffscreenImage.getAttribute('src')),offscreen.src,'scrolling restores the original full-resolution image');
 }
 console.log('VERIFIED',JSON.stringify({bounds,diagnostics:report.timingType,slowFrames:report.slowFrames}));
}
await phase('rings-paused',quick?2000:6000,()=>page.addStyleTag({content:'.avatar.ring-anim::before{animation:none!important}'}));
await phase('all-media-hidden',quick?2000:6000,()=>page.addStyleTag({content:'.avatar img,.msg-media img{visibility:hidden!important}'}));
const done=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await done;
const trace=await fs.open(`${root}/${label}-trace.json`,'w');for(;;){const part=await cdp.send('IO.read',{handle:stream});await trace.write(part.data);if(part.eof)break}await trace.close();await cdp.send('IO.close',{handle:stream});
results.errors=errors;await fs.writeFile(`${root}/${label}.json`,JSON.stringify(results,null,2));
console.log('RESULT',JSON.stringify({errors,phases:Object.keys(results)}));
}finally{await browser.close()}
