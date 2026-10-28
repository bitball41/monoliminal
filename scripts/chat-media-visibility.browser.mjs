// Native rendering coverage using the production CSS and visibility controller.
// All requests are fulfilled locally; this fixture sends no production traffic.
// CHAT_BROWSER_PATH=/path/to/chromium node scripts/chat-media-visibility.browser.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');
const source = process.argv[2] ? path.resolve(process.argv[2]) : new URL('../Chat/chat.html', import.meta.url);
const chat = await fs.readFile(source, 'utf8');
const section = (start, end) => {
  const from = chat.indexOf(start), to = chat.indexOf(end, from);
  assert(from >= 0 && to > from, `production section exists: ${start}`);
  return chat.slice(from, to);
};
const styles = [...chat.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
const ringCode = section('    const safeHexColor =', '    function effectiveMyStatus(');
const animatedGif = Buffer.from('R0lGODlhBAAEAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAABAAEAAAICQABCBxIsCCAgAAh+QQBCgABACwAAAAABAAEAIEAAP8AAAAAAAAAAAAICQABCBxIsCCAgAA7', 'base64');
const fixture = `<!doctype html><html><head><style>${styles}</style><style>
  body { display: block; height: auto; margin: 16px; overflow: auto; }
  #viewport { width: 500px; height: 220px; overflow: auto; }
  #spacer { height: 1200px; }
  #previews { display: flex; align-items: center; height: 80px; margin: 0; padding: 8px; }
  #previews img { width: 24px; height: 24px; }
  #ring-avatar { margin: 16px; }
</style></head><body><div id="viewport"><div id="spacer"></div>
  <div class="msg" id="previews">
    <div class="msg-media"><img id="message-image" src="https://media.test/message.gif" alt="Message"></div>
    <a class="link-card"><img class="link-card-img" id="link-image" src="https://media.test/link.gif" alt="Link preview"></a>
    <button class="yt-thumb"><img id="youtube-image" src="https://media.test/youtube.gif" alt="Video preview"></button>
  </div><div id="ring-holder"></div>
</div><script>
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  ${ringCode}
  const profile = {ring: JSON.stringify({type:'image',url:'https://media.test/ring.gif',anim:true})};
  const ring = ringMarkup(profile);
  document.getElementById('ring-holder').innerHTML = '<span id="ring-avatar" class="avatar avatar-sm'+ring.cls+'"'+ring.style+'>A</span>';
  initRingVisibility();
</script></body></html>`;

const browser = await chromium.launch({headless:true, ...(process.env.CHAT_BROWSER_PATH
  ? {executablePath:process.env.CHAT_BROWSER_PATH} : {}), args:['--no-sandbox']});
try {
  const page = await browser.newPage({viewport:{width:800,height:600}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'liminal.test') return route.fulfill({contentType:'text/html', body:fixture});
    if (url.hostname === 'media.test') return route.fulfill({contentType:'image/gif', body:animatedGif});
    return route.abort();
  });
  await page.goto('https://liminal.test/');
  await page.waitForFunction(() => document.getElementById('previews').dataset.mediaVisible === 'false'
    && document.getElementById('ring-avatar').dataset.mediaVisible === 'false');
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  const state = () => page.evaluate(() => ({
    images:[...document.images].map(image => ({src:image.getAttribute('src'),
      visibility:getComputedStyle(image).visibility, transform:getComputedStyle(image).transform})),
    ring:{visibility:getComputedStyle(document.getElementById('ring-avatar'), '::before').visibility,
      background:getComputedStyle(document.getElementById('ring-avatar'), '::before').backgroundImage,
      playState:getComputedStyle(document.getElementById('ring-avatar'), '::before').animationPlayState},
  }));
  const offscreen = await state();
  assert(offscreen.images.every(image => image.visibility === 'hidden' && image.transform === 'none'));
  assert.equal(offscreen.ring.visibility, 'hidden', 'the GIF background ring is suppressed offscreen');
  assert.equal(offscreen.ring.playState, 'paused');
  await page.evaluate(() => { const viewport = document.getElementById('viewport'); viewport.scrollTop = viewport.scrollHeight; });
  await page.waitForFunction(() => document.getElementById('previews').dataset.mediaVisible === 'true'
    && document.getElementById('ring-avatar').dataset.mediaVisible === 'true');
  const visible = await state();
  assert(visible.images.every(image => image.visibility === 'visible' && image.transform !== 'none'));
  assert.equal(visible.ring.visibility, 'visible');
  assert.equal(visible.ring.playState, 'running');
  assert.match(visible.ring.background, /https:\/\/media\.test\/ring\.gif/);
  assert.deepEqual(visible.images.map(image => image.src), offscreen.images.map(image => image.src));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {configurable:true, value:true});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = await state();
  assert(hidden.images.every(image => image.visibility === 'hidden' && image.transform === 'none'));
  assert.equal(hidden.ring.visibility, 'hidden');
  assert.equal(hidden.ring.playState, 'paused');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {configurable:true, value:false});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.deepEqual(await state(), visible, 'returning to the tab restores rendering and every original URL');
  await page.evaluate(() => { document.getElementById('viewport').scrollTop = 0; });
  await page.waitForFunction(() => document.getElementById('previews').dataset.mediaVisible === 'false');
  assert.deepEqual(await state(), offscreen, 'scrolling away releases preview layers and the ring background');
  await page.evaluate(() => ringVisibilityController.destroy());
  const fallback = await state();
  assert(fallback.images.every(image => image.visibility === 'visible' && image.transform === 'none'));
  assert.equal(fallback.ring.visibility, 'visible', 'the unsupported/controller-disabled fallback keeps rings visible');
  assert.deepEqual(errors, []);
  console.log('MEDIA_VISIBILITY_VERIFIED', JSON.stringify({images:visible.images.length, ringBackground:true}));
} finally { await browser.close(); }
