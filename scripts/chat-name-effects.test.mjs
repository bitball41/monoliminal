import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = chat.indexOf(start), to = chat.indexOf(end, from);
  assert(from >= 0 && to > from, start);
  return chat.slice(from, to);
};
const css = [...chat.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

function element(effect, speed = '6s', attrs = { 'data-media-visible': 'true' }) {
  const props = new Map([['--name-speed', speed]]), writes = [];
  return { effect, writes, classList: { contains: name => name === `name-effect-${effect}` || name === 'display-name' },
    getAttribute: key => attrs[key] ?? null, hasAttribute: key => key in attrs,
    style: { getPropertyValue: key => props.get(key) || '', setProperty(key, value) { props.set(key, value); writes.push([key, value]); } } };
}
function clock({ hidden = false, reduced = false, controller = true } = {}) {
  const listeners = {}, timers = new Set(), lists = { fade: [], shift: [] }, rootAttrs = new Set();
  const c = vm.createContext({
    ringVisibilityController: controller ? {} : null, performance: { now: () => 0 },
    document: { hidden, addEventListener: (type, fn) => { listeners[type] = fn; },
      documentElement: { hasAttribute: name => rootAttrs.has(name) },
      getElementsByClassName: name => name === 'name-effect-fade' ? lists.fade : lists.shift },
    matchMedia: () => ({ matches: reduced, addEventListener: (type, fn) => { listeners.motion = fn; } }),
    setTimeout: (fn, ms) => { const id = { fn, ms }; timers.add(id); return id; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(section('    const NAME_EFFECT_TICK_MS', '    function effectiveMyStatus()'), c);
  // Live collections: update them in place, as the browser would.
  const setNames = names => { for (const key of ['fade', 'shift']) lists[key].splice(0, Infinity, ...names.filter(n => n.effect === key)); };
  return { c, listeners, timers, setNames, rootAttrs };
}

test('Fade and Shift names are not CSS animations that restyle the page every frame', () => {
  assert.doesNotMatch(css, /@keyframes name-/);
  for (const rule of css.split('}').filter(rule => /\.name-effect-(fade|shift)\b/.test(rule.split('{')[0]))) {
    assert.doesNotMatch(rule, /animation\s*:/, rule);
  }
  assert.match(css, /\.name-effect-fade\s*\{\s*color:\s*color-mix\(in srgb, var\(--name-to\) var\(--name-mix, 0%\), var\(--name-from\)\);/);
  assert.match(css, /\.name-effect-shift\s*\{\s*background-position:\s*var\(--name-pos, 0%\) 0;/);
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\.display-name\s*\{\s*--name-mix:\s*0% !important;\s*--name-pos:\s*0% !important;/);
});

test('one shared clock moves visible names in phase and skips unchanged values', () => {
  const { c, setNames } = clock();
  const shift = element('shift', '6s'), slow = element('shift', '10s'), fade = element('fade', '6s');
  setNames([shift, slow, fade]);
  c.tickNameEffects(1500);
  assert.deepEqual(shift.writes, [['--name-pos', '50%']], 'a quarter of a 6 s cycle across 200%');
  assert.deepEqual(slow.writes, [['--name-pos', '30%']]);
  assert.deepEqual(fade.writes, [['--name-mix', '50%']], 'the fade keeps its keyframe shape');
  c.tickNameEffects(3000);
  assert.deepEqual(fade.writes.at(-1), ['--name-mix', '100%']);
  c.tickNameEffects(3000);
  assert.equal(fade.writes.length, 2, 'an unchanged value is not written again');
  const late = element('shift', '6s'); setNames([late]); c.tickNameEffects(1500);
  assert.deepEqual(late.writes, [['--name-pos', '50%']], 'a name rendered later joins the same phase');
});

test('offscreen and scroll-paused names stay still, and every name holds while the timeline scrolls', () => {
  const { c, setNames, rootAttrs } = clock();
  const offscreen = element('fade', '6s', { 'data-media-visible': 'false' });
  const paused = element('shift', '6s', { 'data-media-visible': 'true', 'data-scroll-paused': '' });
  const moving = element('fade', '6s');
  setNames([offscreen, paused, moving]);
  assert.equal(c.tickNameEffects(1500), 3, 'all three still count as animated names');
  assert.deepEqual([offscreen.writes.length, paused.writes.length, moving.writes.length], [0, 0, 1]);
  rootAttrs.add('data-scrolling');
  c.tickNameEffects(3000);
  assert.equal(moving.writes.length, 1, 'nothing moves mid-scroll');
});

test('without the visibility controller every Fade/Shift name still moves', () => {
  const { c, setNames } = clock({ controller: false });
  const untracked = element('fade', '6s', {});
  setNames([untracked]);
  c.tickNameEffects(1500);
  assert.equal(untracked.writes.length, 1);
});

test('the clock runs only while the tab is visible and motion is allowed', () => {
  const visible = clock(); visible.c.initNameEffects();
  assert.equal(visible.timers.size, 1);
  vm.runInContext('document.hidden = true', visible.c); visible.listeners.visibilitychange();
  assert.equal(visible.timers.size, 0, 'a hidden tab stops the clock');
  vm.runInContext('document.hidden = false', visible.c); visible.listeners.visibilitychange();
  assert.equal(visible.timers.size, 1);
  visible.c.initNameEffects();
  assert.equal(visible.timers.size, 1, 'never two clocks');
  // Each tick lands just after the next 50 ms timeline boundary, like stepped rings.
  vm.runInContext('performance.now = () => 1234', visible.c);
  visible.setNames([element('fade')]);
  const first = [...visible.timers][0]; visible.timers.delete(first); first.fn();
  const next = [...visible.timers][0];
  assert.equal(visible.timers.size, 1, 'a tick schedules exactly one next tick');
  assert.equal(next.ms, 50 - 34 + 1);
  // With no animated names anywhere, the clock checks once a second instead.
  visible.setNames([]);
  visible.timers.delete(next); next.fn();
  assert.equal([...visible.timers][0].ms, 1000);
  for (const options of [{ hidden: true }, { reduced: true }]) {
    const stopped = clock(options); stopped.c.initNameEffects();
    assert.equal(stopped.timers.size, 0, JSON.stringify(options));
  }
});

test('the clock’s values do not make names look changed or need intersection work when static', () => {
  assert.match(chat, /function sameDisplayName\(a, b\)[\s\S]*?\['--name-from', '--name-to', '--name-speed'\]/);
  assert.doesNotMatch(chat, /name\.getAttribute\('style'\) === next\.getAttribute\('style'\)|el\.getAttribute\('style'\) === next\.getAttribute\('style'\)/);
  assert.match(chat, /const selector = '\.avatar, \.msg, \.display-name\.name-effect-fade, \.display-name\.name-effect-shift';/);
  assert.match(section('    function wireStaticEvents()', '      wireVoiceEvents();'), /initRingVisibility\(\);\s*initNameEffects\(\);/);
});

test('rings step 20 times a second on one shared timeline phase', () => {
  assert.match(css, /\.avatar\.has-ring\.ring-anim::before\s*\{\s*animation:\s*ring-spin 3\.5s steps\(70\) infinite;/);
  const c = vm.createContext({});
  vm.runInContext(section('    function alignRingSpin(avatar)', '    let ringVisibilityController = null;'), c);
  const anim = (animationName, playState, startTime) => ({ animationName, playState, startTime });
  const running = anim('ring-spin', 'running', 1234), paused = anim('ring-spin', 'paused', null), other = anim('pop-in', 'running', 99);
  const avatar = { classList: { contains: name => name === 'ring-anim' }, getAnimations: options => { assert.equal(options?.subtree, true); return [running, paused, other]; } };
  c.alignRingSpin(avatar);
  assert.equal(running.startTime, 0, 'a running ring joins the shared phase');
  assert.equal(paused.startTime, null, 'a paused ring is left to CSS, which still controls pause and resume');
  assert.equal(other.startTime, 99);
  assert.doesNotThrow(() => c.alignRingSpin({ classList: { contains: () => false } }));
  const controller = section('    function initRingVisibility()', '    // One clock moves every visible Fade/Shift name');
  assert.match(controller, /if \(visible === 'true'\) alignRingSpin\(el\);/, 'rings that come into view are aligned');
  assert.match(controller, /if \(!document\.hidden\) qsa\('\.avatar\.ring-anim\[data-ring-visible="true"\]'\)\.forEach\(alignRingSpin\);/, 'a returning tab realigns visible rings');
  assert.match(controller, /if \(record\.target\.dataset\.ringVisible === 'true'\) alignRingSpin\(record\.target\);/, 'a restarted ring animation is realigned');
});

test('typing dots animate opacity on the compositor, not content on every frame', () => {
  assert.doesNotMatch(css, /@keyframes typing-dots|content:\s*"\.\."/);
  assert.match(css, /@keyframes typing-dot-2\s*\{\s*0%\s*\{\s*opacity:\s*0;\s*\}\s*33%\s*\{\s*opacity:\s*1;\s*\}\s*\}/);
  assert.match(css, /@keyframes typing-dot-3\s*\{\s*0%\s*\{\s*opacity:\s*0;\s*\}\s*66%\s*\{\s*opacity:\s*1;\s*\}\s*\}/);
  const markup = section('    function renderTyping()', '      const signature =');
  assert.equal((markup.match(/<span class="dots" aria-hidden="true"><i>\.<\/i><i>\.<\/i><i>\.<\/i><\/span>/g) || []).length, 3);
  assert.doesNotMatch(markup, /<span class="dots"><\/span>/);
});
