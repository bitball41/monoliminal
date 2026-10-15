import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert(from >= 0 && to > from, `section ${start}`);
  return source.slice(from, to);
}

function channelHarness(rows) {
  const list = { innerHTML: '' };
  const opened = [];
  const context = vm.createContext({
    VOICE_CHANNEL_ID: 'voice-chat',
    FOLLOWING_CHANNEL: 'following',
    channels: rows,
    currentView: { type: 'channel', id: 'general' },
    unreadCounts: new Map(),
    collapsedCats: new Set(),
    isForumThreadView: () => false,
    canManageChannels: () => false,
    channelById: (id) => context.channels.find(channel => channel.id === id),
    wireChannelDrag() {},
    updateSidebarIndicator() {},
    openChannelDialog() {},
    toggleCategory() {},
    openView(view) { opened.push(view); },
    $(id) {
      if (id === 'channel-list') return list;
      if (id === 'channel-add') return { hidden: true };
      return null;
    },
    qsa(sel, root) {
      const html = root?.innerHTML || '';
      const attr = sel === '[data-channel]' ? 'data-channel' : (sel === '[data-cat-toggle]' ? 'data-cat-toggle' : '');
      if (!attr) return [];
      const key = attr === 'data-channel' ? 'channel' : 'catToggle';
      return [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))].map(match => ({
        dataset: { [key]: match[1] },
        addEventListener(type, fn) { if (type === 'click') this.click = fn; },
      }));
    },
  });
  vm.runInContext([
    section(chat, '    function esc(text) {', '    function debounce(fn, ms) {'),
    section(chat, '    function activeChannelId() {', '    function patchChannelUnread(channelId) {'),
  ].join('\n'), context);
  return { context, list, opened };
}

test('voice chat is listed and Following stays hidden', () => {
  const { context, list } = channelHarness([
    { id: 'general', label: 'general', icon: '#', category: '', kind: 'chat' },
    { id: 'voice-chat', label: 'Voice Chat', icon: '🎥', category: 'Voice', kind: 'voice', is_system: true },
    { id: 'following', label: 'Following', icon: '📰', category: 'Feed', kind: 'forum' },
  ]);
  context.renderChannels();
  assert.match(list.innerHTML, /data-channel="voice-chat"/);
  assert.match(list.innerHTML, /Voice Chat/);
  assert.match(list.innerHTML, /data-channel="general"/);
  assert.doesNotMatch(list.innerHTML, /data-channel="following"/);
  assert.equal(context.channelIsVisible(context.channels[1]), true);
  assert.equal(context.channelIsHome(context.channels[1]), false);
  assert.equal(context.channelIsVisible(context.channels[2]), false);
  assert.equal(context.channelIsHome(context.channels[0]), true);
});

test('clicking Voice Chat opens that channel', () => {
  const { context, opened } = channelHarness([
    { id: 'general', label: 'general', icon: '#', category: '', kind: 'chat' },
    { id: 'voice-chat', label: 'Voice Chat', icon: '🎥', category: 'Voice', kind: 'voice', is_system: true },
  ]);
  const clicks = [];
  context.qsa = (sel, root) => {
    const html = root?.innerHTML || '';
    if (sel !== '[data-channel]') return [];
    return [...html.matchAll(/data-channel="([^"]*)"/g)].map(match => ({
      dataset: { channel: match[1] },
      addEventListener(type, fn) { if (type === 'click') clicks.push({ id: match[1], fn }); },
    }));
  };
  context.renderChannels();
  const voice = clicks.find(button => button.id === 'voice-chat');
  voice.fn({ target: { closest: () => null } });
  assert.equal(opened.length, 1);
  assert.equal(String(opened[0].type), 'channel');
  assert.equal(String(opened[0].id), 'voice-chat');
});

test('a stored voice row is forced into the voice room', async () => {
  const rows = [
    { id: 'general', label: 'general', kind: 'chat', icon: '#', category: '', position: 1 },
    { id: 'voice-chat', label: 'old name', kind: 'chat', icon: '#', category: '', position: 9 },
  ];
  const context = vm.createContext({
    VOICE_CHANNEL_ID: 'voice-chat',
    channels: [],
    sb: { from() { return { select() { return { order: async () => ({ data: rows }) }; } }; } },
  });
  vm.runInContext(section(chat, '    async function loadChannels() {', '    async function loadDms() {'), context);
  await context.loadChannels();
  const voice = context.channels.find(channel => channel.id === 'voice-chat');
  assert.equal(voice.kind, 'voice');
  assert.equal(voice.is_system, true);
  assert.equal(voice.icon, '🎥');
  assert.equal(voice.category, 'Voice');
  assert.equal(voice.label, 'old name');
  assert.equal(context.channels.some(channel => channel.id === 'general'), true);
});

test('voice is inserted when the database has no voice channel', async () => {
  const context = vm.createContext({
    VOICE_CHANNEL_ID: 'voice-chat',
    channels: [],
    sb: { from() { return { select() { return { order: async () => ({ data: [] }) }; } }; } },
  });
  vm.runInContext(section(chat, '    async function loadChannels() {', '    async function loadDms() {'), context);
  await context.loadChannels();
  assert.equal(context.channels.length, 1);
  assert.equal(context.channels[0].id, 'voice-chat');
  assert.equal(context.channels[0].kind, 'voice');
});

