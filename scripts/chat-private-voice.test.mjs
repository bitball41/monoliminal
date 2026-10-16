import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const chat = await file('Chat/chat.html');

test('private call signaling rejects outsiders, pending invites, blocks, bans, and stale membership topics', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const ids = Object.fromEntries(['alice','bob','owner'].map((name,i) => [name,`00000000-0000-4000-8000-00000000000${i+1}`]));
  const actor = async name => db.exec(`reset role;select set_config('request.jwt.claim.sub','${ids[name]}',false);set role authenticated;`);
  const room = async id => (await db.query('select public.chat_private_voice_room($1) room',[id])).rows[0].room;
  const allowed = async topic => {
    await db.exec('reset role');
    try { return (await db.query('select private.chat_private_voice_topic_allowed($1) ok',[topic])).rows[0].ok; }
    finally { await db.exec('set role authenticated'); }
  };
  try {
    await db.exec(await file('Backend/tests/authorization-fixture.sql'));
    for (const name of (await readdir(new URL('../Backend/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) await db.exec(await file('Backend/migrations/'+name));
    for (const [name,id] of Object.entries(ids)) {
      await db.query('insert into auth.users(id) values($1)',[id]);
      await db.query('insert into public.profiles(username,user_id,display_name,staff_role) values($1,$2,$1,$3)',[name,id,name==='owner'?'owner':'member']);
    }
    await actor('alice');
    const dm = (await db.query("insert into public.dms(participants) values(array['alice','bob']) returning id")).rows[0].id;
    const first = await room(dm);
    assert.equal(await allowed(first.topic),true);
    await db.query("select set_config('realtime.topic',$1,false)",[first.topic]);
    await db.query("insert into realtime.messages(topic,extension,payload) values($1,'broadcast','{}')",[first.topic]);
    await actor('owner');
    assert.equal(await allowed(first.topic),false,'staff are not private-call members');
    await assert.rejects(room(dm));
    await db.query("select set_config('realtime.topic',$1,false)",[first.topic]);
    assert.equal((await db.query('select count(*)::int n from realtime.messages')).rows[0].n,0);
    await assert.rejects(db.query("insert into realtime.messages(topic,extension) values($1,'broadcast')",[first.topic]));
    await actor('bob');
    assert.equal((await room(dm)).topic,first.topic);
    await db.query("insert into public.dm_blocks(blocker,blocked) values('bob','alice')");
    await actor('alice');
    assert.equal(await allowed(first.topic),false,'recipient blocking caller is checked server-side');
    await db.exec("reset role;delete from public.dm_blocks;");
    await actor('alice');
    const group = (await db.query("select public.chat_create_group('Call',array['bob']) id")).rows[0].id;
    await actor('bob');
    await assert.rejects(room(group),'pending invitations grant no access');
    await db.query('select public.chat_respond_group_invite($1,true)',[group]);
    const groupRoom = await room(group);
    await actor('alice');
    await db.query("select public.chat_manage_group($1,'invite','owner','')",[group]);
    await actor('owner');
    await db.query('select public.chat_respond_group_invite($1,true)',[group]);
    const changed = await room(group);
    assert.notEqual(changed.topic,groupRoom.topic);
    assert.equal(await allowed(groupRoom.topic),false,'old topics stop accepting connections');
    await actor('alice');
    await db.query("select public.chat_manage_group($1,'remove','bob','')",[group]);
    await actor('bob');
    await assert.rejects(room(group),'removed members cannot rejoin');
    await db.exec("reset role;update public.profiles set is_banned=true where username='bob';");
    await actor('bob');
    await assert.rejects(room(dm));
    await actor('alice');
    assert.equal(await allowed('liminal-private-voice:bad-id:nope'),false);
    await db.exec("reset role;insert into public.app_settings(key,value) values('dms_enabled','false') on conflict(key) do update set value='false';");
    await actor('alice');
    await assert.rejects(room(dm),'paused DMs disable calls too');
  } finally { await db.close(); }
});

test('private call stage and dock return to the DM, and private messages never use global room chat', () => {
  assert.match(chat,/id="private-call-btn"/);
  assert.match(chat,/sb.channel\(voice.roomId \? voice.roomTopic : VOICE_SIGNAL_CHANNEL/);
  assert.match(chat,/if \(voice.roomId && !voice.roomMembers.includes\(username\)\) return/);
  assert.match(chat,/if \(voice.roomId\) checkPrivateVoiceAccess\(\)/);
  assert.match(chat,/if \(view.type === 'dm' && view.privateCall\) return openPrivateVoiceStage\(view\)/);
  assert.match(chat,/openView\(dm \? \{ \.\.\.dmView\(dm\), privateCall: true \}/);
  const from = chat.indexOf('    async function sendVoiceChatMessage() {');
  assert.match(chat.slice(from,from+120),/if \(voice.roomId\) return/);
  assert.match(chat,/brokerGen === voice.joinGen/);
  for (const match of chat.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/src=|type=/.test(match[1])) new vm.Script(match[2]);
  }
});

test('starting a call checks access before leaving global voice, invites through the DM, and rejoins without another invite', async () => {
  const start = chat.indexOf('    async function privateVoiceAccess(id) {');
  const end = chat.indexOf('    function openVoiceRoom(view) {',start);
  const operations = [];
  const voice = { connected: true, roomId: null, joining: false };
  const context = vm.createContext({
    voice, me: { username: 'alice' },
    $: () => ({ close() {} }),
    sb: {
      rpc: async (name,{p_dm_id}) => p_dm_id==='blocked' ? {error:{message:'Blocked'}} : {data:{topic:'private:'+p_dm_id,members:['alice','bob']}},
      from: table => ({ insert: async row => { operations.push({table,row}); return {}; } }),
    },
    toast: detail => operations.push(detail),
    leaveVoiceRoom() { operations.push('leave'); voice.connected=false; },
    dmView: dm => ({type:'dm',id:dm.id,other:'bob'}),
    async openView(view) { operations.push(view); },
    async joinVoiceRoom() { operations.push('join'); voice.connected=true; },
  });
  vm.runInContext(chat.slice(start,end),context);
  await context.startPrivateCall({id:'blocked'});
  assert.equal(voice.connected,true,'failed membership does not end current call');
  assert.equal(operations.includes('leave'),false);
  await context.startPrivateCall({id:'dm-a'});
  assert.equal(voice.roomId,'dm-a');
  assert.equal(voice.roomTopic,'private:dm-a');
  assert.equal(operations.filter(item=>item==='leave').length,1);
  const invite = operations.find(item=>item.table);
  assert.equal(invite.table,'dm_messages');
  assert.equal(invite.row.dm_id,'dm-a');
  await context.startPrivateCall({id:'dm-a'});
  assert.equal(operations.filter(item=>item.table).length,1,'returning to active call does not send another invitation');
});
