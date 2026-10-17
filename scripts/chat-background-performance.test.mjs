import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
const source = chat.slice(chat.indexOf('    function createBackgroundBudget('),
  chat.indexOf('    function configureBackgroundParticles('));
assert(source.includes('function createWebGLBackground('));

function budget(options = {}) {
  const c = vm.createContext({});
  vm.runInContext(source, c);
  return c.createBackgroundBudget({ fps: 30 }, { chromebook: false, lite: false, ...options });
}

test('backgrounds retain desktop quality and start with a smaller Chromebook or lite budget', () => {
  const desktop = budget(), chromebook = budget({ chromebook: true }), lite = budget({ lite: true });
  assert.equal(desktop.fps, 30);
  assert.equal(desktop.maxDimension, 1024);
  assert.equal(desktop.scale, 1);
  assert.equal(desktop.dpr, 1.5);
  assert.equal(chromebook.fps, 24);
  assert.equal(chromebook.maxDimension, 640);
  assert(chromebook.scale < desktop.scale);
  assert.equal(chromebook.dpr, 1);
  assert.equal(lite.fps, 20);
  assert.equal(lite.maxDimension, 480);
  assert(lite.scale < chromebook.scale);
});

test('one hitch or a steady 30 Hz display does not lower background quality', () => {
  const b = budget();
  let now = 0;
  b.sample(now);
  for (let i = 0; i < 240; i++) {
    now += i === 60 ? 250 : 1000 / 30;
    assert.equal(b.sample(now), false);
  }
  assert.equal(b.maxDimension, 1024);
});

test('repeated frame drops reduce GPU work; recovery requires sustained stable frames', () => {
  const b = budget({ chromebook: true });
  let now = 0;
  b.sample(now);
  for (let i = 0; i < 80; i++) b.sample(now += 50);
  const minimum = b.maxDimension;
  assert(minimum < 640);
  assert.equal(b.fps, 15);
  const advance = duration => {
    const end = now + duration;
    while (now < end) b.sample(now += 1000 / 60);
  };
  advance(14000);
  assert.equal(b.maxDimension, minimum, 'a brief recovery cannot immediately raise GPU demand');
  advance(4000);
  assert(b.maxDimension > minimum && b.maxDimension < 640);
  advance(16000);
  assert.equal(b.maxDimension, 640);
});

test('pausing resets sampling without discarding the current quality budget', () => {
  const b = budget();
  b.sample(0);
  for (let now = 50; now <= 2000; now += 50) b.sample(now);
  const dimension = b.maxDimension;
  b.resetClock();
  assert.equal(b.sample(1_000_000), false, 'time spent asleep is not a missed frame');
  for (let now = 1_000_017; now < 1_006_000; now += 17) b.sample(now);
  assert.equal(b.maxDimension, dimension, 'time spent asleep is not recovery time');
});

