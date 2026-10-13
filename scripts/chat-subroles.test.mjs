import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
const start = chat.indexOf('    // Cosmetic only. Never read these for permissions.');
const end = chat.indexOf('    function dmTopicText(', start);
const optionsStart = chat.indexOf('    function subRoleOptionsHtml(');
const optionsEnd = chat.indexOf('    function subRoleRowsHtml(', optionsStart);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function subroles() {
  const elements = new Map(), calls = [], badges = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'subrole-color' ? '#a78bfa' : '', open: false, hidden: false, disabled: false,
      textContent: '', innerHTML: '', dataset: {}, style: { setProperty() {}, removeProperty() {} },
      setAttribute(key, value) { this[key] = value; },
      setCustomValidity(value) { this.validationMessage = value; }, reportValidity() {}, focus() {},
      showModal() { this.open = true; }, close() { this.open = false; },
    });
    return elements.get(id);
  };
  const me = { username: 'connor', display_name: 'Connor', sub_role: '', staff_role: 'member' };
  const context = vm.createContext({
    console, me, profiles: new Map([[me.username, me]]),
    myStaffRank: () => context.rank, rank: 1,
    profileOf: username => context.profiles.get(username) || {},
    displayNameOf: profile => profile.display_name || profile.username,
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    ROLE_CHECK_SVG: '<svg></svg>', roleBadgeHtml: () => '',
    $: element, qsa: selector => selector === '[data-subrole-badge]' ? badges : [],
    hoverCardUser: null, document: { activeElement: null }, currentView: { type: 'channel', id: 'general' },
    renderSelf() { calls.push('self'); }, renderMembers() { calls.push('members'); }, renderDmList() { calls.push('dms'); },
    refreshTimelineForAuthor: username => calls.push(['author', username]),
    toast: toast => calls.push(['toast', toast]), confirmAction: action => { context.confirmation = action; },
    catalogReply: async () => ({ data: [{ slug: 'artist', label: 'Artist', color: '#f472b6', position: 1 }] }),
    rpcReply: async () => ({ data: true }),
    sb: {
      from(table) { calls.push(['read', table]); return { select() { return this; }, order() { return context.catalogReply(); } }; },
      rpc(name, args) { calls.push(['rpc', name, args]); return context.rpcReply(name, args); },
    },
  });
  vm.runInContext(chat.slice(start, end) + '\n' + chat.slice(optionsStart, optionsEnd), context);
  return { context, element, calls, badges, run: code => vm.runInContext(code, context) };
}

test('empty authoritative catalogs do not resurrect fallback roles in staff controls', () => {
  const p = subroles();
  assert.match(p.context.subRoleOptionsHtml(''), /Developer/);
  p.context.applySubroleCatalog([]);
  assert.doesNotMatch(p.context.subRoleOptionsHtml(''), /Developer|Artist/);
  p.context.renderSubroleDialog();
  assert.match(p.element('subrole-picker').innerHTML, /No subrole/);
});

test('catalog loads share one request and show recoverable failures without losing cached badges', async () => {
  const p = subroles(), wait = deferred();
  p.context.catalogReply = () => wait.promise;
  const first = p.context.loadSubroles(), second = p.context.loadSubroles();
  await Promise.resolve();
  assert.equal(p.calls.filter(c => c[0] === 'read').length, 1);
  wait.resolve({ data: [{ slug: 'artist', label: 'Artist', color: '#f472b6' }] });
  assert.equal(await first, true);
  assert.equal(await second, true);
  p.element('subrole-dialog').open = true;
  p.context.catalogReply = async () => { throw new Error('offline'); };
  assert.equal(await p.context.loadSubroles(), false);
  assert.equal(p.context.subRoleMeta('artist').label, 'Artist');
  assert.equal(p.element('subrole-retry').hidden, false);
  assert.match(p.element('subrole-status-text').textContent, /last loaded list/);
  p.context.catalogReply = async () => ({ data: [] });
  assert.equal(await p.context.loadSubroles(), true);
  assert.equal(p.element('subrole-retry').hidden, true);
});

test('search matches badge names and escapes custom labels', () => {
  const p = subroles();
  p.context.applySubroleCatalog([{ slug: 'artist', label: 'Artist', color: '#f472b6' }, { slug: 'custom', label: '<Custom>', color: '#123456' }]);
  p.element('subrole-search').value = 'CuSt';
  p.context.renderSubroleDialog();
  assert.match(p.element('subrole-picker').innerHTML, /&lt;Custom>/);
  assert.doesNotMatch(p.element('subrole-picker').innerHTML, /data-pick-subrole="artist"/);
  p.element('subrole-search').value = 'missing';
  p.context.renderSubroleDialog();
  assert.match(p.element('subrole-picker').innerHTML, /No matching subroles/);
});

test('choosing a badge is serialized, remains open, and clearing uses the same RPC', async () => {
  const p = subroles(), wait = deferred();
  await p.context.loadSubroles();
  p.element('subrole-dialog').open = true;
  p.context.rpcReply = () => wait.promise;
  const first = p.context.setOwnSubrole('artist');
  await p.context.setOwnSubrole('artist');
  assert.equal(p.calls.filter(c => c[0] === 'rpc').length, 1);
  assert.equal(p.context.me.sub_role, '');
  wait.resolve({ data: true });
  await first;
  assert.equal(p.context.me.sub_role, 'artist');
  assert.equal(p.element('subrole-dialog').open, true);
  await p.context.setOwnSubrole('artist');
  assert.equal(p.element('subrole-dialog').open, true, 'clicking the selected badge does not dismiss the picker');
  await p.context.setOwnSubrole('');
  assert.equal(p.context.me.sub_role, '');
  assert.equal(p.calls.filter(c => c[0] === 'rpc').at(-1)[2].p_sub_role, '');
});

