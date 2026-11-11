// Chat 6.1 typing and scrolling fixes. Each guard below came from a trace of
// real key presses and wheel scrolling at 4x CPU throttle
// (scripts/chat-runtime.browser.mjs keyboard and scroll phases).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
const css = [...chat.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

test('no :has() rule scans a large ancestor such as the app shell or the document', () => {
  // `.app-shell:has(…) :is(#search-btn, …)` re-scanned the app on every header
  // restyle and was 90% of selector time while typing.
  const selectors = css.split('}').map(rule => rule.split('{')[0]).flatMap(s => s.split(',')).map(s => s.trim());
  const broad = selectors.filter(s => /(^|\s)(html|body|:root|\.app-shell|\.main-panel|#main-content)[^\s]*:has\(/.test(s));
  assert.deepEqual(broad, []);
  assert.match(css, /html\[data-layout="tabs"\]\[data-workspace-home="true"\] :is\(#search-btn, #pins-btn, #dm-block-btn, #group-details-btn\)/);
  assert.match(chat, /document\.documentElement\.dataset\.workspaceHome = 'true';/);
  assert.match(chat, /document\.documentElement\.dataset\.workspaceHome = 'false';/);
});

test('the conversation column is not a size container', () => {
  // Any restyle inside a size container (each key press) forced container layout.
  assert.doesNotMatch(css, /container-type|@container/);
  assert.match(css, /\.main-panel\[data-narrow\] \.channel-header #subrole-btn-label/);
  assert.match(css, /\.main-panel\[data-tight\] \.call-invite\s*\{/);
  assert.match(chat, /panel\.toggleAttribute\('data-narrow', width <= 700\);/);
  assert.match(chat, /panel\.toggleAttribute\('data-tight', width <= 360\);/);
});

test('the character counter is a contained box, so updating it never re-lays out the page', () => {
  assert.match(css, /#char-count\s*\{[^}]*display:\s*inline-block;[^}]*width:\s*4ch;[^}]*contain:\s*strict;/);
});

test('the name clock never searches the whole document on a tick', () => {
  const clock = chat.slice(chat.indexOf('    function tickNameEffects('), chat.indexOf('    function syncNameEffects('));
  assert.doesNotMatch(clock, /qsa\(|querySelectorAll\(/);
  assert.match(chat, /const fadeNameEls = document\.getElementsByClassName\('name-effect-fade'\);/);
  assert.match(clock, /NAME_EFFECT_IDLE_MS/, 'no animated names: back off to once a second');
});

test('the browser harness types with real key presses and reports Event Timing', async () => {
  const harness = await readFile(new URL('./chat-runtime.browser.mjs', import.meta.url), 'utf8');
  assert.match(harness, /page\.keyboard\.type\(/);
  assert.match(harness, /observe\(\{type:'event',durationThreshold:16\}\)/);
  assert.match(harness, /pendingTimers\.length===5/, 'five background timers since activity tracking was removed');
});
