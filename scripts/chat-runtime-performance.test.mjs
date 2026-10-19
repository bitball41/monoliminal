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

function diagnostics({embedded=false,supported=['long-animation-frame','longtask'],blockedParent=false}={}){
 let now=100,sequence=0;
 const observers=[],frames=new Map(),events=new Map(),docEvents=new Map();
 const observerClass=realm=>class {
  static supportedEntryTypes=supported;
  constructor(callback){this.callback=callback;this.realm=realm;this.pending=[];observers.push(this)}
  observe({type}){this.type=type} takeRecords(){return this.pending.splice(0)} disconnect(){this.disconnected=true}
 };
 const c=vm.createContext({PerformanceObserver:observerClass('chat'),
  document:{hidden:false,images:[],getElementById:()=>null,addEventListener:(name,fn)=>docEvents.set(name,fn)},
  addEventListener:(name,fn)=>events.set(name,fn),performance:{now:()=>now,timeOrigin:1000},
  requestAnimationFrame(fn){const id=++sequence;frames.set(id,fn);return id},cancelAnimationFrame:id=>frames.delete(id),
  APP_VERSION:'test',navigator:{userAgent:'Chrome/147',deviceMemory:8,hardwareConcurrency:8},
  isLiteMode:()=>false,chatBackgroundChoice:'off',innerWidth:1536,innerHeight:839,devicePixelRatio:1.25,
  profiles:new Map(),livePresence:new Map(),msgCache:new Map(),historyContexts:new Map(),qsa:()=>[],
  voice:{peers:new Map()},realtimeHealthy:()=>true,realtimeGen:0});
 c.window=c;c.parent=c;
 if(embedded){const parent={PerformanceObserver:observerClass('launcher'),document:{},performance:{timeOrigin:800}};parent.parent=parent;c.parent=parent}
 if(blockedParent)c.parent={get document(){throw Error('cross-origin')}};
 vm.runInContext(section('    const performanceDiagnostics =','    const profiles ='),c);
 return {c,observers,frames,events,docEvents,
  emit(type,entries){const observer=observers.findLast(o=>o.type===type&&!o.disconnected);assert(observer,type);observer.callback({getEntries:()=>entries})},
  snapshot(){return JSON.parse(JSON.stringify(c.performanceReport()))},
  frame(at){now=at;const jobs=[...frames.values()];frames.clear();jobs.forEach(fn=>fn(at))}};
}
test('diagnostics are passive, bounded, independently record tasks, and omit private attribution',()=>{
 const d=diagnostics(),{c}=d;
 c.startPerformanceDiagnostics();c.startPerformanceDiagnostics();assert.equal(d.observers.length,2);
 assert.equal(d.frames.size,0,'no animation loop until recording is explicitly started');
 for(let i=0;i<500;i++)c.notePerformanceWork('timeline-render',60);
 const entries=Array.from({length:500},(_,i)=>({startTime:i,duration:120,blockingDuration:30,renderStart:90,styleAndLayoutStart:100,
  sourceURL:'https://private.example/message-secret',scripts:Array.from({length:10},()=>({sourceFunctionName:'flushBottomPin',duration:30,forcedStyleAndLayoutDuration:20,invokerType:'user-callback',invoker:'account-secret',sourceURL:'session-secret'}))}));
 d.emit('long-animation-frame',entries);d.emit('longtask',entries);
 const report=d.snapshot();
 assert.equal(report.samples.length,120);assert.equal(report.work.length,64);assert.equal(report.slowFrames,500);
 assert.equal(report.longTasks.total,500);assert.equal(report.longTasks.samples.length,120);
 assert.equal(report.samples[0].scripts[0].function,'flushBottomPin');assert.equal(report.samples[0].scripts.length,5);
 assert(!JSON.stringify(report).includes('secret'));assert.equal(report.frameCapture,null);
 c.document.hidden=true;d.emit('long-animation-frame',entries);d.emit('longtask',entries);
 assert.equal(d.snapshot().slowFrames,500);assert.equal(d.snapshot().longTasks.total,500);
});
test('launcher diagnostics use the ancestor observer realm and translate its timestamps to Chat time',()=>{
 const d=diagnostics({embedded:true});d.c.startPerformanceDiagnostics();
 assert.deepEqual(d.observers.map(o=>[o.realm,o.type]),[['launcher','long-animation-frame'],['chat','longtask']]);
 d.emit('long-animation-frame',[{startTime:400,duration:180,renderStart:550,styleAndLayoutStart:560}]);
 d.emit('long-animation-frame',[{startTime:600,duration:100,renderStart:0,styleAndLayoutStart:0}]);
 d.emit('longtask',[{startTime:200,duration:180}]);
 const r=d.snapshot();assert.equal(r.coverage.frameScope,'same-origin-root');assert.equal(r.coverage.ancestorDepth,1);
 assert.equal(r.coverage.embedded,true);assert.equal(r.coverage.rootClockOffsetMs,-200);assert.equal(r.samples[0].at,200);
 assert.equal(r.samples[0].renderStart,350);assert.equal(r.samples[0].layoutStart,360);
 assert.equal(r.samples[1].renderStart,0);assert.equal(r.samples[1].layoutStart,0);
 assert.equal(r.longTasks.samples[0].at,200,'local task timestamps already use Chat time');
});
test('export drains queued entries; pagehide disconnects ancestor observers and bfcache resumes once',()=>{
 const d=diagnostics({embedded:true});d.c.startPerformanceDiagnostics();
 d.observers[0].pending.push({startTime:400,duration:180});
 assert.equal(d.snapshot().slowFrames,1);assert.equal(d.snapshot().slowFrames,1,'pending entries are not counted twice');
 d.c.startFrameCapture();assert.equal(d.frames.size,1);
 d.events.get('pagehide')();assert(d.observers.every(o=>o.disconnected));assert.equal(d.frames.size,0);
 assert.equal(d.snapshot().coverage.active,false);
 d.events.get('pageshow')({persisted:false});assert.equal(d.observers.length,2);
 d.events.get('pageshow')({persisted:true});d.events.get('pageshow')({persisted:true});assert.equal(d.observers.length,4);
 assert.equal(d.snapshot().coverage.active,true);
});
test('task-only and unsupported browsers remain usable across a cross-origin ancestor boundary',()=>{
 for(const supported of [['longtask'],[]]){
  const d=diagnostics({supported,blockedParent:true});d.c.startPerformanceDiagnostics();
  assert.equal(d.frames.size,0);assert.equal(d.snapshot().slowFrames,null,'unsupported frame counts are unknown, not zero');
  assert.equal(d.snapshot().coverage.frameObserver,false);
  assert.equal(d.snapshot().coverage.embedded,true);
  if(supported.length){d.emit('longtask',[{startTime:100,duration:70}]);assert.equal(d.snapshot().longTasks.total,1)}
  else assert.equal(d.snapshot().coverage.active,false);
 }
});
test('opt-in recording retains bounded frame gaps, stops after 60 seconds, and excludes hidden time',()=>{
 const d=diagnostics();d.c.startPerformanceDiagnostics();d.c.startFrameCapture();d.c.startFrameCapture();
 assert.equal(d.frames.size,1,'starting twice cannot create duplicate samplers');
 d.frame(116);
 for(let i=1;i<=500;i++)d.frame(116+i*80);
 let capture=d.snapshot().frameCapture;assert.equal(capture.intervals,500);assert.equal(capture.gaps.length,120);
 assert.equal(capture.maxGapMs,80);assert.equal(capture.histogram.counts.reduce((a,b)=>a+b),500);
 d.frame(60116);assert.equal(d.frames.size,0);assert.equal(d.snapshot().frameCapture.stopReason,'time-limit');
 d.c.startFrameCapture();d.frame(60132);d.c.document.hidden=true;d.docEvents.get('visibilitychange')();
 capture=d.snapshot().frameCapture;assert.equal(capture.intervals,0);assert.equal(capture.stopReason,'page-hidden');assert.equal(d.frames.size,0);
 d.c.document.hidden=false;d.frame(100000);assert.equal(d.snapshot().frameCapture.intervals,0,'restoring the tab cannot add a fake lag gap');
});
