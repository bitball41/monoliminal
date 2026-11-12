// Games appears in one piece: the startup screen stays up until the game list,
// first stats request, news and fonts are ready, or a short cap passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = (await readFile(new URL('../Games/games.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const start = html.indexOf('    function domReady(){');
const end = html.indexOf('    function startApp(){', start);
assert(start > 0 && end > start);

function harness({ usage, content, cap = 3500 } = {}) {
  const classes = new Set(['is-loading']);
  const c = vm.createContext({
    Promise, Date, setTimeout, clearTimeout,
    READY_CAP_MS: cap, revealed: false, games: [], usageFirstLoad: usage || null,
    queueSync() {}, syncGames() {},
    window: { __gamesContentFirstLoad: content || null },
    document: {
      readyState: 'complete', fonts: undefined,
      body: { classList: { add: k => classes.add(k), remove: k => classes.delete(k), contains: k => classes.has(k) } },
    },
  });
  vm.runInContext(html.slice(start, end), c);
  return { c, loading: () => classes.has('is-loading') };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('the page stays hidden until games, stats and news are all in', async () => {
  const usage = deferred(), content = deferred();
  const h = harness({ usage: usage.promise, content: content.promise });
  h.c.revealWhenReady();
  h.c.games.push({}, {});
  await wait(320);
  assert.equal(h.loading(), true, 'still waiting on stats and news');
  usage.resolve();
  await wait(20);
  assert.equal(h.loading(), true, 'still waiting on news');
  content.resolve();
  await wait(20);
  assert.equal(h.loading(), false);
});

test('a hung request never holds the catalog past the cap', async () => {
  const h = harness({ usage: new Promise(() => {}), cap: 150 });
  h.c.revealWhenReady();
  h.c.games.push({});
  await wait(100);
  assert.equal(h.loading(), true);
  await wait(120);
  assert.equal(h.loading(), false);
});

test('startup markup and wiring are in place', () => {
  assert.match(html, /<body class="is-loading">/);
  assert.match(html, /<div class="games-startup" id="games-startup" role="status"/);
  assert.match(html, /startUsage\(\);\n\s*revealWhenReady\(\);/);
  assert.match(html, /window\.__gamesContentFirstLoad = refreshGamesContent\(\);/);
  assert.match(html, /body\.launcher-locked > :not\(#launcher-migrate\):not\(#games-startup\)/);
});
