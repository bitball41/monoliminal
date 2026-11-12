// Corazon Games rebrand: visible branding changes, compatibility identifiers do not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const games = await readFile(new URL('../Games/games.html', import.meta.url), 'utf8');
const launcher = await readFile(new URL('../Games/liminal-games-launcher.html', import.meta.url), 'utf8');
const styles = games.slice(0, games.indexOf('</style>'));

test('Games presents Corazon Games in the brand palette and font', () => {
  assert.match(games, /<html lang="en" data-theme="corazon">/);
  assert.match(games, /<title>Corazon Games<\/title>/);
  assert.match(games, /<meta name="theme-color" content="#390606" \/>/);
  assert.match(games, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  assert.match(games, /fonts\.googleapis\.com\/css2\?[^"]*family=Courgette/);
  assert.match(styles, /--bg:#390606;\s*--panel:#230404;/);
  assert.match(styles, /--text:#fff1f0;/);
  assert.match(styles, /--accent:#f4a6a1;/);
  assert.match(styles, /h1\{[^}]*font-family:"Courgette"/);
  assert.match(games, /<h1>Corazon Games<\/h1>/);
});

test('no Liminal branding or old indigo palette remains visible in Games', () => {
  assert.deepEqual(games.match(/Liminal Games|Pacifico/g) || [], []);
  assert.deepEqual(styles.match(/#09003d|#5865f2|#7c86ff|rgba\((?:88,101,242|124,134,255),/g) || [], []);
});

test('compatibility identifiers are unchanged', () => {
  for (const id of ['"liminal:games:ready"', '"liminal:games:hello"', '"liminal:launcher:hello"', '"liminal-games-launcher"',
    '"liminalFavorites.simple.v1"', '"liminalGames.visitor.v1"', '"liminalGames.device.v1"', '"liminalGames.dismissedAnnouncement.v1"',
    'cdn.jsdelivr.net/gh/bitball41/liminal-ugs@main/games.js']) {
    assert(games.includes(id), `Games keeps ${id}`);
  }
});

test('the Games launcher matches the Corazon brand and keeps its protocol', () => {
  assert.match(launcher, /<title>Corazon Games<\/title>/);
  assert.match(launcher, /<meta name="theme-color" content="#390606">/);
  assert.match(launcher, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  assert.match(launcher, /family=Courgette/);
  assert.match(launcher, /background:#390606;color:#fff1f0;/);
  assert.match(launcher, /font-family:Courgette,cursive;font-size:36px/);
  assert.deepEqual(launcher.match(/Liminal Games|Pacifico|#09003d|#5865f2/g) || [], []);
  for (const id of ['"liminal:games:hello"', '"liminal:games:ready"', '"liminal:launcher:hello"', '"liminal:games:force-refresh"',
    '"liminal-games-launcher-controls"', '"liminal-games-launcher:"', 'const LAUNCHER_VERSION=2;', '/liminal-apps/games.html']) {
    assert(launcher.includes(id), `launcher keeps ${id}`);
  }
});

test('the launcher loader and the Games startup screen look the same', () => {
  const keyframes = /@keyframes [\w-]+\{50%\{width:85%\}100%\{width:15%;transform:translateX\(185px\)\}\}/;
  assert.match(launcher, keyframes);
  assert.match(games, keyframes);
  assert.match(games, /\.games-startup-track\{width:220px;height:3px;[^}]*background:#fff1f01a\}/);
  assert.match(games, /\.games-startup-logo\{[^}]*font-size:36px/s);
});
