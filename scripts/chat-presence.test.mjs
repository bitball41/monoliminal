import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');

function section(start, end) {
  const from = chat.indexOf(start), to = chat.indexOf(end, from);
  assert(from >= 0 && to > from, `application section exists: ${start}`);
  return chat.slice(from, to);
}

// Use the shipped SDK's actual Phoenix state/diff algorithm and its adapter.
// This catches lost metadata refs, which a hand-written presence mock conceals.
const sdkContext = vm.createContext({ window: {}, console, URL, Headers });
vm.runInContext(chat.match(/<script>\s*(\/\* @supabase[\s\S]*?)<\/script>/)[1], sdkContext);
const RealtimePresence = sdkContext.supabase.RealtimePresence;

function presenceWire(onPresence = () => {}) {
  const handlers = new Map();
  let joinRef = '1';
  const raw = {
    on(event, callback) { handlers.set(event, callback); },
    joinRef: () => joinRef,
    trigger(event, payload) { if (event === 'presence') onPresence(payload); },
  };
  const presence = new RealtimePresence({ channelAdapter: { getChannel: () => raw } });
  return {
    state: () => presence.state,
    full: state => handlers.get('presence_state')(structuredClone(state)),
    diff: diff => handlers.get('presence_diff')(structuredClone(diff)),
    rejoin: () => { joinRef = String(Number(joinRef) + 1); },
  };
}

function entry(username, ref, more = {}) {
  return { metas: [{ phx_ref: ref, username, ...more }] };
}

