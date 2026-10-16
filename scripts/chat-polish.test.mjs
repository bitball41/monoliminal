import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const chat=await readFile(new URL('../Chat/chat.html',import.meta.url),'utf8');
const section=(start,end)=>chat.slice(chat.indexOf(start),chat.indexOf(end,chat.indexOf(start)));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

test('microphone permission resolving after switching calls stops only the old stream',async()=>{
  const request=deferred();let stopped=0;
  const replacement={getTracks:()=>[{stop(){throw new Error('replacement stream must survive')}}]};
  const voice={joinGen:1,joining:false,connected:false,localStream:null,roomId:null};
  const context=vm.createContext({voice,crypto:{randomUUID:()=> 'fixture'},hostNeedsMediaPrompt:()=>false,
    clearVoiceBlockNote(){},setVoiceStatus(){},updateVoiceUi(){},prepareVoiceIce:async()=>{},requestVoiceMedia:()=>request.promise,
  });
  vm.runInContext(section('    async function joinVoiceRoom() {','    function peerRecord('),context);
  const joining=context.joinVoiceRoom();
  voice.joinGen++;voice.localStream=replacement;voice.connected=true;voice.joining=false;
  request.resolve({getTracks:()=>[{stop(){stopped++}}]});
  await joining;
  assert.equal(stopped,1);assert.equal(voice.localStream,replacement);assert.equal(voice.joining,false);
});

test('screen picker resolving after leaving stops capture and never publishes a track',async()=>{
  const request=deferred();let stopped=0,published=0;
  const voice={connected:true,joinGen:1,screenStream:null,sharePending:false};
  const context=vm.createContext({voice,navigator:{mediaDevices:{getDisplayMedia:()=>request.promise}},updateVoiceUi(){},
    replaceVoiceVideoTrack(){published++},toast(){throw new Error('cancellation must stay quiet')}
  });
  vm.runInContext(section('    async function toggleVoiceShare() {','    function leaveVoiceRoom('),context);
  const sharing=context.toggleVoiceShare();
  voice.connected=false;voice.joinGen++;
  const track={stop(){stopped++}};
  request.resolve({getVideoTracks:()=>[track],getTracks:()=>[track]});
  await sharing;
  assert.equal(stopped,1);assert.equal(published,0);assert.equal(voice.screenStream,null);assert.equal(voice.sharePending,false);
});

test('blocking a person hides their DM notifications but preserves shared-group notifications',()=>{
  const context=vm.createContext({dmBlockedUsers:new Set(['bob']),dms:[{id:'group',is_group:true,title:'Friends'}]});
  vm.runInContext(section('    function inboxItemVisible(','    function updateInboxBadge('),context);
  assert.equal(context.inboxItemVisible({kind:'dm',from:'bob',view:'dm:direct'}),false);
  assert.equal(context.inboxItemVisible({kind:'dm',from:'bob',view:'dm:group'}),true);
  assert.equal(context.inboxItemVisible({kind:'mention',from:'bob',view:'c:general'}),true);
});

test('voice identity verification retries after a temporary failure and expires cached successes',async()=>{
  let requests=0,now=100000;
  const voice={ticketNames:new Map()};
  const context=vm.createContext({voice,Date:{now:()=>now},sb:{rpc:async()=>++requests===1?{error:{message:'offline'}}:{data:'bob'}}});
  vm.runInContext(section('    async function verifiedVoiceUser(','    function stopVoiceLevel('),context);
  const ticket='bob.123.'+'a'.repeat(64);
  assert.equal(await context.verifiedVoiceUser(ticket),null);
  assert.equal(await context.verifiedVoiceUser(ticket),'bob');assert.equal(requests,2);
  assert.equal(await context.verifiedVoiceUser(ticket),'bob');assert.equal(requests,2);
  now+=61000;
  assert.equal(await context.verifiedVoiceUser(ticket),'bob');assert.equal(requests,3);
});
