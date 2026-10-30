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

function history(){
 const c=vm.createContext({msgCache:new Map(),msgById:new Map(),pollCache:new Map(),pollBusy:new Set(),viewKey:v=>v.key});
 vm.runInContext(section('    function indexMessage(','    function profileOf(')+'\n'+section('    const HISTORY_MESSAGE_CAP =','    function clearHistoryContexts('),c);
 return c;
}
test('history paging stays bounded in both directions and preserves live message aliases',()=>{
 {
  const c=history(),cap=200,rows=Array.from({length:500},(_,id)=>({id,content:`row${id}`}));
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

function diagnostics({embedded=false,supported=['long-animation-frame','longtask'],blockedParent=false,query=()=>[]}={}){
 let now=100,sequence=0;
 const observers=[],frames=new Map(),events=new Map(),docEvents=new Map();
 const observerClass=realm=>class {
  static supportedEntryTypes=supported;
  constructor(callback){this.callback=callback;this.realm=realm;this.pending=[];observers.push(this)}
  observe({type}){this.type=type} takeRecords(){return this.pending.splice(0)} disconnect(){this.disconnected=true}
 };
 const c=vm.createContext({PerformanceObserver:observerClass('chat'),
  document:{hidden:false,images:[],documentElement:{hasAttribute:()=>true},getElementById:()=>null,addEventListener:(name,fn)=>docEvents.set(name,fn)},
  addEventListener:(name,fn)=>events.set(name,fn),performance:{now:()=>now,timeOrigin:1000},
  requestAnimationFrame(fn){const id=++sequence;frames.set(id,fn);return id},cancelAnimationFrame:id=>frames.delete(id),
  APP_VERSION:'test',navigator:{userAgent:'Chrome/147',deviceMemory:8,hardwareConcurrency:8},
  chatBackgroundChoice:'off',innerWidth:1536,innerHeight:839,devicePixelRatio:1.25,
  profiles:new Map(),livePresence:new Map(),msgCache:new Map(),historyContexts:new Map(),qsa:query,
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


test('recordings preserve matching frame/task/work evidence when downloaded ten minutes later',()=>{
 const d=diagnostics({embedded:true});d.c.startPerformanceDiagnostics();
 // Start drains old pending observations before creating this recording.
 d.observers[0].pending.push({startTime:250,duration:60});
 d.c.startFrameCapture();assert.equal(d.snapshot().frameCapture.evidence.frames.total,0);
 d.frame(116);
 d.emit('long-animation-frame',[{startTime:350,duration:80,renderStart:420,styleAndLayoutStart:425}]);
 d.emit('longtask',[{startTime:150,duration:65}]);
 d.c.notePerformanceWork('timeline-render',60);
 d.frame(260);
 d.observers[0].pending.push({startTime:380,duration:70});
 d.observers[1].pending.push({startTime:180,duration:55});
 d.c.stopFrameCapture('download');
 const saved=d.snapshot().frameCapture;
 assert.equal(saved.evidence.frames.total,2,'stop drains pending entries into the recording');
 assert.deepEqual(saved.evidence.frames.samples.map(s=>s.at),[150,180],'root timestamps use Chat time');
 assert.deepEqual(saved.evidence.tasks.samples.map(s=>s.at),[150,180]);
 assert(saved.evidence.work.samples.some(s=>s.name==='timeline-render'&&s.count===60));
 assert.equal(saved.evidence.work.samples.at(-1).name,'frame-capture-stop');
 d.frame(600260);
 for(let i=0;i<140;i++){
  d.emit('long-animation-frame',[{startTime:600200+i,duration:100}]);
  d.emit('longtask',[{startTime:600000+i,duration:60}]);
  d.c.notePerformanceWork('message-current');
 }
 assert.deepEqual(d.snapshot().frameCapture,saved,'later passive samples cannot overwrite the recorded window');
 assert(d.snapshot().samples.every(s=>s.at>saved.startedAt+saved.durationMs));
 assert.equal(d.frames.size,0,'the stopped recording adds no sampler');
});

test('capture evidence is bounded and private, and rendering context is sampled only on gaps',()=>{
 const queries=[];
 const d=diagnostics({query:selector=>{queries.push(selector);return Array.from({length:selector.includes('name-effect')?3:2},()=>({getBoundingClientRect(){throw Error('layout read')},src:'private-avatar-secret'}))}});
 d.c.startPerformanceDiagnostics();assert.equal(queries.length,0,'passive observers do not inspect the DOM');
 d.c.startFrameCapture();const initialQueries=queries.length;assert(initialQueries>0);
 d.frame(116);d.frame(132);assert.equal(queries.length,initialQueries,'regular frames do not collect context');
 d.frame(200);assert.equal(queries.length,initialQueries,'gaps within a second reuse known context');
 d.frame(1200);assert.equal(queries.length,initialQueries*2);
 d.frame(1280);assert.equal(queries.length,initialQueries*2,'repeated gaps are rate limited');
 const entries=Array.from({length:500},(_,i)=>({startTime:200+i,duration:100,sourceURL:'private-secret',
  scripts:[{sourceFunctionName:'flushBottomPin',duration:10,invoker:'private-secret',sourceURL:'private-secret'}]}));
 d.emit('long-animation-frame',entries);d.emit('longtask',entries);
 for(let i=0;i<500;i++)d.c.notePerformanceWork('message-current');
 let report=d.snapshot(),capture=report.frameCapture;
 assert.equal(capture.evidence.frames.total,500);assert.equal(capture.evidence.frames.samples.length,120);
 assert.equal(capture.evidence.tasks.total,500);assert.equal(capture.evidence.tasks.samples.length,120);
 assert.equal(capture.evidence.work.samples.length,64);
 assert(!JSON.stringify(report).includes('private'),'capture omits URLs, invokers and DOM nodes');
 assert.equal(capture.rendering[0].intersectingAnimatedNames,3);
 assert.equal(capture.rendering[0].openDialogs,2);assert.equal(capture.rendering[0].background,'off');
 assert(capture.gaps.every(g=>capture.rendering.some(r=>r.at===g.renderingAt)));
 for(let at=1320;at<60100;at+=40)d.frame(at);
 d.frame(60116);capture=d.snapshot().frameCapture;
 assert.equal(capture.running,false);assert(capture.rendering.length<=62);assert(capture.gaps.length<=120);
 assert(capture.rendering.every((entry,i,all)=>i===0||i===all.length-1||entry.at-all[i-1].at>=1000));
 assert.equal(d.frames.size,0);
});

test('hiding a recording excludes hidden observations and does not collect hidden rendering state',()=>{
 const d=diagnostics();d.c.startPerformanceDiagnostics();d.c.startFrameCapture();d.frame(116);
 const before=d.snapshot().frameCapture;
 d.c.document.hidden=true;d.docEvents.get('visibilitychange')();
 d.emit('long-animation-frame',[{startTime:120,duration:100}]);
 d.emit('longtask',[{startTime:120,duration:100}]);d.frame(600116);
 const stopped=d.snapshot().frameCapture;
 assert.equal(stopped.stopReason,'page-hidden');assert.equal(stopped.intervals,0);
 assert.deepEqual(stopped.rendering,before.rendering);
 assert.equal(stopped.evidence.frames.total,0);assert.equal(stopped.evidence.tasks.total,0);
 d.c.document.hidden=false;d.frame(600132);
 assert.deepEqual(d.snapshot().frameCapture,stopped,'restoring the tab cannot add hidden time or new evidence');
});
