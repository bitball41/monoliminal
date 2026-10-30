// Native API regression: a same-origin srcdoc child can register LoAF without
// receiving any entries. Exercise the production recorder, not an API mock.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const html=await fs.readFile(new URL('../Chat/chat.html',import.meta.url),'utf8');
const from=html.indexOf('    const performanceDiagnostics ='),to=html.indexOf('    const profiles =',from);
assert(from>=0&&to>from);
const fixture=`<!doctype html><body><p id="probe">Ready</p><script>
${html.slice(from,to)}
const APP_VERSION='fixture', profiles=new Map(),livePresence=new Map(),msgCache=new Map(),historyContexts=new Map();
const voice={peers:new Map()},chatBackgroundChoice='off',realtimeGen=0;
const qsa=selector=>[...document.querySelectorAll(selector)],realtimeHealthy=()=>true;
window.legacyFrames=0;
if(PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'))
 new PerformanceObserver(list=>legacyFrames+=list.getEntries().length).observe({type:'long-animation-frame'});
startPerformanceDiagnostics();window.__diagFixtureReady=true;
</script>`;
function wrap(child,opaque=false){return `<!doctype html><body><iframe id="frame" ${opaque?'sandbox="allow-scripts"':''} style="border:0;width:100%;height:600px"></iframe><script>
// Count native parent observers to catch leaks when the child is replaced.
window.activeFrameObservers=new Set();window.disconnectedFrameObservers=0;
const nativeObserve=PerformanceObserver.prototype.observe,nativeDisconnect=PerformanceObserver.prototype.disconnect;
PerformanceObserver.prototype.observe=function(options){const result=nativeObserve.call(this,options);if(options.type==='long-animation-frame')activeFrameObservers.add(this);return result};
PerformanceObserver.prototype.disconnect=function(){if(activeFrameObservers.delete(this))disconnectedFrameObservers++;return nativeDisconnect.call(this)};
document.getElementById('frame').srcdoc=${JSON.stringify(child).replaceAll('<','\\u003c')};</script>`}
const output=await fs.mkdtemp(path.join(os.tmpdir(),'chat-diagnostics-'));
const browser=await chromium.launch({...(process.env.CHAT_BROWSER_PATH?{executablePath:process.env.CHAT_BROWSER_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 // Managed browsers can prohibit file: navigation. Keep that case available
 // by default and allow the remaining native contexts to run independently.
 const kinds=['standalone','https-srcdoc','file-srcdoc','nested-srcdoc','opaque-srcdoc']
  .filter(kind=>!process.argv.includes('--https-only')||kind!=='file-srcdoc');
 for(const kind of kinds){
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const body=kind==='standalone'?fixture:kind==='nested-srcdoc'?wrap(wrap(fixture)):wrap(fixture,kind==='opaque-srcdoc');
  await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.request().url()==='https://diagnostics.test/'?route.fulfill({contentType:'text/html',body}):route.abort());
  const local=path.join(output,'launcher.html');
  if(kind==='file-srcdoc')await fs.writeFile(local,body);
  await page.goto(kind==='file-srcdoc'?pathToFileURL(local).href:'https://diagnostics.test/');
  const frame=page.frames().at(-1);await frame.waitForFunction(()=>window.__diagFixtureReady);
  assert.equal(await frame.evaluate(()=>performanceDiagnostics.frameRaf),0,'recording defaults off');
  await frame.evaluate(()=>startFrameCapture());await page.waitForTimeout(80);
  await frame.evaluate(()=>new Promise(resolve=>setTimeout(function fixtureKnownStall(){
   window.stallAt=performance.now();while(performance.now()-stallAt<180){}
   document.getElementById('probe').textContent='Rendered after a 180 ms stall';resolve();
  },30)));
  // Some Chromium versions also omit LoAF in an opaque sandbox. Local tasks
  // and the opt-in interval capture must still work without ancestor access.
  await frame.waitForFunction(opaque=>opaque?performanceReport().longTasks.total>0:performanceReport().samples.some(s=>s.duration>=150),kind==='opaque-srcdoc');
  await page.waitForTimeout(100);
  const result=await frame.evaluate(()=>{stopFrameCapture('fixture-complete');return {report:performanceReport(),legacyFrames,stallAt}});
  const {report}=result;
  assert.equal(report.coverage.frameScope,['https-srcdoc','file-srcdoc','nested-srcdoc'].includes(kind)?'same-origin-root':'document');
  assert.equal(report.coverage.ancestorDepth,kind==='nested-srcdoc'?2:['https-srcdoc','file-srcdoc'].includes(kind)?1:0);
  if(kind!=='opaque-srcdoc')assert(report.samples.some(s=>s.duration>=150&&Math.abs(s.at-result.stallAt)<80),'ancestor timestamps match the child clock');
  assert(report.longTasks.total>0,'local task observer also captures the stall');
  assert(report.frameCapture.evidence.tasks.samples.some(s=>s.duration>=150),'recording retains the matching local task');
  if(kind!=='opaque-srcdoc')assert(report.frameCapture.evidence.frames.samples.some(s=>s.duration>=150&&Math.abs(s.at-result.stallAt)<80),'recording retains the matching frame in the child clock');
  assert(report.frameCapture.rendering.length>=2&&report.frameCapture.rendering.length<=62,'recording includes bounded rendering context');
  assert(report.frameCapture.maxGapMs>=100,'opt-in sampler sees the missed frame intervals');
  assert.equal(report.frameCapture.running,false);
  assert.equal(await frame.evaluate(()=>performanceDiagnostics.frameRaf),0);
  if(['https-srcdoc','file-srcdoc','nested-srcdoc'].includes(kind))assert.equal(result.legacyFrames,0,'old child-only observer misses the positive control');
  if(['https-srcdoc','file-srcdoc'].includes(kind)){
   assert.equal(await page.evaluate(()=>activeFrameObservers.size),1);
   await page.evaluate(fixture=>document.getElementById('frame').srcdoc=fixture,fixture);
   await page.waitForFunction(()=>document.getElementById('frame').contentWindow.__diagFixtureReady);
   assert.equal(await page.evaluate(()=>activeFrameObservers.size),1,'refresh releases the old parent-owned observer');
   assert.equal(await page.evaluate(()=>disconnectedFrameObservers),1);
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({kind,chrome:await browser.version(),legacyFrames:result.legacyFrames,frames:report.slowFrames,tasks:report.longTasks.total,maxGapMs:report.frameCapture.maxGapMs,scope:report.coverage.frameScope}));
  await page.close();
 }
}finally{await browser.close();await fs.rm(output,{recursive:true,force:true})}
