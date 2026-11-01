import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
const css = [...chat.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
assert(css.includes('.timeline {'), 'stylesheet found');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(rule => rule.split('{')[0].trim()).filter(Boolean);

test('timeline scroll state never restyles every message', () => {
  // A descendant rule keyed on the timeline's scroll class makes each toggle
  // restyle ~900 elements in the middle of the gesture.
  const offenders = rules.flatMap(rule => rule.split(','))
    .map(selector => selector.trim())
    .filter(selector => /\.timeline(\.[\w-]+)*\.is-scrolling(\.[\w-]+)*[\s>+~]/.test(selector)
      || /\.timeline-inner\[data-scrolling\][\s>+~]/.test(selector));
  assert.deepEqual(offenders, []);
  assert.match(css, /\.timeline-inner\[data-scrolling\]\s*\{\s*pointer-events:\s*none;\s*\}/);
  assert.match(css, /\.display-name\[data-scroll-paused\]\s*\{\s*animation-play-state:\s*paused;\s*\}/);
});

test('scroll frames pause only visible animated names and restore them on settle', () => {
  const start = chat.indexOf('function onTimelineScrollFrame');
  const handler = chat.slice(start, chat.indexOf('{ passive: true });', start));
  assert.match(handler, /if \(!scrollPausedNames\)/, 'pause set is gathered once per gesture');
  assert.match(handler, /name-effect-fade\[data-media-visible="true"\]/);
  assert.match(handler, /name-effect-shift\[data-media-visible="true"\]/);
  assert.match(handler, /setAttribute\('data-scroll-paused', ''\)/);
  assert.match(handler, /removeAttribute\('data-scroll-paused'\)/);
  assert.match(handler, /timelineInnerRef\.setAttribute\('data-scrolling', ''\)/);
  assert.match(handler, /timelineInnerRef\.removeAttribute\('data-scrolling'\)/);
});

test('read-state updates do not rewrite the new-messages badge every scroll frame', () => {
  const start = chat.indexOf('function updateViewingOlder(');
  const body = chat.slice(start, chat.indexOf('\n    }\n', start));
  assert.doesNotMatch(body, /\$\('new-msgs-badge'\)\.hidden\s*=/);
  assert.match(body, /if \(badge\.hidden !== \(pendingNewCount === 0\)\)/);
});
