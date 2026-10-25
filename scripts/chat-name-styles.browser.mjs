// Offline fixture: all production traffic is blocked.
// CHAT_BROWSER_PATH=/path/to/chromium node scripts/chat-name-styles.browser.mjs
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright') : 'playwright');
let html = await fs.readFile(new URL('../Chat/chat.html',import.meta.url),'utf8');
html = html.replace(/    initAuthRays\(\);\s*whenSupabaseReady\(\)\.then\(\(ready\) => \{[\s\S]*?\n    \}\);/, '    window.__nameStyleReady = true;');
const browser = await chromium.launch({headless:true,
  ...(process.env.CHAT_BROWSER_PATH ? {executablePath:process.env.CHAT_BROWSER_PATH}:{}),
  args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
const output = process.env.CHAT_NAME_STYLE_OUTPUT || path.join(os.tmpdir(),'liminal-name-styles-qa');
await fs.mkdir(output,{recursive:true});
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'no-preference'});
  const errors = [];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url()==='https://liminal.test/'
    ? route.fulfill({contentType:'text/html',body:html}):route.abort());
  await page.goto('https://liminal.test/');
  await page.waitForFunction(()=>window.__nameStyleReady);
  await page.evaluate(()=>{
    profiles.set('tester',{username:'tester',display_name:'Connor',staff_role:'member',status:'online',name_style:{}});
    profiles.set('alice',{username:'alice',display_name:'Alice',staff_role:'member',status:'online',name_style:{}});
    me = profiles.get('tester');
    channels = [{id:'general',label:'general',kind:'chat',icon:'#',category:'Community'}];
    dms = [{id:'dm-a',other:'alice',participants:['tester','alice']}];
    currentView = {type:'channel',id:'general'};
    window.__writes = []; window.__failSave = false;
    updateOwnProfile = async patch => {
      __writes.push(structuredClone(patch));
      return __failSave ? {error:{message:'fixture failure'}}:{data:{...me,...patch},error:null};
    };
    sb = {rpc:async()=>({data:[]}),from:()=>{
      const q=new Proxy({}, {get:(_,key)=>key==='then' ? resolve=>Promise.resolve({data:[]}).then(resolve):()=>q});
      return q;
    }};
    profileDetailLoaded.add('tester'); profileDetailLoaded.add('alice');
    msgCache.set('c:general',[
      {id:'a',channel_id:'general',sender:'tester',content:'Name styles are here.',type:'text',created_at:'2026-10-25T22:00:00Z',reactions:{}},
      {id:'b',channel_id:'general',sender:'alice',content:'Nice.',type:'text',created_at:'2026-10-25T22:01:00Z',reactions:{}}
    ]);
    hasMoreMap.set('c:general',false);
    $('startup-screen').hidden=true; $('auth-screen').hidden=true; $('app-shell').hidden=false;
    applyTheme('midnight'); wireStaticEvents(); initRingVisibility();
    renderSelf();renderChannels();renderDmList();renderMembers();renderTimeline();
    openSettings('profile');
  });
  const preview = page.locator('#name-style-preview .display-name');
  assert.equal(await preview.innerText(),'Connor');
  await page.locator('#set-name-font').selectOption('serif');
  await page.locator('#set-name-effect').selectOption('shift');
  await page.locator('#set-name-from').fill('#dd88ff');
  await page.locator('#set-name-to').fill('#55ddff');
  await page.locator('#set-name-speed').selectOption('slow');
  await page.waitForFunction(()=>me.name_style.effect==='shift' && me.name_style.to==='#55ddff');
  assert.match(await preview.getAttribute('class'),/name-font-serif name-effect-shift/);
  assert.equal(await page.locator('#set-username-handle').innerText(),'@tester');
  assert.equal(await page.locator('.msg[data-sender="tester"] .display-name').innerText(),'Connor');
  assert.match(await page.locator('.msg[data-sender="tester"] .display-name').getAttribute('class'),/name-effect-shift/);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#name-style-preview .display-name')).animationDuration),'10s');
  await page.screenshot({path:path.join(output,'settings-desktop.png')});
  await page.locator('[data-close-dialog="settings-dialog"]').click();
  await page.evaluate(()=>openSettings('profile'));
  assert.equal(await page.locator('#set-name-effect').inputValue(),'shift','saved style survives reopening');
  await page.locator('#set-name-effect').selectOption('fade');
  await page.waitForFunction(()=>me.name_style.effect==='fade');
  assert.equal(await preview.evaluate(el=>getComputedStyle(el).animationName),'name-color-fade');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await preview.evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>document.documentElement.setAttribute('data-ring-paused',''));
  assert.equal(await preview.evaluate(el=>getComputedStyle(el).animationPlayState),'paused');
  await page.evaluate(()=>document.documentElement.removeAttribute('data-ring-paused'));
  await page.locator('#set-name-font').selectOption('mono');
  await page.waitForFunction(()=>me.name_style.font==='mono');
  await page.evaluate(()=>applyDyslexic(true));
  assert.doesNotMatch(await preview.evaluate(el=>getComputedStyle(el).fontFamily),/monospace/);
  await page.evaluate(()=>applyDyslexic(false));
  await page.evaluate(()=>{window.__failSave=true});
  await page.locator('#set-name-font').selectOption('rounded');
  await page.waitForFunction(()=>$('profile-save-status').textContent==='Could not save changes.');
  assert.equal(await page.evaluate(()=>me.name_style.font),'mono','a failed write does not change the saved profile');
  await page.evaluate(()=>{window.__failSave=false});
  await page.locator('#name-style-reset').click();
  await page.waitForFunction(()=>me.name_style.font==='default' && me.name_style.effect==='default');
  assert.match(await preview.getAttribute('class'),/name-font-default name-effect-default/);
  await page.locator('[data-close-dialog="settings-dialog"]').click();
  await page.evaluate(()=>{
    handleProfileChange({new:{username:'alice',display_name:'Alice renamed',name_style:{font:'mono',effect:'gradient',from:'#ff88aa',to:'#88aaff',speed:'normal'}}});
  });
  assert.equal(await page.locator('.msg[data-sender="alice"] .display-name').innerText(),'Alice renamed');
  assert.match(await page.locator('#dm-list .display-name').getAttribute('class'),/name-font-mono name-effect-gradient/);
  await page.evaluate(()=>{
    const el=document.createElement('div'); el.id='offscreen-name';el.style.marginTop='5000px';
    el.innerHTML=displayNameHtml({...profiles.get('alice'),name_style:{effect:'fade'}});document.body.append(el);
  });
  await page.waitForFunction(()=>document.querySelector('#offscreen-name .display-name').dataset.mediaVisible==='false');
  assert.equal(await page.locator('#offscreen-name .display-name').evaluate(el=>getComputedStyle(el).animationPlayState),'paused');
  await page.evaluate(()=>document.querySelector('#offscreen-name').remove());
  await page.screenshot({path:path.join(output,'conversation-desktop.png')});
  await page.setViewportSize({width:320,height:740});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{applyTheme('monolight'); openSettings('profile');});
  await page.waitForFunction(()=>getComputedStyle($('settings-dialog')).opacity==='1');
  assert.equal(await page.locator('html').getAttribute('data-light'),'true');
  await page.locator('#set-display-name').fill('A very long name with <b>literal text</b>');
  await page.locator('#name-style-preview').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#name-style-preview b').count(),0,'display names remain escaped');
  const bounds = await page.locator('#name-style-editor').boundingBox();
  assert(bounds.x>=0 && bounds.x+bounds.width<=320,'controls fit a narrow screen');
  await page.screenshot({path:path.join(output,'settings-mobile-light.png')});
  assert.deepEqual(errors,[]);
  console.log('Name styles browser checks passed: preview, autosave, persistence, failure/reset, cross-user updates, animation speed, reduced motion, offscreen/hidden pause, dyslexic override, escaped names and mobile/light layout. Screenshots:',output);
} finally {await browser.close();}