function renderer({ chromebook = false, reduced = false } = {}) {
  let sequence = 0, now = 0, draws = 0, rectReads = 0, motionReads = 0, removed = false, lost = false;
  const frames = new Map(), listeners = new Map(), observers = [], times = [];
  const target = name => ({
    addEventListener: (type, fn) => listeners.set(`${name}:${type}`, fn),
    removeEventListener: type => listeners.delete(`${name}:${type}`),
  });
  const stage = { ...target('stage'), hidden: false, isConnected: true, append() {},
    getBoundingClientRect() { rectReads++; return { width: 1200, height: 700 }; } };
  const timeline = { hidden: false }, shell = { hidden: false }, dialog = { open: false };
  const motion = { ...target('motion'),
    get matches() { motionReads++; return reduced; },
    set matches(value) { reduced = value; } };
  const gl = {
    useProgram() {}, createBuffer: () => ({}), bindBuffer() {}, bufferData() {},
    getAttribLocation: () => 0, enableVertexAttribArray() {}, vertexAttribPointer() {},
    enable() {}, blendFunc() {}, viewport() {}, clearColor() {}, clear() {},
    getUniformLocation: (_, name) => name,
    uniform1f(name, value) { if (name === 'iTime') times.push(value); },
    uniform1i() {}, uniform2fv() {}, uniform3fv() {}, uniform4fv() {},
    drawArrays() { draws++; }, deleteBuffer() {}, deleteProgram() {},
    getExtension: () => ({ loseContext() { lost = true; } }),
  };
  const canvas = { width: 0, height: 0, setAttribute() {}, getContext: () => gl,
    remove() { removed = true; } };
  const document = { ...target('document'), hidden: false, createElement: () => canvas,
    querySelector: () => dialog.open ? dialog : null, querySelectorAll: () => [dialog] };
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {} disconnect() { this.disconnected = true; }
  }
  const nodes = { 'chat-background-stage': stage, timeline, 'app-shell': shell };
  const c = vm.createContext({
    document, navigator: { userAgent: chromebook ? 'X11; CrOS x86_64' : 'X11; Linux x86_64' },
    matchMedia: () => motion, isLiteMode: () => false, devicePixelRatio: 2,
    ResizeObserver: Observer, MutationObserver: Observer,
    $: id => nodes[id] || { textContent: '' },
    me: { username: 'alice' }, chatBackgroundChoice: 'balatro', chatBackgroundOwner: 'alice',
    CHAT_BACKGROUNDS: { balatro: { fps: 30, scale: 0.75 } }, BG_VERTEX: '',
    createBackgroundProgram: () => ({}),
    backgroundPalette: () => ({ primary: '#000000', contrast: '#ffffff', bg: '#000000' }),
    backgroundRGBA: () => [0, 0, 0, 1], mixBackgroundHex: () => '#000000',
    requestAnimationFrame(fn) { const id = ++sequence; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  vm.runInContext(source, c);
  const background = c.createWebGLBackground('balatro');
  function tick(time) {
    now = time;
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(fn => fn(now));
  }
  function run(duration, step = 1000 / 60) {
    const end = now + duration;
    while (now < end) tick(now + step);
  }
  return { background, frames, listeners, observers, canvas, document, dialog, motion, times,
    tick, run, emit: event => listeners.get(event)(),
    get draws() { return draws; }, get rectReads() { return rectReads; },
    get motionReads() { return motionReads; },
    get removed() { return removed; }, get lost() { return lost; } };
}

test('WebGL caps Chromebook pixels and limits frames without reading layout each draw', () => {
  for (const chromebook of [false, true]) {
    const r = renderer({ chromebook });
    r.tick(0); r.run(2000);
    assert.equal(r.canvas.width, chromebook ? 640 : 1024);
    assert(r.draws >= (chromebook ? 46 : 58) && r.draws <= (chromebook ? 50 : 62),
      `frame limiter stays near ${chromebook ? 24 : 30} fps: ${r.draws} draws`);
    assert.equal(r.rectReads, 1, 'frame scheduling never polls layout');
    assert.equal(r.motionReads, 1, 'frames use the cached motion preference');
    r.background.destroy();
  }
});

test('a WebGL background sleeps behind dialogs, redraws theme changes and resumes after closing', () => {
  const r = renderer({ chromebook: true });
  r.tick(0); r.run(200);
  r.dialog.open = true; r.observers[1].callback(); r.run(100);
  const paused = r.draws;
  r.run(1000);
  assert.equal(r.draws, paused);
  assert.equal(r.frames.size, 0);
  r.background.updateTheme(); r.run(100);
  assert.equal(r.draws, paused + 1, 'theme changes still get a static preview');
  r.dialog.open = false; r.observers[1].callback(); r.run(1000);
  assert(r.draws > paused + 20);
  r.document.hidden = true; r.emit('document:visibilitychange');
  assert.equal(r.frames.size, 0);
  r.tick(60000);
  r.document.hidden = false; r.emit('document:visibilitychange'); r.run(100);
  assert.equal(r.canvas.width, 640, 'tab wake does not trigger a false downgrade');
  r.background.destroy();
  assert.equal(r.frames.size, 0);
  assert.equal(r.listeners.size, 0);
  assert(r.observers.every(o => o.disconnected));
  assert(r.removed && r.lost);
});

test('reduced motion renders a still frame and reacts to preference changes', () => {
  const r = renderer({ reduced: true });
  r.run(1000);
  assert.equal(r.draws, 1);
  assert.equal(r.times[0], 0);
  assert.equal(r.frames.size, 0);
  r.background.updateTheme(); r.run(1000);
  assert.equal(r.draws, 2);
  r.motion.matches = false; r.emit('motion:change'); r.run(1000);
  assert(r.draws > 25);
  r.motion.matches = true; r.emit('motion:change'); r.run(1000);
  const paused = r.draws;
  r.run(1000);
  assert.equal(r.draws, paused);
  assert.equal(r.times.at(-1), 0);
  r.background.destroy();
});

test('sustained slow browser frames shrink the actual render target', () => {
  const r = renderer({ chromebook: true });
  r.tick(0); r.run(3000, 50);
  assert(r.canvas.width < 400);
  assert(r.rectReads <= 3, 'only quality transitions resize the canvas');
  r.background.destroy();
});
