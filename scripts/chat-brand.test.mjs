// Corazon Chat rebrand: visible branding changes, compatibility identifiers do not.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
const launcher = await readFile(new URL('../Chat/liminal-chat-launcher.html', import.meta.url), 'utf8');
const section = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  return source.slice(from, source.indexOf(end, from));
};
const withoutBundles = source => source.replace(/<script>\s*\/\*[\s\S]*?<\/script>/g, '').replace(/url\("data:[^"]*"\)/g, '');

test('Chat and launcher present Corazon Chat in the brand palette and font', () => {
  for (const html of [chat, launcher]) {
    assert.match(html, /<title>Corazon Chat<\/title>/);
    assert.match(html, /<meta name="theme-color" content="#390606">/);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
    assert.match(html, /fonts\.googleapis\.com\/css2\?[^"]*family=Courgette/);
  }
  assert.match(chat, /<html lang="en" data-theme="corazon">/);
  assert.match(chat, /--bg: #390606;\s*--accent: #f4a6a1;\s*--text: #fff1f0;/);
  assert.match(section(chat, '<style id="corazon-brand">', '</style>'), /--panel: #230404;/);
  assert.match(section(chat, '.startup-logo {', '}'), /font-family: Courgette/);
  assert.match(section(chat, '    .brand-title {', '}'), /"Courgette"/);
  assert.match(launcher, /background: #390606; color: #fff1f0;/);
  assert.match(launcher, /font: 400 36px\/1\.24 Courgette/);
});

test('no visible Liminal branding remains in Chat or its launcher', () => {
  const chatLeft = withoutBundles(chat).match(/\bLiminal\b(?! Native Flags)/g) || [];
  assert.deepEqual(chatLeft, []);
  assert.deepEqual(withoutBundles(launcher).match(/\bLiminal\b/g) || [], []);
  assert.match(chat, /download="corazon-chat-launcher\.html"/);
  assert.match(chat, /searchParams\.set\('download', 'corazon-chat-launcher\.html'\)/);
  assert.match(chat, /`corazon-chat-data-\$\{/);
});

test('compatibility identifiers are unchanged', () => {
  for (const id of ['@accounts.liminal.invalid', "'liminal:chat:ready'", "'liminal:chat:hello'", "'liminal:launcher:hello'",
    "'liminal-online'", "'liminal-presence'", "'liminal-voice-signal'", "'liminal-media'", "'liminal-pfp'", "'liminal-stickers'",
    "'liminal-group-media'", "'liminal-devsession:'", "'liminal-launcher:'", '/liminal-apps/chat.html', '/liminal-apps/liminal-chat-launcher.html']) {
    assert(chat.includes(id), `Chat keeps ${id}`);
  }
  for (const id of ['"liminal:chat:ready"', '"liminal:launcher:hello"', '"liminal-launcher-controls"', "'liminal-launcher-cache'",
    '/liminal-apps/chat.html', 'const LAUNCHER_VERSION=6;']) {
    assert(launcher.includes(id), `launcher keeps ${id}`);
  }
  assert.match(chat, /const RESERVED_NAMES = \[[^\]]*'liminal'[^\]]*'corazon'[^\]]*\]/);
});

function themeContext(stored) {
  const store = new Map(Object.entries(stored).map(([key, value]) => [key, JSON.stringify(value)]));
  const LS = {
    get: (key, fallback) => store.has(key) ? JSON.parse(store.get(key)) : fallback,
    set: (key, value) => store.set(key, JSON.stringify(value)),
  };
  const context = vm.createContext({ LS });
  vm.runInContext(section(chat, "    const DEFAULT_THEME = 'corazon';", '    const STATUS_META = {'), context);
  return { context, store };
}

test('the old Midnight default moves to Corazon once and later choices stick', () => {
  const fresh = themeContext({});
  assert.equal(fresh.context.initialTheme(), 'corazon');

  const old = themeContext({ lc_theme: 'midnight' });
  assert.equal(old.context.initialTheme(), 'corazon');
  assert.equal(old.store.get('lc_theme_brand'), '"corazon"');

  const chosenAgain = themeContext({ lc_theme: 'midnight', lc_theme_brand: 'corazon' });
  assert.equal(chosenAgain.context.initialTheme(), 'midnight');

  for (const theme of ['ocean', 'monolight', 'ember']) {
    assert.equal(themeContext({ lc_theme: theme }).context.initialTheme(), theme);
  }

  // Crimson was retired for Corazon, before and after the one-time Midnight move.
  assert.equal(themeContext({ lc_theme: 'crimson' }).context.initialTheme(), 'corazon');
  assert.equal(themeContext({ lc_theme: 'crimson', lc_theme_brand: 'corazon' }).context.initialTheme(), 'corazon');
});

test('applyTheme sets Corazon tokens and falls back to Corazon for unknown themes', () => {
  const props = new Map(), attrs = new Map(), stored = new Map();
  const root = {
    dataset: {},
    style: { setProperty: (key, value) => props.set(key, value) },
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: key => attrs.delete(key),
  };
  const meta = { setAttribute: (key, value) => attrs.set(`meta:${key}`, value) };
  const context = vm.createContext({
    document: { documentElement: root }, settings: {}, LS: { set: (key, value) => stored.set(key, value) },
    qsa: () => [], qs: () => meta, activeChatBackground: null,
  });
  vm.runInContext(section(chat, '    const THEMES = {', '    const STATUS_META = {').replace('const THEMES', 'var THEMES'), context);
  vm.runInContext(section(chat, '    function luminance(hex) {', '    function selectTheme(key) {'), context);

  context.applyTheme('corazon');
  assert.equal(props.get('--bg'), '#390606');
  assert.equal(props.get('--text'), '#fff1f0');
  assert.equal(props.get('--on-accent'), '#230404');
  assert.equal(root.dataset.theme, 'corazon');
  assert.equal(attrs.get('meta:content'), '#390606');

  context.applyTheme('midnight');
  assert.equal(props.get('--bg'), '#09003d');
  assert.equal(props.get('--text'), '#f4f2ff');
  assert.equal(root.dataset.theme, 'midnight');

  assert.equal(vm.runInContext("'crimson' in THEMES", context), false);
  context.applyTheme('crimson');
  assert.equal(root.dataset.theme, 'corazon');

  context.applyTheme('removed-theme');
  assert.equal(stored.get('lc_theme'), 'corazon');
  assert.equal(root.dataset.theme, 'corazon');
});

test('raising min_chat_launcher_version to 6 sends v5 launchers to the Corazon download', async () => {
  const hub = await readFile(new URL('../Hub/liminal.html', import.meta.url), 'utf8');
  const hubVersion = Number(hub.match(/^const protocol = (\d+);$/m)?.[1]);
  const launcherVersion = Number(launcher.match(/^const LAUNCHER_VERSION=(\d+);$/m)?.[1]);
  assert.equal(launcherVersion, 6);
  assert.equal(hubVersion, launcherVersion, 'the Hub opens Chat as a launcher and must pass the same gate');

  const context = vm.createContext({ appSettings: {}, launcherVersion: 0 });
  vm.runInContext(section(chat, '    const LAUNCHER_PROTOCOL = ', '\n'), context);
  vm.runInContext(section(chat, '    function requiredLauncherVersion() {', '    function showLauncherMigrate() {')
    .replace(/launcherVersion >=/, 'globalThis.launcherVersion >='), context);
  const current = (min, version) => {
    context.appSettings.min_chat_launcher_version = min;
    context.launcherVersion = version;
    return context.launcherIsCurrent();
  };
  assert.equal(current('5', 5), true, 'today: v5 launchers and Hubs still open');
  assert.equal(current('6', 5), false, 'after the switch: v5 launchers see the download screen');
  assert.equal(current('6', 6), true, 'the Corazon launcher and updated Hub open');
});
