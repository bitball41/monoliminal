import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const chat=await readFile(new URL('../Chat/chat.html',import.meta.url),'utf8');
function section(start,end){const a=chat.indexOf(start),b=chat.indexOf(end,a);assert(a>=0&&b>a);return chat.slice(a,b);}

test('private call checks are bounded, explicit changes check immediately, and stale checks cannot end a newer call',async()=>{
 let now=1_000_000,calls=0,release;
 const voice={roomId:'call',roomTopic:'topic',joinGen:1,accessCheckedAt:0};
 const c=vm.createContext({Date:{now:()=>now},voice,toast(){},leaveVoiceRoom(){voice.connected=false;},privateVoiceAccess:async()=>{calls++;return {topic:'topic',members:['a','b']};}});
 vm.runInContext(section('    async function checkPrivateVoiceAccess(', '    function openPrivateVoiceStage('),c);
 for(let tick=0;tick<150;tick++){await c.checkPrivateVoiceAccess({periodic:true});now+=4000;}
 assert.equal(calls,19,'19 checks in ten minutes instead of 150');
 await c.checkPrivateVoiceAccess();assert.equal(calls,20,'membership events bypass the interval');
 c.privateVoiceAccess=()=>new Promise(resolve=>release=resolve);
 const pending=c.checkPrivateVoiceAccess();await c.checkPrivateVoiceAccess();
 voice.joinGen++;voice.roomId='new-call';voice.connected=true;
 release({topic:'old-topic',members:[]});await pending;
 assert.equal(voice.connected,true);
});

test('mute subscription avoids repeated table reads, with a short fallback and request coalescing',async()=>{
 let now=1_000_000,calls=0,release;
 const voice={mutePollAt:0,muteLoad:null,muteChannel:{state:'joined'},serverMutes:new Map()};
 const c=vm.createContext({Date:{now:()=>now},voice,me:{},applyVoiceServerMutes(){},sb:{from:()=>({select:async()=>{calls++;return {data:[]};}})}});
 vm.runInContext(section('    async function loadVoiceServerMutes(', '    function applyVoiceServerMutes('),c);
 for(let tick=0;tick<150;tick++){await c.loadVoiceServerMutes({periodic:true});now+=4000;}
 assert.equal(calls,2);
 voice.muteChannel.state='errored';await c.loadVoiceServerMutes({periodic:true});assert.equal(calls,3);
 now+=12000;await c.loadVoiceServerMutes({periodic:true});assert.equal(calls,4);
 c.sb.from=()=>({select:()=>{calls++;return new Promise(resolve=>release=resolve);}});
 const a=c.loadVoiceServerMutes(),b=c.loadVoiceServerMutes();assert.equal(calls,5);release({data:[]});await Promise.all([a,b]);
});

test('open DM access uses a tiny RLS-protected lookup and removes revoked content',async()=>{
 let now=1_000_000,reads=0,revoked=false,discarded=[];
 const c=vm.createContext({Date:{now:()=>now},me:{username:'a'},currentView:{type:'dm',id:'group'},DM_RECONCILE_MS:20000,
 dms:[{id:'group'}],dmAccessCheck:null,lastDmAccessId:'',lastDmAccessAt:0,
 discardGroupCache:id=>discarded.push(id),renderDmList(){},
 sb:{from:table=>{assert.equal(table,'dms');return {select:columns=>{assert.equal(columns,'id');return {eq:()=>({maybeSingle:async()=>{reads++;return {data:revoked?null:{id:'group'}};}})};}};}}});
 vm.runInContext(section('    function reconcileOpenDmAccess(', '    async function refreshConversations('),c);
 await c.reconcileOpenDmAccess();await c.reconcileOpenDmAccess();assert.equal(reads,1);
 now+=20000;revoked=true;await c.reconcileOpenDmAccess();
 assert.equal(reads,2);assert.deepEqual(discarded,['group']);assert.equal(c.dms.length,0);
});

test('bursts of conversation invalidations share one refresh and at most one follow-up',async()=>{
 let reads=0,finish;
 const c=vm.createContext({me:{},presenceStopped:false,presenceLeft:false,conversationRefresh:null,
 conversationRefreshQueued:null,conversationRefreshDirty:false,setTimeout:fn=>setImmediate(fn),
 refreshConversations:async()=>{reads++;if(reads===1)await new Promise(resolve=>finish=resolve);}});
 vm.runInContext(section('    async function queueConversationRefresh(', '    function wireGroupEvents('),c);
 const jobs=Array.from({length:50},()=>c.queueConversationRefresh());
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reads,1);
 const late=Array.from({length:50},()=>c.queueConversationRefresh());finish();await Promise.all([...jobs,...late]);
 assert.equal(reads,2);
});

test('voice history reconciliation skips background tabs and coalesces periodic reads',async()=>{
 let now=1_000_000,reads=0;
 const c=vm.createContext({Date:{now:()=>now},voice:{historyLoaded:true},me:{},sb:{},document:{visibilityState:'hidden'},navigator:{onLine:true},
 realtimeHealthy:()=>true,MESSAGE_RECONCILE_MS:300000,MESSAGE_FALLBACK_POLL_MS:20000});
 const source=section('    let voiceChatReconcile =', '    async function readVoiceChatUpdates(');
 vm.runInContext(source,c);c.readVoiceChatUpdates=async()=>{reads++;};
 await c.reconcileVoiceChat({periodic:true});assert.equal(reads,0);
 c.document.visibilityState='visible';
 for(let tick=0;tick<30;tick++){await c.reconcileVoiceChat({periodic:true});now+=20000;}
 assert.equal(reads,2);
});

test('broken Realtime backs off instead of rebuilding all subscriptions every five seconds',()=>{
 let now=1_000_000,scheduled=0;
 const c=vm.createContext({me:{},sb:{},presenceLeft:false,presenceStopped:false,navigator:{onLine:true},document:{visibilityState:'visible'},
 realtimeRecovering:false,realtimeRecoverTimer:0,realtimeRecoverAttempt:5,lastRecoverAt:now,
 Date:{now:()=>now},clearTimeout(){},setTimeout(){scheduled++;return 1;},realtimeHealthy:()=>false});
 vm.runInContext(section('    function scheduleRealtimeRecover()', '    async function refreshSessionQuiet()'),c);
 for(let i=0;i<12;i++){c.scheduleRealtimeRecover();now+=5000;}assert.equal(scheduled,0);
 c.scheduleRealtimeRecover();assert.equal(scheduled,1);
 c.scheduleRealtimeRecover();assert.equal(scheduled,1,'does not continually replace a scheduled retry');
});