async function settle() {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let keySequence = 0;
function chatPresence() {
  let now = 1_000_000, timerSequence = 0;
  const channels = [], removed = [], rest = [], timers = new Map(), listeners = new Map();
  const wakeJobs = [], elements = new Map();
  const accounts = ['alice', 'bob', 'carol'].map(username => ({
    username, status: 'online', custom_status: '', display_name: username,
  }));
  const profiles = new Map(accounts.map(account => [account.username, account]));
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', innerHTML: '', dataset: {}, hidden: false,
      addEventListener() {},
    });
    return elements.get(id);
  };
  const addListener = (name, callback) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(callback);
  };
  const client = {
    channel(topic, options) {
      const callbacks = [];
      const channel = {
        topic, options, state: 'joining', tracks: [], untracks: 0,
        trackReply: async () => 'ok',
        on(type, filter, callback) { callbacks.push({ type, filter, callback }); return this; },
        subscribe(callback) { this.subscription = callback; return this; },
        track(payload) { this.tracks.push(payload); return this.trackReply(); },
        untrack() { this.untracks++; return Promise.resolve('ok'); },
        presenceState() { return this.wire.state(); },
        status(status, error) {
          this.state = status === 'SUBSCRIBED' ? 'joined' : 'closed';
          this.subscription(status, error);
        },
      };
      channel.wire = presenceWire(payload => {
        for (const binding of callbacks) {
          if (binding.type === 'presence' && binding.filter.event === payload.event) binding.callback(payload);
        }
      });
      channels.push(channel);
      return channel;
    },
    removeChannel(channel) { removed.push(channel); channel.state = 'closed'; return Promise.resolve('ok'); },
    from(table) { rest.push({ type: 'read', table }); throw new Error(`unexpected REST read: ${table}`); },
    rpc(name) { rest.push({ type: 'rpc', name }); throw new Error(`unexpected RPC: ${name}`); },
    realtime: { isConnected: () => true },
    auth: { signOut: async () => { wakeJobs.push('signOut'); } },
  };
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    console, Math, crypto: { randomUUID: () => `fixture-tab-${++keySequence}` },
    navigator: { onLine: true },
    document: { visibilityState: 'visible', addEventListener: addListener },
    window: { addEventListener: addListener },
    me: accounts[0], sb: client, profiles,
    STATUS_META: { online: {}, idle: {}, dnd: {} },
    profileOf: username => profiles.get(username) || { username, custom_status: '' },
    isHiddenBot: username => username === 'hidden-bot',
    $: element, qsa: () => [],
    scheduleRenderMembers: () => context.renderMembers(),
    patchPresenceDots() {}, renderSelf() {},
    setTimeout(callback, ms) {
      const id = ++timerSequence;
      timers.set(id, { callback, at: now + ms, ms });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    setInterval() { throw new Error('presence must not have a periodic application timer'); },
    clearInterval() {},
    currentView: { type: 'channel', id: 'general' },
    snapshotComposer: view => wakeJobs.push(`snapshot:${view.id}`),
    refreshSessionQuiet: async () => { wakeJobs.push('session'); },
    catchUpPoll: async () => { wakeJobs.push('messages'); },
    refreshListsQuiet: async () => { wakeJobs.push('lists'); },
    realtimeHealthy: () => true,
    recoverRealtime: async () => { wakeJobs.push('recover'); },
    updateConnection() {},
    signOutLocked: false, stopChatBackground() {}, leaveVoiceRoom() {},
    LS: { del() {} }, location: { reload: () => wakeJobs.push('reload') },
    esc: value => String(value), displayNameOf: account => account.display_name || account.username,
    avatarHtml: () => '', roleBadgeHtml: () => '', subRoleBadgeHtml: () => '', staffRoleOf: () => 'member',
    statusMeta: status => ({ label: status }),
    memberListClicksBound: false,
    reconcileSidebarRows(groups) { groups.forEach(({list,rows}) => { list.innerHTML = rows.map(row => row.html).join(''); }); },
    memberListSignature: '', memberPresenceSignature: () => '',
    refreshSubroleMemberControls() {}, renderSubroleDialog() {}, showHoverCard() {}, voice: { peers: new Map() }, renderDmList() {}, scheduleRenderDmList() {}, refreshTimelineForAuthor() {},
  });
  vm.runInContext(
    section('    const LIVE_PRESENCE_TOPIC =', '    let memberListSignature =') + '\n' +
    section('    function effectiveMyStatus()', '    function indexMessage(') + '\n' +
    section('    function setupLivePresence(', '    function realtimeHealthy(') + '\n' +
    section('    async function wakeAndSync()', '    function patchPresenceDots(') + '\n' +
    section('    async function signOut()', '    /* ============================= 8. BOOT APP') + '\n' +
    section('    function handleProfileChange(', '    function refreshTimelineForAuthor(') + '\n' +
    section('    function renderMembers()', '    /* ============================= 27. HOVER CARD'),
    context,
  );
  const evaluate = code => vm.runInContext(code, context);
  return {
    context, channels, removed, rest, timers, listeners, wakeJobs, profiles,
    element, evaluate,
    start: () => { context.setupLivePresence(); return channels.at(-1); },
    async join(channel = channels.at(-1), state = null) {
      channel.status('SUBSCRIBED');
      await settle();
      channel.wire.full(state || { [channel.options.config.presence.key]: entry('alice', 'self-ref') });
      await settle();
      return channel;
    },
    async fire(name) {
      for (const callback of listeners.get(name) || []) await callback();
      await settle();
    },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        await next[1].callback();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

test('three connected accounts include self without heartbeat rows or verification reads', async () => {
  const p = chatPresence();
  const channel = p.start();
  await p.join(channel, {
    [channel.options.config.presence.key]: entry('alice', 'alice-ref'),
    'bob-tab': entry('bob', 'bob-ref'),
    'carol-tab': entry('carol', 'carol-ref'),
  });
  for (const account of ['alice', 'bob', 'carol']) assert.equal(p.context.presenceStatusOf(account), 'online');
  assert.equal(p.context.presenceCountReady(), true);
  assert.equal(String(p.element('online-count').textContent), '3');
  assert.equal(p.element('member-count').textContent, '3 online');
  assert.deepEqual(p.rest, []);
});

test('unique tab keys count an account once and only the final tab leave makes it offline', async () => {
  const p = chatPresence();
  const channel = p.start();
  await p.join(channel);
  channel.wire.diff({ joins: { 'bob-tab-1': entry('bob', 'bob-1'), 'bob-tab-2': entry('bob', 'bob-2') }, leaves: {} });
  assert.equal(String(p.element('online-count').textContent), '2');
  channel.wire.diff({ joins: {}, leaves: { 'bob-tab-1': entry('bob', 'bob-1') } });
  assert.equal(p.context.presenceStatusOf('bob'), 'online');
  assert.equal(String(p.element('online-count').textContent), '2');
  channel.wire.diff({ joins: {}, leaves: { 'bob-tab-2': entry('bob', 'bob-2') } });
  assert.equal(p.context.presenceStatusOf('bob'), 'offline');
  assert.equal(String(p.element('online-count').textContent), '1');
  const otherTab = chatPresence();
  const otherChannel = otherTab.start();
  assert.notEqual(channel.options.config.presence.key, otherChannel.options.config.presence.key);
});

test('an initial empty sync remains a connecting count until this tab has a track acknowledgment', async () => {
  const p = chatPresence();
  const channel = p.start();
  const ack = deferred();
  channel.trackReply = () => ack.promise;
  channel.status('SUBSCRIBED');
  channel.wire.full({});
  assert.equal(p.context.presenceCountReady(), false);
  assert.notEqual(String(p.element('online-count').textContent), '0');
  assert.match(p.element('member-count').textContent, /connect|reconnect|sync/i);
  ack.resolve('ok');
  await settle();
  assert.equal(p.context.presenceStatusOf('alice'), 'online', 'acknowledged self does not depend on server echo timing');
  assert.equal(String(p.element('online-count').textContent), '1');
});

test('a full presence sync before SUBSCRIBED is consumed once tracking succeeds', async () => {
  const p = chatPresence();
  const channel = p.start();
  channel.wire.full({ 'early-bob-tab': entry('bob', 'early-bob') });
  assert.equal(p.context.presenceCountReady(), false);
  channel.status('SUBSCRIBED');
  await settle();
  assert.equal(p.context.presenceCountReady(), true);
  assert.equal(p.context.presenceStatusOf('bob'), 'online');
  assert.equal(String(p.element('online-count').textContent), '2');
  assert.equal(channel.tracks.length, 1);
  assert.deepEqual(p.rest, []);
});

test('a profile received after its presence join becomes online without needing another join', async () => {
  const p = chatPresence();
  const channel = p.start();
  await p.join(channel, {
    [channel.options.config.presence.key]: entry('alice', 'self'),
    'new-dave-tab': entry('dave', 'dave'),
  });
  assert.equal(p.context.presenceStatusOf('dave'), 'offline');
  p.context.handleProfileChange({
    eventType: 'INSERT', new: { username: 'dave', status: 'idle', display_name: 'Dave', custom_status: 'Just arrived' },
  });
  assert.equal(p.context.presenceStatusOf('dave'), 'idle');
  assert.equal(p.context.presenceCustomStatusOf('dave'), 'Just arrived');
  assert.equal(String(p.element('online-count').textContent), '2');
  p.context.handleProfileChange({ eventType: 'UPDATE', new: { username: 'dave', is_banned: true } });
  assert.equal(p.context.presenceStatusOf('dave'), 'offline');
  assert.equal(String(p.element('online-count').textContent), '1');
  assert.equal(channel.tracks.length, 1);
  assert.deepEqual(p.rest, []);
});

test('presence ignores unknown, banned and hidden identities while accepting known older clients', async () => {
  const p = chatPresence();
  p.profiles.get('carol').is_banned = true;
  const channel = p.start();
  await p.join(channel, {
    [channel.options.config.presence.key]: entry('alice', 'self'),
    bob: { metas: [{ phx_ref: 'legacy-client', online_at: '1900-01-01T00:00:00Z' }] },
    'unknown-tab': entry('unknown', 'unknown'),
    'banned-tab': entry('carol', 'carol'),
    'bot-tab': entry('hidden-bot', 'bot'),
  });
  assert.equal(p.context.presenceStatusOf('bob'), 'online');
  for (const username of ['unknown', 'carol', 'hidden-bot']) assert.equal(p.context.presenceStatusOf(username), 'offline');
  assert.equal(String(p.element('online-count').textContent), '2');
});

test('SDK state and diff processing preserves refs through updates, reconnects and leaves', () => {
  const wire = presenceWire();
  wire.full({ tab: entry('bob', 'original', { status: 'online' }) });
  wire.diff({
    joins: { tab: entry('bob', 'updated', { phx_ref_prev: 'original', status: 'idle' }) },
    leaves: { tab: entry('bob', 'original') },
  });
  assert.deepEqual(Array.from(wire.state().tab, meta => meta.presence_ref), ['updated']);
  wire.rejoin();
  wire.full({ tab: entry('bob', 'reconnected') });
  assert.deepEqual(Array.from(wire.state().tab, meta => meta.presence_ref), ['reconnected']);
  wire.diff({ joins: {}, leaves: { tab: entry('bob', 'reconnected') } });
  assert.deepEqual(Object.keys(wire.state()), []);
});

for (const result of ['error', 'timed out']) {
  test(`a resolved track ${result} is a failure and retries through a fresh channel`, async () => {
    const p = chatPresence();
    const first = p.start();
    first.trackReply = async () => result;
    first.status('SUBSCRIBED');
    first.wire.full({ [first.options.config.presence.key]: entry('alice', 'unacknowledged') });
    await settle();
    assert.equal(p.context.presenceCountReady(), false);
    assert.equal(p.context.presenceStatusOf('alice'), 'offline');
    assert.match(p.element('member-count').textContent, /unavailable/i);
    assert.deepEqual(p.removed, [first]);
    assert.equal(p.timers.size, 1);
    await p.advance(1000);
    const second = p.channels.at(-1);
    assert.notEqual(second, first);
    assert.notEqual(second.options.config.presence.key, first.options.config.presence.key);
    await p.join(second);
    assert.equal(p.context.presenceCountReady(), true);
    assert.equal(p.context.presenceStatusOf('alice'), 'online');
    assert.equal(p.evaluate('presenceRetryAttempt'), 0);
    assert.deepEqual(p.rest, []);
  });
}

test('rejected tracks and unavailable joins stop after four bounded retries', async () => {
  const p = chatPresence();
  p.start();
  const delays = [1000, 3000, 10000, 30000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const channel = p.channels.at(-1);
    if (attempt === 0) {
      channel.trackReply = async () => { throw new Error('network unavailable'); };
      channel.status('SUBSCRIBED');
    } else channel.status('CHANNEL_ERROR', new Error('join unavailable'));
    await settle();
    if (attempt === delays.length) break;
    assert.equal(p.timers.size, 1);
    assert.equal([...p.timers.values()][0].ms, delays[attempt]);
    await p.advance(delays[attempt]);
  }
  assert.equal(p.channels.length, 5, 'initial connection plus four retries');
  assert.equal(p.timers.size, 1, 'exhausted live retries hand the roster to the slow fallback');
  assert.equal([...p.timers.values()][0].ms, 30000);
  assert.ok(p.rest.some(call => call.table === 'user_presence'));
  p.context.ensureLivePresence();
  assert.equal(p.channels.length, 5, 'repeated focus/wake cannot restart exhausted retries immediately');
  await p.advance(60_000);
  assert.equal(p.channels.length, 5, 'there is no permanent live-presence retry interval');
  p.context.ensureLivePresence();
  assert.equal(p.channels.length, 6, 'a later user wake can retry after the cooldown');
  assert.ok(p.rest.every(call => call.table === 'user_presence'));
});

test('overlapping track calls share one request while the ack is pending', async () => {
  const p = chatPresence();
  const channel = p.start(), ack = deferred();
  channel.trackReply = () => ack.promise;
  channel.status('SUBSCRIBED');
  const first = p.context.trackLivePresence(), second = p.context.trackLivePresence();
  assert.equal(first, second);
  assert.equal(channel.tracks.length, 1);
  ack.resolve('ok');
  await first;
  await p.context.trackLivePresence();
  assert.equal(channel.tracks.length, 1, 'an acknowledged tab does not re-track on wake');
});

test('late track acks and sync events from a retired generation cannot overwrite a new connection', async () => {
  const p = chatPresence();
  const old = p.start(), oldAck = deferred();
  old.trackReply = () => oldAck.promise;
  old.status('SUBSCRIBED');
  p.evaluate('realtimeGen++');
  p.context.stopLivePresence();
  const fresh = p.start(), freshAck = deferred();
  fresh.trackReply = () => freshAck.promise;
  fresh.status('SUBSCRIBED');
  oldAck.resolve('ok');
  old.wire.full({ 'ghost-carol': entry('carol', 'old') });
  await settle();
  assert.equal(p.context.presenceCountReady(), false);
  assert.equal(p.context.presenceStatusOf('alice'), 'offline');
  assert.equal(p.context.presenceStatusOf('carol'), 'offline');
  assert.equal(p.evaluate('livePresenceTracked'), false);
  freshAck.resolve('ok');
  fresh.wire.full({ [fresh.options.config.presence.key]: entry('alice', 'fresh') });
  await settle();
  assert.equal(p.context.presenceCountReady(), true);
  assert.equal(String(p.element('online-count').textContent), '1');
});

test('automatic rejoin invalidates the old track epoch and retains the new pending request', async () => {
  const p = chatPresence();
  const channel = p.start(), firstAck = deferred(), secondAck = deferred();
  let attempts = 0;
  channel.trackReply = () => (++attempts === 1 ? firstAck.promise : secondAck.promise);
  channel.status('SUBSCRIBED');
  const first = p.context.trackLivePresence();
  channel.wire.rejoin();
  channel.status('SUBSCRIBED');
  const second = p.context.trackLivePresence();
  assert.notEqual(first, second);
  assert.equal(channel.tracks.length, 2);
  firstAck.resolve('error');
  await first;
  assert.equal(p.evaluate('livePresenceTracked'), false);
  assert.equal(p.context.trackLivePresence(), second, 'stale finally must not unlock the new track');
  assert.equal(p.removed.length, 0, 'stale failure cannot retire the new epoch');
  secondAck.resolve('ok');
  await second;
  channel.wire.full({ [channel.options.config.presence.key]: entry('alice', 'new-epoch') });
  assert.equal(p.context.presenceCountReady(), true);
});

test('a disconnected roster is cleared immediately and only a fresh sync restores counts', async () => {
  const p = chatPresence();
  const old = p.start();
  await p.join(old, {
    [old.options.config.presence.key]: entry('alice', 'self'),
    'bob-tab': entry('bob', 'bob'), 'carol-tab': entry('carol', 'carol'),
  });
  old.status('TIMED_OUT');
  assert.equal(p.context.presenceCountReady(), false);
  for (const name of ['alice', 'bob', 'carol']) assert.equal(p.context.presenceStatusOf(name), 'offline');
  assert.notEqual(String(p.element('online-count').textContent), '0');
  await p.advance(1000);
  const fresh = p.channels.at(-1);
  await p.join(fresh, {
    [fresh.options.config.presence.key]: entry('alice', 'new-self'),
    'bob-new-tab': entry('bob', 'new-bob'),
  });
  old.wire.diff({ joins: { 'ghost-carol': entry('carol', 'ghost') }, leaves: {} });
  assert.equal(String(p.element('online-count').textContent), '2');
  assert.equal(p.context.presenceStatusOf('carol'), 'offline');
});

test('pagehide and logout clean up this tab without removing another tab for the same account', async () => {
  for (const action of ['pagehide', 'logout']) {
    const p = chatPresence(), other = chatPresence();
    const channel = p.start(), otherChannel = other.start();
    await p.join(channel);
    await other.join(otherChannel);
    p.context.wirePresenceLifecycle();
    if (action === 'pagehide') await p.fire('pagehide');
    else await p.context.signOut();
    assert.equal(channel.untracks, 1);
    assert.deepEqual(p.removed, [channel]);
    assert.equal(p.context.presenceStatusOf('alice'), 'offline');
    assert.equal(otherChannel.untracks, 0);
    assert.equal(other.removed.length, 0);
    assert.equal(other.context.presenceStatusOf('alice'), 'online');
    assert.deepEqual(p.rest, []);
    if (action === 'pagehide') {
      await p.fire('pageshow');
      const resumed = p.channels.at(-1);
      assert.notEqual(resumed, channel);
      await p.join(resumed);
      assert.equal(p.context.presenceStatusOf('alice'), 'online');
    } else {
      await p.fire('focus');
      assert.equal(p.channels.length, 1, 'logout stops every future wake');
    }
  }
});

test('pagehide during a pending track invalidates its ack and remains stopped until pageshow', async () => {
  const p = chatPresence(), ack = deferred();
  const channel = p.start();
  channel.trackReply = () => ack.promise;
  channel.status('SUBSCRIBED');
  p.context.onPageHidePresence();
  ack.resolve('ok');
  await settle();
  assert.equal(p.evaluate('livePresenceTracked'), false);
  assert.equal(p.context.presenceCountReady(), false);
  assert.equal(channel.untracks, 1);
  await p.advance(120_000);
  assert.equal(p.channels.length, 1);
  p.context.onPageShowPresence();
  await settle();
  assert.equal(p.channels.length, 2);
});

test('hidden connected tabs stay online; offline and resume restore a fresh presence session', async () => {
  const p = chatPresence();
  const channel = p.start();
  await p.join(channel);
  p.context.wirePresenceLifecycle();
  p.context.document.visibilityState = 'hidden';
  await p.fire('visibilitychange');
  assert.equal(p.context.presenceStatusOf('alice'), 'online');
  assert.equal(channel.untracks, 0);
  p.context.navigator.onLine = false;
  await p.fire('offline');
  assert.equal(p.context.presenceCountReady(), false);
  assert.equal(p.context.presenceStatusOf('alice'), 'offline');
  p.context.navigator.onLine = true;
  p.context.document.visibilityState = 'visible';
  await p.fire('online');
  const fresh = p.channels.at(-1);
  assert.notEqual(fresh, channel);
  await p.join(fresh);
  assert.equal(p.context.presenceCountReady(), true);
});

test('idle, waking and status changes produce no presence HTTP traffic or repeated tracks', async () => {
  const p = chatPresence();
  const channel = p.start();
  await p.join(channel, {
    [channel.options.config.presence.key]: entry('alice', 'self'),
    'bob-tab': entry('bob', 'bob'),
  });
  p.context.wirePresenceLifecycle();
  await p.advance(24 * 60 * 60 * 1000);
  for (const event of ['focus', 'pageshow', 'visibilitychange', 'resume', 'online']) {
    await p.fire(event);
    await p.advance(5000);
  }
  p.context.me.status = 'dnd';
  p.context.me.custom_status = 'Quiet please';
  p.profiles.get('bob').status = 'idle';
  p.context.refreshPresenceUi();
  assert.equal(p.context.presenceStatusOf('alice'), 'dnd');
  assert.equal(p.context.presenceStatusOf('bob'), 'idle');
  assert.equal(p.context.presenceCustomStatusOf('alice'), 'Quiet please');
  assert.equal(String(p.element('online-count').textContent), '2', 'online connections do not expire by wall-clock age');
  assert.equal(channel.tracks.length, 1);
  assert.equal(p.channels.length, 1);
  assert.equal(p.timers.size, 0);
  assert.deepEqual(p.rest, []);
  assert(p.wakeJobs.includes('messages'), 'actual wakeAndSync still reconciles messages');
  assert.doesNotMatch(section('    function setupRealtime()', '    function setupLivePresence('), /setInterval/);
  assert.doesNotMatch(chat.slice(chat.indexOf('    const LIVE_PRESENCE_TOPIC =')), /chat_presence_pulse/);
  assert.equal(p.rest.length, 0, 'a healthy presence socket does not touch user_presence');
});
