import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const chat=await readFile(new URL('../Chat/chat.html',import.meta.url),'utf8');
function section(start,end){const from=chat.indexOf(start),to=chat.indexOf(end,from);assert(from>=0&&to>from,start);return chat.slice(from,to)}

function pins(){
 let sequence=0,reads=0,writes=0,height=1000,top=0;
 const frames=new Map();
 const timeline={get scrollHeight(){reads++;return height},get scrollTop(){return top},set scrollTop(v){writes++;top=Math.min(v,height-300)}};
 const c=vm.createContext({Date,$:()=>timeline,requestAnimationFrame(fn){const id=++sequence;frames.set(id,fn);return id},cancelAnimationFrame:id=>frames.delete(id)});
 vm.runInContext(section('    let pendingNewCount =','    let tailNodes ='),c);
 return {c,frames,reads:()=>reads,writes:()=>writes,top:()=>top,resize:v=>{height=v},flush(){const jobs=[...frames.values()];frames.clear();jobs.forEach(fn=>fn())}};
}
test('message and resize bursts coalesce into one layout read and one scroll write',()=>{
 const p=pins();for(let i=0;i<100;i++)p.c.pinToBottom(i%2===0);
 assert.equal(p.reads(),0);assert.equal(p.writes(),0);assert.equal(p.frames.size,1);
 p.flush();assert.equal(p.reads(),1);assert.equal(p.writes(),1);assert.equal(p.top(),700);
 p.flush();assert.equal(p.frames.size,0,'there is no nine-frame settling loop');
 p.resize(1300);p.c.pinToBottom(true);p.flush();assert.equal(p.top(),1000,'late image growth still pins');
});
test('scrolling up cancels a queued bottom pin and an applied pin release',()=>{
 const p=pins();p.c.pinToBottom();p.c.releaseBottomPin();p.flush();assert.equal(p.writes(),0);
 p.c.pinToBottom();p.flush();p.c.releaseBottomPin();p.flush();assert.equal(p.frames.size,0);
 p.c.holdTimeline(2000);p.c.pinToBottom();p.flush();assert.equal(p.writes(),1);
});

function history(lite=false){
 const c=vm.createContext({isLiteMode:()=>lite,msgCache:new Map(),msgById:new Map(),pollCache:new Map(),pollBusy:new Set(),viewKey:v=>v.key});
 vm.runInContext(section('    function indexMessage(','    function profileOf(')+'\n'+section('    const HISTORY_MESSAGE_CAP =','    function clearHistoryContexts('),c);
 return c;
}
test('history paging stays bounded in both directions and preserves live message aliases',()=>{
 for(const lite of [false,true]){
  const c=history(lite),cap=lite?120:200,rows=Array.from({length:500},(_,id)=>({id,content:`row${id}`}));
  const live={...rows[499],content:'Live update'};c.msgCache.set('channel',[live]);c.indexMessage(live);
  rows.slice(0,499).forEach(row=>{c.indexMessage(row);c.pollCache.set(row.id,{});c.pollBusy.add(row.id)});
  const context={view:{key:'channel'},rows:rows.slice(),hasOlder:false,hasNewer:false};
  c.capHistoryContext(context,'older');
  assert.equal(context.rows.length,cap);assert.equal(context.rows[0].id,0);assert(context.hasNewer);
  assert.equal(c.msgById.get(499),live);assert.equal(c.msgById.get('499'),live);
  assert(!c.msgById.has(498));assert(!c.pollCache.has(498));assert(!c.pollBusy.has(498));
  context.rows=rows.slice();c.capHistoryContext(context,'newer');
  assert.equal(context.rows.length,cap);assert.equal(context.rows.at(-1).id,499);assert(context.hasOlder);
 }
});

test('native composer sizing does not read geometry or synchronously repin while typing',()=>{
 const ta={value:'Two lines\nof text',style:{height:'',removeProperty(){this.height=''}},get scrollHeight(){throw Error('forced layout')}};
 const counter={textContent:''};const c=vm.createContext({CSS:{supports:()=>true},$:id=>id==='message-input'?ta:counter});
 vm.runInContext(section('    const nativeComposerSizing =','    async function handleComposerSubmit('),c);
 c.autogrow();assert.equal(counter.textContent,ta.value.length);
 ta.style.height='120px';c.autogrow();assert.equal(ta.style.height,'');
});

test('slow-frame diagnostics are bounded, passive, and exclude message, account and URL contents',()=>{
 let callback,observed=0,now=100;
 class Observer{static supportedEntryTypes=['long-animation-frame','longtask'];constructor(fn){callback=fn}observe(){observed++}}
 const c=vm.createContext({PerformanceObserver:Observer,document:{hidden:false},performance:{now:()=>now}});
 vm.runInContext(section('    const performanceDiagnostics =','    const profiles ='),c);
 c.startPerformanceDiagnostics();c.startPerformanceDiagnostics();assert.equal(observed,1);
 for(let i=0;i<500;i++){now=i;c.notePerformanceWork('timeline-render',60)}
 callback({getEntries:()=>Array.from({length:500},(_,i)=>({startTime:i,duration:120,blockingDuration:30,renderStart:90,styleAndLayoutStart:100,
  sourceURL:'https://private.example/message-secret',scripts:[{sourceFunctionName:'flushBottomPin',duration:30,forcedStyleAndLayoutDuration:20,invokerType:'user-callback',invoker:'account-secret',sourceURL:'session-secret'}]}))});
 const captured=vm.runInContext('JSON.parse(JSON.stringify(performanceDiagnostics))',c);
 assert.equal(captured.samples.length,120);assert.equal(captured.work.length,64);assert.equal(captured.total,500);
 assert.equal(captured.samples[0].scripts[0].function,'flushBottomPin');
 assert(!JSON.stringify(captured).includes('secret'));
 c.document.hidden=true;callback({getEntries:()=>[{duration:500}]});assert.equal(vm.runInContext('performanceDiagnostics.total',c),500);
});
