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

test('backgrounds limit animation rates on Chromebooks and lite devices', () => {
  const desktop = budget(), chromebook = budget({ chromebook: true }), lite = budget({ lite: true });
  assert.equal(desktop.fps, 30);
  assert.equal(chromebook.fps, 24);
  assert.equal(lite.fps, 20);
});

test('one hitch or a steady 30 Hz display does not lower the animation rate', () => {
  const b = budget();
  let now = 0;
  b.sample(now);
  for (let i = 0; i < 240; i++) {
    now += i === 60 ? 250 : 1000 / 30;
    assert.equal(b.sample(now), false);
  }
  assert.equal(b.fps, 30);
});

test('repeated frame drops reduce animation work; recovery requires sustained stable frames', () => {
  const b = budget({ chromebook: true });
  let now = 0;
  b.sample(now);
  for (let i = 0; i < 80; i++) b.sample(now += 50);
  const minimum = b.fps;
  assert.equal(minimum, 12);
  const advance = duration => {
    const end = now + duration;
    while (now < end) b.sample(now += 1000 / 60);
  };
  advance(14000);
  assert.equal(b.fps, minimum, 'a brief recovery cannot immediately raise GPU demand');
  advance(4000);
  assert(b.fps > minimum && b.fps < 24);
  advance(16000);
  assert(b.fps < 24, 'recovery returns one cadence tier at a time');
  advance(16000);
  assert.equal(b.fps, 24);
});

test('pausing resets sampling without discarding the current quality budget', () => {
  const b = budget();
  b.sample(0);
  for (let now = 50; now <= 2000; now += 50) b.sample(now);
  const rate = b.fps;
  b.resetClock();
  assert.equal(b.sample(1_000_000), false, 'time spent asleep is not a missed frame');
  for (let now = 1_000_017; now < 1_006_000; now += 17) b.sample(now);
  assert.equal(b.fps, rate, 'time spent asleep is not recovery time');
});

function renderer({ chromebook = false, lite = false, reduced = false } = {}) {
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
    matchMedia: () => motion, isLiteMode: () => lite, devicePixelRatio: 2,
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

test('WebGL keeps the same detail on Chromebooks and limits frames without polling layout', () => {
  for (const options of [{}, { chromebook: true }, { lite: true }]) {
    const r = renderer(options), fps = options.lite ? 20 : options.chromebook ? 24 : 30;
    r.tick(0); r.run(2000);
    assert.equal(r.canvas.width, 1024, 'device detection does not sacrifice spatial detail');
    assert(r.draws >= fps * 2 - 2 && r.draws <= fps * 2 + 2,
      `frame limiter stays near ${fps} fps: ${r.draws} draws`);
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
  assert.equal(r.canvas.width, 1024, 'tab wake retains the original render resolution');
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

test('sustained slow frames reduce draw cadence without shrinking or reallocating the canvas', () => {
  const r = renderer({ chromebook: true });
  r.tick(0);
  const width = r.canvas.width, height = r.canvas.height;
  r.run(4000, 50);
  const draws = r.draws;
  r.run(2000, 50);
  assert(r.draws - draws >= 23 && r.draws - draws <= 25, 'sustained overload limits drawing to 12 fps');
  assert.equal(r.canvas.width, width);
  assert.equal(r.canvas.height, height);
  assert.equal(width, 1024);
  assert.equal(r.rectReads, 1, 'cadence changes never resize or remeasure the canvas');
  r.background.destroy();
});
