import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
function section(start, end) {
  const from = chat.indexOf(start), to = chat.indexOf(end, from);
  assert(from >= 0 && to > from, start);
  return chat.slice(from, to);
}

function rings(supported = true) {
  class Node {
    constructor(classes = [], children = []) {
      this.nodeType = 1; this.classes = new Set(classes); this.children = children;
      this.classList = { contains: name => this.classes.has(name) };
      this.dataset = {}; this.isConnected = true;
    }
    matches(selector) { return selector.split(',').some(part => {
      const needsImage = part.includes(':has(img)');
      return (!needsImage || this.children.some(child => child.classes.has('img')))
        && part.trim().replace(':has(img)', '').split('.').filter(Boolean).every(name => this.classes.has(name));
    }); }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]).filter(child => child.matches(selector));
    }
  }
  const visible = new Node(['avatar', 'ring-anim']), hidden = new Node(['avatar', 'ring-anim']);
  const ordinary = new Node(['avatar']), body = new Node([], [visible, hidden, ordinary]);
  const attributes = new Set(), listeners = new Map(), intersections = [], mutations = [];
  const root = { setAttribute: name => attributes.add(name), removeAttribute: name => attributes.delete(name),
    toggleAttribute(name, value) { if (value) attributes.add(name); else attributes.delete(name); } };
  const document = { documentElement: root, body, hidden: false,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  class Intersections {
    constructor(callback) { this.callback = callback; this.targets = new Set(); intersections.push(this); }
    observe(el) { this.targets.add(el); } unobserve(el) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); this.disconnected = true; }
  }
  class Mutations {
    constructor(callback) { this.callback = callback; mutations.push(this); }
    observe() {} disconnect() { this.disconnected = true; }
  }
  const context = vm.createContext({ document, IntersectionObserver: supported ? Intersections : undefined, MutationObserver: Mutations });
  vm.runInContext(section('    let ringVisibilityController =', '    function effectiveMyStatus('), context);
  const controller = context.initRingVisibility();
  return { Node, context, controller, document, visible, hidden, ordinary, attributes, listeners, intersections, mutations,
    intersect: entries => intersections[0].callback(entries.map(([target, active]) => ({ target, isIntersecting: active, intersectionRatio: active ? 1 : 0 }))),
    change: records => mutations[0].callback(records) };
}

test('only intersecting avatar rings animate; hidden tabs pause the entire set', () => {
  const r = rings();
  assert.equal(r.intersections[0].targets.size, 3);
  assert.equal(r.visible.dataset.ringVisible, undefined, 'new rings stay paused until visibility is known');
  r.intersect([[r.visible, true], [r.hidden, false]]);
  assert.equal(r.visible.dataset.ringVisible, 'true');
  assert.equal(r.hidden.dataset.ringVisible, 'false');
  r.document.hidden = true; r.listeners.get('visibilitychange')();
  assert(r.attributes.has('data-ring-paused'));
  r.document.hidden = false; r.listeners.get('visibilitychange')();
  assert(!r.attributes.has('data-ring-paused'));
  r.intersect([[r.visible, false], [r.hidden, true]]);
  assert.equal(r.visible.dataset.ringVisible, 'false');
  assert.equal(r.hidden.dataset.ringVisible, 'true');
});

test('ring visibility follows inserted, moved, edited and removed avatars without retaining detached nodes', () => {
  const r = rings(), observer = r.intersections[0];
  const added = new r.Node(['avatar', 'ring-anim']);
  r.change([{ type: 'childList', addedNodes: [added], removedNodes: [] }]);
  assert(observer.targets.has(added));
  r.intersect([[added, true]]);
  r.change([{ type: 'childList', addedNodes: [added], removedNodes: [added] }]);
  assert.equal(added.dataset.ringVisible, 'true', 'moving a connected avatar preserves its animation state');
  added.classes.clear();
  r.change([{ type: 'attributes', target: added }]);
  assert(!observer.targets.has(added));
  r.ordinary.classes.add('ring-anim');
  r.change([{ type: 'attributes', target: r.ordinary }]);
  assert(observer.targets.has(r.ordinary));
  r.hidden.isConnected = false;
  r.change([{ type: 'childList', addedNodes: [], removedNodes: [r.hidden] }]);
  assert(!observer.targets.has(r.hidden));
  r.intersect([[r.hidden, true]]);
  assert.equal(r.hidden.dataset.ringVisible, undefined, 'late intersection entries cannot revive detached nodes');
});