test('opening voice is no longer bounced away, and calls are not relay-only', () => {
  const openView = section(chat, '    async function openView(view) {', '    async function fetchMessages(view, beforeIso) {');
  assert.match(openView, /hiddenChannelId === FOLLOWING_CHANNEL/);
  assert.doesNotMatch(openView, /hiddenChannelId === VOICE_CHANNEL_ID/);
  assert.match(openView, /view\.id === VOICE_CHANNEL_ID \|\| \(fch && fch\.kind === 'voice'\)\) return openVoiceRoom\(view\)/);
  assert.equal([...chat.matchAll(/iceTransportPolicy: '([^']+)'/g)].map(match => match[1]).join(','), 'all,all');
  assert.doesNotMatch(chat, /\.vc-dock\s*\{[^}]*display:\s*none\s*!important/);
  assert.doesNotMatch(chat, /id="vc-empty"/);
  assert.doesNotMatch(chat, /Allow Remote Clicks/);
  assert.match(chat, /class="vc-bar"/);
  assert.match(chat, /stream\.addTrack\(track\)|picture\.addTrack\(track\)|heard\.addTrack\(track\)/);
  assert.match(chat, /contentHint = screen \? 'detail' : 'motion'/);
  assert.match(chat, /maintain-resolution/);
  assert.doesNotMatch(chat, /staticauth\.openrelay\.metered\.ca/);
  assert.match(chat, /type: 'rollback'/);
  assert.match(chat, /Tap to hear/);
  assert.match(chat, /chat_voice_ticket/);
  assert.match(chat, /School and campus Wi-Fi block direct voice/);
  assert.match(chat, /id="vc-deafen-btn"/);
  assert.match(chat, /Ctrl\+Shift\+M/);
  assert.doesNotMatch(chat, /id="vc-allow-interactions"/);
  const roomChat = section(chat, '    async function sendVoiceChatMessage() {', '    function setVoiceChatOpen(open) {');
  assert.match(roomChat, /moderationVerdict\(content\)/);
  assert.match(roomChat, /isTimedOut\(\)/);
  assert.match(chat, /chat_set_voice_mute/);
  assert.match(chat, /box-shadow: inset 0 0 0 1px #3ba55d/);
});

test('voice tickets bind the signed-in account and TURN is owner-only', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(await file('Backend/tests/authorization-fixture.sql'));
    for (const name of (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(await file('Backend/migrations/' + name));
    }
    const ids = { alice: '00000000-0000-4000-8000-000000000011', owner: '00000000-0000-4000-8000-000000000012' };
    for (const [name, id] of Object.entries(ids)) {
      await db.query('insert into auth.users(id) values($1)', [id]);
      await db.query('insert into public.profiles(username,user_id,display_name,staff_role) values($1,$2,$1,$3)', [name, id, name === 'owner' ? 'owner' : 'member']);
    }
    const actor = async name => db.exec(`reset role;select set_config('request.jwt.claim.sub','${ids[name]}',false);set role authenticated;`);
    await actor('alice');
    const ticket = (await db.query('select public.chat_voice_ticket() ticket')).rows[0].ticket;
    assert.equal((await db.query('select public.chat_voice_verify($1) name', [ticket])).rows[0].name, 'alice');
    assert.equal((await db.query('select public.chat_voice_verify($1) name', [ticket.slice(0, -1) + (ticket.endsWith('a') ? 'b' : 'a')])).rows[0].name, null);
    await assert.rejects(db.query("select public.chat_owner_configure('turn_servers','')"));
    await actor('owner');
    await db.query("select public.chat_owner_configure('turn_servers',$1)", ['[{"urls":"turns:turn.example.com:443","username":"voice","credential":"secret"}]']);
    await assert.rejects(db.query("select public.chat_owner_configure('turn_servers',$1)", ['[{"urls":"https://turn.example.com"}]']));
    const stored = (await db.query("select value from public.app_settings where key='turn_servers'")).rows[0].value;
    assert.match(stored, /turns:turn\.example\.com:443/);
    await db.exec('reset role');
    assert.doesNotMatch((await db.query("select details::text as details from private.chat_admin_audit where target='turn_servers'")).rows.at(-1).details, /secret/);
  } finally { await db.close(); }
});

test('staff can voice-mute only accounts below their rank', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(await file('Backend/tests/authorization-fixture.sql'));
    for (const name of (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(await file('Backend/migrations/' + name));
    }
    const ids = {
      member: '00000000-0000-4000-8000-000000000021',
      mod: '00000000-0000-4000-8000-000000000022',
      owner: '00000000-0000-4000-8000-000000000023',
    };
    for (const [name, id] of Object.entries(ids)) {
      await db.query('insert into auth.users(id) values($1)', [id]);
      await db.query('insert into public.profiles(username,user_id,display_name,staff_role) values($1,$2,$1,$3)', [name, id, name]);
    }
    const actor = async name => db.exec(`reset role;select set_config('request.jwt.claim.sub','${ids[name]}',false);set role authenticated;`);
    await actor('member');
    await assert.rejects(db.query("select public.chat_set_voice_mute('mod', true)"));
    await actor('mod');
    await assert.rejects(db.query("select public.chat_set_voice_mute('owner', true)"));
    await db.query("select public.chat_set_voice_mute('member', true)");
    assert.equal((await db.query("select muted_by from public.voice_server_mutes where username='member'")).rows[0].muted_by, 'mod');
    await actor('member');
    assert.equal((await db.query("select count(*)::int n from public.voice_server_mutes")).rows[0].n, 1);
    await actor('mod');
    await db.query("select public.chat_set_voice_mute('member', false)");
    assert.equal((await db.query("select count(*)::int n from public.voice_server_mutes")).rows[0].n, 0);
  } finally { await db.close(); }
});
