// Offline browser regression: no production traffic or real accounts.
// CHAT_BROWSER_PATH=/path/to/chromium node scripts/chat-layout.browser.mjs
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');
let html = await fs.readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
html = html.replace(/    initAuthRays\(\);\s*whenSupabaseReady\(\)\.then\(\(ready\) => \{[\s\S]*?\n    \}\);/, '    window.__layoutReady = true;');
const browser = await chromium.launch({headless:true,
  ...(process.env.CHAT_BROWSER_PATH ? {executablePath:process.env.CHAT_BROWSER_PATH} : {}),
  args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
const output = process.env.CHAT_LAYOUT_OUTPUT || path.join(os.tmpdir(), 'liminal-layout-qa');
await fs.mkdir(output, {recursive:true});
try {
  const page = await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'https://liminal.test/'
    ? route.fulfill({contentType:'text/html',body:html}) : route.abort());
  await page.addInitScript(() => {
    if (!localStorage.getItem('lc_layout')) localStorage.setItem('lc_layout', JSON.stringify('tabs'));
  });
  const fixture = async () => {
    await page.waitForFunction(() => window.__layoutReady);
    await page.evaluate(() => {
      profiles.set('tester', {username:'tester',display_name:'Test Member',staff_role:'owner',status:'online',bio:'Profile preview.'});
      profiles.set('alice', {username:'alice',display_name:'Alice',staff_role:'member',status:'offline'});
      me = profiles.get('tester');
      channels = [{id:'general',label:'general',kind:'chat',icon:'#',category:'Community'},
        {id:'bugs',label:'bug reports',kind:'forum',category:'Community'},
        {id:'voice-chat',label:'Voice Chat',kind:'voice',category:'Community'}];
      dms = [{id:'dm-a',other:'alice',participants:['tester','alice']},
        {id:'group-a',is_group:true,title:'Project group',participants:['tester','alice'],group_owner:'tester'}];
      window.__queries = [];
      sb = {rpc:async name => { __queries.push(name); return {data:[]}; }, from:table => {
        __queries.push(table);
        const q = new Proxy({}, {get(_,key) { return key === 'then' ? resolve => Promise.resolve({data:[]}).then(resolve) : () => q; }});
        return q;
      }};
      for (const key of ['c:general','dm:dm-a','dm:group-a']) { msgCache.set(key,[]);hasMoreMap.set(key,false); }
      $('startup-screen').hidden=true; $('auth-screen').hidden=true; $('app-shell').hidden=false;
      applyTheme('midnight');
      wireStaticEvents();
      renderSelf();renderChannels();renderDmList();renderMembers();
      loadAccountInbox();
      if (activeLayout === 'tabs') newWorkspaceTab();
    });
  };
  await page.goto('https://liminal.test/'); await fixture();
  assert(await page.locator('#workspace-home').isVisible());
  assert.match(await page.locator('#workspace-profile').innerText(), /Test Member\n@tester/);
  assert.equal(await page.locator('#workspace-tab-list [role="tab"]').count(),1);
  assert.equal(await page.locator('#workspace-channels #channel-list').count(),1);
  assert.equal(await page.locator('#workspace-nav #inbox-btn').count(),1);
  assert.equal(await page.locator('#member-panel').isVisible(),true);
  await page.screenshot({path:path.join(output,'home-desktop.png')});
  await page.locator('[data-channel="general"]').click();
  assert.equal(await page.locator('#workspace-home').isVisible(),false);
  assert.equal(await page.locator('#workspace-tab-list [role="tab"]').count(),1,'conversation replaces new tab');
  await page.locator('#message-input').fill('Unsent channel draft');
  await page.locator('#workspace-new-tab').click();
  assert.equal(await page.evaluate(() => currentView.type),'home');
  const readsBefore = await page.evaluate(() => ({...lastReadAt}));
  await page.evaluate(async () => {
    presenceLeft=false; presenceStopped=false;
    const count = __queries.length;
    await catchUpPoll();
    if (__queries.length !== count) throw Error('Home queried message history');
    ingestMessage({id:'layout-incoming',channel_id:'general',sender:'alice',content:'Unread on home',type:'text',created_at:new Date().toISOString(),reactions:{}}, 'channel');
  });
  assert.deepEqual(await page.evaluate(() => ({...lastReadAt})),readsBefore,'home does not mark hidden chat read');
  assert.equal(await page.evaluate(() => unreadCounts.get('c:general')),1);
  assert.equal(await page.locator('.workspace-tab-unread').innerText(),'1');
  await page.locator('[data-channel="general"]').click();
  assert.equal(await page.locator('#workspace-tab-list [role="tab"]').count(),2,'existing conversation is reused');
  assert.equal(await page.locator('#message-input').inputValue(),'Unsent channel draft');
  assert.equal(await page.evaluate(() => unreadCounts.get('c:general') || 0),0);
  await page.locator('#workspace-home-btn').click();
  await page.locator('[data-dm="group-a"]').click();
  assert.equal(await page.locator('#channel-title').innerText(),'Project group');
  await page.locator('#message-input').fill('Group draft');
  await page.locator('#workspace-new-tab').click();
  await page.locator('[data-dm="dm-a"]').click();
  assert.equal(await page.locator('#channel-title').innerText(),'Alice');
  await page.screenshot({path:path.join(output,'conversation-desktop.png')});
  await page.locator('.workspace-tab.active [data-workspace-close]').click();
  assert.equal(await page.locator('#channel-title').innerText(),'Project group');
  assert.equal(await page.locator('#message-input').inputValue(),'Group draft');
  const inactive = await page.locator('[data-workspace-tab]').first().getAttribute('data-workspace-tab');
  await page.locator(`[data-workspace-close="${inactive}"]`).click();
  assert.equal(await page.locator('#channel-title').innerText(),'Project group');
  await page.locator('#workspace-new-tab').click();
  await page.locator('[data-channel="bugs"]').click();
  assert(await page.locator('#forum-board').isVisible());
  await page.locator('#workspace-new-tab').click();
  await page.locator('[data-channel="voice-chat"]').click();
  assert(await page.locator('#vc-stage').isVisible());
  await page.locator('#workspace-new-tab').click();
  await page.evaluate(() => {
    inbox=[{id:'notice',kind:'mention',from:'alice',text:'Check general',view:'c:general',ts:new Date().toISOString(),read:false}];
    updateInboxBadge();
  });
  await page.locator('[data-workspace-inbox="notice"]').click();
  assert.equal(await page.locator('#channel-title').innerText(),'general');
  await page.locator('#workspace-new-tab').click();
  for (const [theme,width,height] of [['midnight',1440,900],['monolight',1440,900],['midnight',1024,768],['midnight',768,900],['monolight',390,844],['midnight',320,720]]) {
    await page.setViewportSize({width,height}); await page.evaluate(theme => applyTheme(theme),theme);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const selectedTab = await page.locator('[data-workspace-tab][aria-selected="true"]').boundingBox();
    const strip = await page.locator('#workspace-tab-list').boundingBox();
    assert(selectedTab.x>=strip.x-1 && selectedTab.x+selectedTab.width<=strip.x+strip.width+1, `active tab stays visible at ${width}`);
    const geometry = await page.locator('#main-content').evaluate(el => ({right:el.getBoundingClientRect().right, width:el.clientWidth,scroll:el.scrollWidth}));
    assert(geometry.right<=width+1 && geometry.width>200 && geometry.scroll<=geometry.width+1,`main fits ${width}`);
    assert(await page.locator('#self-settings-btn').isVisible());
    assert(await page.locator('#workspace-new-tab').isVisible());
    await page.screenshot({path:path.join(output,`home-${theme}-${width}.png`)});
    if (width<1021) {
      await page.locator('#member-toggle').click();
      assert(await page.locator('#member-panel').evaluate(el=>el.classList.contains('open')));
      await page.locator('#close-members').click();
      await page.evaluate(() => openView({type:'channel',id:'general'}));
      assert(await page.locator('#message-input').isVisible());
      const composer = await page.locator('.composer').evaluate(el => ({width:el.clientWidth,scroll:el.scrollWidth}));
      assert(composer.scroll<=composer.width+1, `composer fits ${width}`);
      const send = await page.locator('#send-btn').boundingBox();
      assert(send.x+send.width<=width+1, `send stays visible at ${width}`);
      await page.screenshot({path:path.join(output,`conversation-${theme}-${width}.png`)});
      await page.locator('#workspace-home-btn').click();
    }
  }
  await page.setViewportSize({width:1440,height:900});
  await page.locator('[data-workspace-tab][aria-selected="true"]').focus();
  await page.keyboard.press('Home');
  assert.equal(await page.locator('[data-workspace-tab]').first().getAttribute('aria-selected'),'true');
  await page.keyboard.press('End');
  assert.equal(await page.locator('[data-workspace-tab]').last().getAttribute('aria-selected'),'true');
  await page.evaluate(() => openSettings('appearance'));
  await page.locator('[data-layout-choice="classic"]').click();
  assert.equal(await page.evaluate(() => activeLayout),'tabs','preference does not change live layout');
  assert(await page.locator('#layout-reload-row').isVisible());
  await page.reload(); await fixture();
  assert.equal(await page.evaluate(() => activeLayout),'classic');
  assert.equal(await page.locator('#sidebar #channel-list').count(),1);
  assert.equal(await page.locator('.channel-header #inbox-btn').count(),1);
  assert.equal(await page.locator('.workspace-tabs').isVisible(),false);
  await page.evaluate(() => openSettings('appearance'));
  await page.locator('[data-layout-choice="tabs"]').click();
  await page.reload(); await fixture();
  assert.equal(await page.evaluate(() => activeLayout),'tabs');
  await page.evaluate(async () => {
    await openView(dmView(dms[0]));
    dms=[]; renderDmList();
  });
  await page.waitForFunction(() => currentView.type === 'home');
  while(await page.locator('[data-workspace-close]').count()>1) await page.locator('[data-workspace-close]').last().click();
  await page.locator('[data-workspace-close]').click();
  assert.equal(await page.locator('[data-workspace-tab]').count(),1,'closing last tab opens home');
  assert(await page.locator('#workspace-home').isVisible());
  const fresh = await browser.newPage();
  await fresh.route('**/*', route => route.request().url() === 'https://liminal.test/' ? route.fulfill({contentType:'text/html',body:html}) : route.abort());
  await fresh.goto('https://liminal.test/');
  await fresh.waitForFunction(() => window.__layoutReady);
  assert.equal(await fresh.evaluate(() => activeLayout),'classic','new browsers start in classic');
  await fresh.close();
  assert.deepEqual(errors,[]);
  console.log('Browser layout checks passed: switching after reload, tabs, drafts, unreads, inbox, groups, forums, voice, removed conversations, classic, mobile and light themes. Screenshots: '+output);
} finally { await browser.close(); }