test('failed saves preserve the current badge and release the busy state', async () => {
  const p = subroles();
  await p.context.loadSubroles();
  p.context.rpcReply = async () => { throw new Error('offline'); };
  await p.context.setOwnSubrole('artist');
  assert.equal(p.context.me.sub_role, '');
  assert.equal(p.run('subroleBusy'), false);
  assert.equal(p.element('subrole-status').dataset.error, 'true');
  p.context.rpcReply = async () => ({ data: true });
  await p.context.setOwnSubrole('artist');
  assert.equal(p.context.me.sub_role, 'artist');
});

test('catalog edits update existing badges in place and remove deleted badges', async () => {
  const p = subroles();
  let removed = false, color;
  p.badges.push({ dataset: { subroleBadge: 'artist' }, style: { setProperty: (key, value) => { if (key === '--subrole') color = value; } }, remove: () => { removed = true; } });
  p.context.catalogReply = async () => ({ data: [{ slug: 'artist', label: 'Renamed', color: '#abcdef' }] });
  await p.context.loadSubroles();
  assert.equal(p.badges[0].textContent, 'Renamed');
  assert.equal(color, '#abcdef');
  p.context.catalogReply = async () => ({ data: [] });
  await p.context.loadSubroles();
  assert.equal(removed, true);
});

test('catalog editing validates whitespace, respects staff rank, and keeps drafts after failures', async () => {
  const p = subroles();
  await p.context.loadSubroles();
  const event = { preventDefault() {} };
  p.element('subrole-name').value = 'Name';
  await p.context.saveSubroleFromForm(event);
  assert.equal(p.calls.filter(c => c[0] === 'rpc').length, 0);
  p.context.rank = 5;
  p.element('subrole-name').value = '   ';
  await p.context.saveSubroleFromForm(event);
  assert.equal(p.calls.filter(c => c[0] === 'rpc').length, 0);
  assert.match(p.element('subrole-name').validationMessage, /1 to 24/);
  p.element('subrole-name').value = 'Draft';
  p.context.rpcReply = async () => ({ error: { message: 'Could not save' } });
  await p.context.saveSubroleFromForm(event);
  assert.equal(p.element('subrole-name').value, 'Draft');
  assert.equal(p.run('subroleBusy'), false);
});

test('deletion clears cached assignments and active editor after confirmation', async () => {
  const p = subroles();
  await p.context.loadSubroles();
  p.context.rank = 5;
  p.context.me.sub_role = 'artist';
  p.context.profiles.set('bob', { username: 'bob', sub_role: 'artist' });
  p.context.beginSubroleEdit('artist');
  p.context.deleteSubrole('artist');
  assert.equal(p.context.me.sub_role, 'artist', 'confirmation does not write');
  p.context.catalogReply = async () => ({ data: [] });
  await p.context.confirmation.onConfirm();
  assert.equal(p.context.me.sub_role, '');
  assert.equal(p.context.profiles.get('bob').sub_role, '');
  assert.equal(p.element('subrole-edit-slug').value, '');
  assert.equal(p.context.subRoleMeta('artist'), null);
});

test('an event arriving during a catalog read requests a fresh snapshot afterward', async () => {
  const p = subroles(), wait = deferred();
  p.context.catalogReply = () => wait.promise;
  const initial = p.context.loadSubroles();
  await Promise.resolve();
  const event = p.context.reloadSubroleCatalog();
  p.context.catalogReply = async () => ({ data: [{ slug: 'artist', label: 'New name', color: '#abcdef' }] });
  wait.resolve({ data: [{ slug: 'artist', label: 'Old name', color: '#abcdef' }] });
  await initial;
  await event;
  assert.equal(p.calls.filter(c => c[0] === 'read').length, 2);
  assert.equal(p.context.subRoleMeta('artist').label, 'New name');
});

test('confirmed catalog edits stay visible even when the following refresh fails', async () => {
  const p = subroles();
  await p.context.loadSubroles();
  p.context.rank = 5;
  p.context.beginSubroleEdit('artist');
  p.element('subrole-name').value = 'Digital Artist';
  p.element('subrole-color').value = '#123456';
  p.context.rpcReply = async () => ({ data: 'artist' });
  p.context.catalogReply = async () => ({ error: { message: 'offline' } });
  await p.context.saveSubroleFromForm({ preventDefault() {} });
  assert.equal(p.context.subRoleMeta('artist').label, 'Digital Artist');
  assert.equal(p.context.subRoleMeta('artist').color, '#123456');
  assert.equal(p.element('subrole-name').value, '');
});

test('extreme custom badge colors gain readable text without changing the chosen tint', () => {
  const p = subroles();
  assert.notEqual(p.context.subroleTextColor('#000000'), '#000000');
  assert.notEqual(p.context.subroleTextColor('#ffffff', true), '#ffffff');
  assert.match(p.context.subroleStyle('#000000'), /^--subrole:#000000;/);
  assert.doesNotMatch(p.context.subroleStyle('red; background:url(x)'), /url\(/);
});