test('ring tracking initializes once, releases observers, and preserves the fallback on unsupported browsers', () => {
  const r = rings();
  assert.equal(r.context.initRingVisibility(), r.controller);
  assert.equal(r.intersections.length, 1);
  r.intersect([[r.visible, true]]); r.controller.destroy();
  assert.equal(r.intersections[0].targets.size, 0);
  assert(r.intersections[0].disconnected && r.mutations[0].disconnected);
  assert.equal(r.attributes.size, 0);
  assert.equal(r.listeners.size, 0);
  assert.equal(r.visible.dataset.ringVisible, undefined);
  const fallback = rings(false);
  assert.equal(fallback.controller, null);
  assert.equal(fallback.attributes.size, 0);
});

test('ordinary avatar images and message media pause offscreen and release detached tracking', () => {
  const r = rings(), observer = r.intersections[0];
  const avatar = new r.Node(['avatar'], [new r.Node(['img'])]);
  const message = new r.Node(['msg']);
  r.change([{ type: 'childList', addedNodes: [avatar, message], removedNodes: [] }]);
  assert(observer.targets.has(avatar) && observer.targets.has(message));
  r.intersect([[avatar, false], [message, true]]);
  assert.equal(avatar.dataset.mediaVisible, 'false');
  assert.equal(message.dataset.mediaVisible, 'true');
  r.intersect([[avatar, true], [message, false]]);
  assert.equal(avatar.dataset.mediaVisible, 'true');
  assert.equal(message.dataset.mediaVisible, 'false');
  avatar.isConnected = false; message.isConnected = false;
  r.change([{ type: 'childList', addedNodes: [], removedNodes: [avatar, message] }]);
  assert(!observer.targets.has(avatar) && !observer.targets.has(message));
  assert.equal(avatar.dataset.mediaVisible, undefined);
});

test('adding an image to an existing plain avatar starts visibility tracking', () => {
  const r = rings();
  r.ordinary.children.push(new r.Node(['img']));
  r.change([{ type: 'childList', target: r.ordinary, addedNodes: r.ordinary.children, removedNodes: [] }]);
  assert(r.intersections[0].targets.has(r.ordinary));
});

function profileChanges() {
  let sequence = 0;
  const frames = new Map(), calls = {}, elements = new Map(), timeouts = [];
  const count = name => { calls[name] = (calls[name] || 0) + 1; };
  const rows = Array.from({ length: 80 }, (_, i) => ({ username: `user${i}`, display_name: `User ${i}`,
    staff_role: 'member', status: 'online', last_seen: '2026-10-18T03:00:00Z', sub_role: '' }));
  const context = vm.createContext({
    profiles: new Map(rows.map(row => [row.username, row])), me: rows[0], document: { visibilityState: 'visible' },
    currentView: { type: 'channel', id: 'general' }, bootedAt: '2026-10-18T02:00:00Z',
    voice: { peers: new Map() }, STAFF_ROLE_META: { member: { rank: 1 }, owner: { rank: 3 } },
    isHiddenBot: () => false, staffRoleOf: p => p.staff_role || 'member',
    noelleSourceProfile: null, NOELLE_AI_USERNAME: 'NoelleAI', hoverCardUser: null,
    isOwner: () => ['owner', 'preston'].includes(context.me?.staff_role), loadNoelleProfile() {},
    $: id => { if (!elements.has(id)) elements.set(id, { open: false, textContent: '' }); return elements.get(id); },
    requestAnimationFrame(fn) { const id = ++sequence; frames.set(id, fn); return id; },
    renderDmList: () => count('dms'), renderMembers: () => count('members'), renderSelf: () => count('self'),
    applyFeatureControls: () => count('controls'), updateTimeoutUi: () => count('timeout'), updateAdminUi: () => count('admin'),
    updateVoiceUi: () => count('voice'), refreshPresenceUi() {}, updatePeerTileIdentity() {},
    refreshTimelineForAuthor: name => { count('timeline'); calls.author = name; },
    refreshSubroleMemberControls() {}, renderSubroleDialog() {},
    showBanned: () => count('banned'), toast: () => count('toast'), signOut: () => count('signout'),
    notifyRolePromotion: () => count('promotion'),
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); },
    displayNameOf: p => p.display_name, dmTopicText: p => p.custom_status || '',
  });
  vm.runInContext(section('    let memberRenderFrame =', '    function handleMessageChange(') + '\n' +
    section('    function handleProfileChange(', '    function refreshTimelineForAuthor('), context);
  return { context, rows, frames, calls, elements, timeouts,
    flush() { const jobs = [...frames.values()]; frames.clear(); jobs.forEach(fn => fn()); } };
}

test('unchanged and last-seen-only profile batches retain data without scheduling UI work', () => {
  const p = profileChanges();
  for (const row of p.rows) p.context.handleProfileChange({ new: { ...row } });
  for (const row of p.rows) p.context.handleProfileChange({ new: { ...row, last_seen: '2026-10-18T03:01:00Z' } });
  assert.equal(p.frames.size, 0);
  assert.deepEqual(p.calls, {});
  assert.equal(p.context.profiles.get('user79').last_seen, '2026-10-18T03:01:00Z');
  assert.equal(p.context.me.last_seen, '2026-10-18T03:01:00Z');
});

test('a burst of real profile changes schedules one member render and one DM render', () => {
  const p = profileChanges();
  for (const row of p.rows) p.context.handleProfileChange({ new: { ...row, status: 'away' } });
  assert.equal(p.frames.size, 2);
  assert.equal(p.calls.dms, undefined);
  p.flush();
  assert.equal(p.calls.dms, 1);
  assert.equal(p.calls.members, 1);
  assert.equal(p.calls.timeline, undefined, 'presence updates do not rebuild message media');
  assert.equal(p.context.profiles.get('user79').status, 'away');
});

test('identity edits refresh their author and current DM heading while list updates stay batched', () => {
  const p = profileChanges();
  p.context.currentView = { type: 'dm', id: 'dm1', other: 'user1' };
  p.context.handleProfileChange({ new: { username: 'user1', display_name: 'Renamed', custom_status: 'New status' } });
  assert.equal(p.calls.timeline, 1);
  assert.equal(p.calls.author, 'user1');
  assert.equal(p.elements.get('channel-title').textContent, 'Renamed');
  assert.equal(p.elements.get('channel-topic').textContent, 'New status');
  p.flush(); assert.equal(p.calls.dms, 1);
});

test('profile detail and metadata changes do not rebuild timeline media', () => {
  const p = profileChanges();
  p.context.handleProfileChange({ new: { username: 'user1', bio: 'Changed', banner: 'https://example.test/banner.gif', last_seen: 'later', created_at: 'new metadata' } });
  assert.equal(p.calls.timeline, undefined);
});

test('ban, kick and promotion handling remains immediate', () => {
  const banned = profileChanges();
  banned.context.handleProfileChange({ new: { username: 'user0', is_banned: true } });
  banned.context.handleProfileChange({ new: { username: 'user0', is_banned: true } });
  assert.equal(banned.calls.banned, 2);
  assert.equal(banned.frames.size, 0);
  const kicked = profileChanges();
  kicked.context.handleProfileChange({ new: { username: 'user0', kicked_at: '2026-10-18T03:00:00Z' } });
  assert.equal(kicked.calls.toast, 1);
  assert.equal(kicked.timeouts[0].ms, 1500);
  const promoted = profileChanges();
  promoted.context.handleProfileChange({ new: { username: 'user0', staff_role: 'owner' } });
  assert.equal(promoted.calls.promotion, 1);
  assert.equal(promoted.context.me.staff_role, 'owner');
});
