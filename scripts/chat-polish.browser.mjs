// Offline UI review. All network traffic is intercepted; fixture accounts and counts only.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright') : 'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const screenshots=process.argv[2] || path.join(os.tmpdir(),'liminal-chat-polish-qa');
let html=await fs.readFile(path.join(root,'Chat/chat.html'),'utf8');
html=html.replace(/    initAuthRays\(\);\s*whenSupabaseReady\(\)\.then\(\(ready\) => \{[\s\S]*?\n    \}\);/, '    window.__reviewReady = true;');
const browser=await chromium.launch({...(process.env.CHAT_BROWSER_PATH ? {executablePath:process.env.CHAT_BROWSER_PATH} : {}),args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'],headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>route.request().url()==='https://liminal.test/'?route.fulfill({contentType:'text/html',body:html}):route.abort());
await page.goto('https://liminal.test/');
await page.waitForFunction(()=>window.__reviewReady);
await page.evaluate(()=>{
  const names=['Owner','Alice','Bob','Charlie','Dana','Elliot','Frankie','Gray','Harper'];
  names.forEach((name,i)=>profiles.set(name.toLowerCase(),{username:name.toLowerCase(),display_name:name,user_id:`user-${i}`,staff_role:i===0?'owner':i===1?'co_owner':'member',created_at:'2026-10-01T12:00:00Z',sub_role:i===0?'developer':i===2?'musician':'',status:'online',pfp:''}));
  me=profiles.get('owner');
  channels=[{id:'general',label:'general',kind:'chat',category:'Community',icon:'#'},{id:'announcements',label:'announcements',kind:'chat',category:'Community',icon:'#'},{id:'voice-chat',label:'Voice Chat',kind:'voice',category:'Community',icon:'◉'},{id:'bugs',label:'bug reports',kind:'forum',category:'Community',icon:'#'}];
  dms=[{id:'group-1',is_group:true,title:'Weekend plans',group_owner:'owner',participants:['owner','bob','charlie'],created_at:'2026-10-01T12:00:00Z'},{id:'dm-1',other:'alice',participants:['owner','alice']},{id:'dm-2',other:'bob',participants:['owner','bob']},{id:'solo',is_group:true,title:'Project ideas',group_owner:'owner',participants:['owner']}];
  const daily=Array.from({length:30},(_,i)=>({day:`2026-09-${String(i+1).padStart(2,'0')}`,messages:(i*31+19)%140,accounts:i<10?null:20+i,browsers:i<10?null:17+i,dms:11+i,signups:i%6}));
  window.fixtureAnalytics={generated_at:'2026-10-16T04:15:00Z',activity_since:'2026-09-11T12:00:00Z',durable_messages_since:'2026-09-11T12:00:00Z',daily,accounts_total:245,members_total:241,dau:62,wau:178,mau:231,browsers_today:54,returning_today:48,messages_24h:1834,messages_previous_24h:1700,foreground_5m:12,active_senders_7d:94,signups_7d:15,messages_total:48572,visible_messages:48001,dm_messages_24h:470,top_channels:[{label:'general',messages:10792,senders:94},{label:'bug reports',messages:89,senders:27}]};
  window.rpcFailure=false;
  sb={rpc:async(name,args)=>{
    if(name==='chat_get_analytics')return window.rpcFailure?{error:{message:'Network down'}}:{data:window.fixtureAnalytics};
    if(name==='chat_get_moderation_state')return {data:{banned:[],timed_out:[]}};
    if(name==='chat_list_subroles')return {data:availableSubroles()};
    if(name==='chat_get_admin_logs'||name==='chat_list_deleted_messages')return {data:[]};
    return {data:true};
  },from:table=>{const query=new Proxy({}, {get(_,key){if(key==='then')return (resolve,reject)=>(table==='chat_group_invites' && window.groupFetch ? window.groupFetch : Promise.resolve({data:[]})).then(resolve,reject);return ()=>query;}});return query;}};
  applyTheme('midnight');
  $('startup-screen').hidden=true;$('auth-screen').hidden=true;$('app-shell').hidden=false;
  renderChannels();renderDmList();renderSelf();
  applySubroleCatalog(Object.entries(SUB_ROLE_FALLBACK).map(([slug,item],i)=>({slug,...item,position:i})));
  subrolesLoaded=true;
  wireGroupEvents();
  $('private-call-search').addEventListener('input',renderPrivateCallPicker);
  qsa('[data-close-dialog]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.closeDialog).close()));
  qsa('#settings-tabs [data-tab]').forEach(button=>button.addEventListener('click',()=>setSettingsTab(button.dataset.tab)));
  $('message-list').innerHTML='<div class="tool-empty"><strong>Welcome back.</strong><span>Catch up with your community.</span></div>';
});
await fs.mkdir(screenshots,{recursive:true});
// Cache empty histories so openView exercises real rendering without production reads.
await page.evaluate(()=>{
  for(const key of ['c:general','dm:dm-1','dm:dm-2','dm:group-1']){msgCache.set(key,[]);hasMoreMap.set(key,false);}
  profiles.get('alice').display_name='Alexandra Long Display Name';
  profiles.get('owner').sub_role='sample_badge';me.sub_role='sample_badge';
  applySubroleCatalog([...subroles,{slug:'sample_badge',label:'Good Boy',color:'#00ff40',position:99}]);
  renderSubroleButton();
});

const capture=async name=>{await page.screenshot({path:path.join(screenshots,name+'.png')});};
const fit=async selector=>page.locator(selector).evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,rect:el.getBoundingClientRect().toJSON()}));
// Every header state uses the same action geometry, including Block DMs.
for(const [theme,width,height] of [['midnight',1440,1000],['midnight',1024,768],['midnight',768,1024],['midnight',390,844],['midnight',320,720],['monolight',1440,1000],['monolight',390,844]]){
  await page.setViewportSize({width,height});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.evaluate(theme=>applyTheme(theme),theme);
  for(const mode of ['channel','dm','blocked','group','voice','forum']){
    await page.evaluate(async mode=>{
      dmBlockedUsers.clear();
      if(mode==='channel')await openView({type:'channel',id:'general'});
      if(mode==='dm'||mode==='blocked'){
        if(mode==='blocked')dmBlockedUsers.add('alice');
        await openView(dmView(dms.find(dm=>dm.id==='dm-1')));
      }
      if(mode==='group')await openView(dmView(dms.find(dm=>dm.id==='group-1')));
      if(mode==='voice')openVoiceRoom({type:'channel',id:'voice-chat'});
      if(mode==='forum')await openView({type:'forum',id:'bugs'});
    },mode);
    const header=await page.locator('.channel-header').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}));
    assert(await page.locator('#channel-title').evaluate(el=>el.clientWidth>=Math.min(40,el.scrollWidth)),`${mode} title stays readable at ${width}`);
    assert(header.left>=-1&&header.right<=width+1,`${mode} header stays inside ${width}px viewport: ${header.right}`);
    assert(header.scroll<=header.width+1,`${mode} toolbar fits ${theme} ${width}: ${header.scroll}>${header.width}`);
    const controls=await page.locator('.header-actions > button:visible').evaluateAll(buttons=>buttons.map(button=>{const s=getComputedStyle(button);return {id:button.id,height:button.getBoundingClientRect().height,radius:s.borderRadius,shadow:s.boxShadow,icons:button.querySelectorAll('svg').length,right:button.getBoundingClientRect().right};}));
    for(const control of controls){assert(control.right<=width+1,`${control.id} is visible at ${width}`);assert.equal(control.height,36,`${mode}/${width} ${control.id} has standard height`);assert.equal(control.radius,width<=600?'8px':'9px');assert.equal(control.shadow,'none');assert.equal(control.icons,1,`${control.id} keeps its icon`);}
    assert.equal(await page.locator('#dm-block-btn').isVisible(),['dm','blocked'].includes(mode));
    assert.equal(await page.locator('#group-details-btn').isVisible(),mode==='group');
    if(mode==='dm'||mode==='blocked'){
      const label=mode==='blocked'?'Unblock DMs':'Block DMs';
      assert.equal(await page.locator('#dm-block-label').textContent(),label);
      assert.equal(await page.locator('#dm-block-btn').getAttribute('title'),label);
      assert.equal(await page.locator('#dm-block-btn').getAttribute('aria-pressed'),String(mode==='blocked'));
    }
    if(width===1440||width===390)await capture(`header-${theme}-${width}-${mode}`);
  }
}
await page.setViewportSize({width:1440,height:1000});
await page.evaluate(async()=>{applyTheme('midnight');await openView({type:'channel',id:'general'});});

// Call chooser searches correctly and explains why a one-member group cannot call.
await page.evaluate(()=>openPrivateCallPicker());
assert.equal(await page.locator('[data-call-conversation]').count(),4);
assert.equal(await page.locator('[data-call-conversation="solo"]').isDisabled(),true);
await capture('calls-desktop');
await page.locator('#private-call-search').fill('Weekend');
assert.equal(await page.locator('[data-call-conversation]').count(),1);
await page.locator('#private-call-search').fill('nothing-matches');
assert.match(await page.locator('#private-call-list').innerText(),/No matching/);
await page.evaluate(()=>$('private-call-dialog').close());
// Group selections survive filtering, can be removed, and enable valid actions only.
await page.evaluate(()=>openGroupDialog());
assert.equal(await page.locator('#group-create').isDisabled(),true);
await page.locator('#group-name').fill('Study break');
await page.locator('[data-group-person="bob"]').check();
await page.locator('#group-search').fill('Gray');
assert.equal(await page.locator('[data-group-unselect="bob"]').count(),1);
assert.equal(await page.locator('#group-create').isDisabled(),false);
await page.locator('#group-search').fill('');
await capture('groups-desktop');
await page.locator('[data-group-unselect="bob"]').click();
assert.equal(await page.locator('#group-create').isDisabled(),true);
await page.evaluate(()=>$('group-dialog').close());
// Pending invitations reserve capacity before the list becomes interactive.
await page.evaluate(()=>{
  window.groupFetch=new Promise(resolve=>window.resolveGroupFetch=resolve);
  void openGroupDialog('group-1');
});
assert.equal(await page.locator('#group-send-invites').isDisabled(),true);
assert.equal(await page.locator('[data-group-person]:not(:disabled)').count(),0);
await page.evaluate(()=>{window.resolveGroupFetch({data:Array.from({length:13},(_,i)=>({invitee:'pending-'+i}))});window.groupFetch=null;});
await page.waitForFunction(()=>document.getElementById('group-selection-count').textContent === '0 of 0 people selected');
assert.equal(await page.locator('[data-group-person]:not(:disabled)').count(),0);
await page.evaluate(()=>$('group-dialog').close());
await page.evaluate(()=>openSettings('admin'));
await page.waitForSelector('#staff-nav-analytics');
await capture('staff-desktop');
await page.locator('#staff-nav-analytics').click();
await page.waitForSelector('.analytics-view');
await capture('analytics-desktop');
await page.locator('#tab-admin [data-analytics-bar]').nth(9).focus();
assert.match(await page.locator('#tab-admin .analytics-inspector').innerText(),/2026-09-10/);
await page.locator('#tab-admin [data-analytics-series]').selectOption('accounts');
assert.match(await page.locator('#tab-admin [data-analytics-bar]').first().getAttribute('aria-label'),/not tracked/);
await page.evaluate(()=>{window.rpcFailure=true;});
await page.locator('#tab-admin [data-analytics-refresh]').click();
await page.waitForFunction(()=>document.querySelector('#tab-admin [data-analytics-status]').textContent.includes('previous'));
assert.equal(await page.locator('#tab-admin .analytics-view').count(),1);
await page.evaluate(()=>{window.rpcFailure=false;setSettingsTab('owner');});
await page.waitForSelector('#owner-nav-roles');
await page.locator('#owner-nav-roles').click();
await capture('owner-desktop');
await page.evaluate(()=>{$('settings-dialog').close();renderSubroleDialog();$('subrole-dialog').showModal();});
await capture('subroles-desktop');
await page.evaluate(()=>{$('subrole-dialog').close();openVoiceRoom({type:'channel',id:'voice-chat'});});
await capture('voice-desktop');
// Responsive layouts: no dialog overflows at narrow phone and Chromebook widths.
for(const [width,height] of [[390,844],[768,1024],[1366,768]]){
  await page.setViewportSize({width,height});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  for(const surface of ['calls','groups','staff','owner','subroles']){
    await page.evaluate(async surface=>{
      qsa('dialog[open]').forEach(d=>d.close());
      if(surface==='calls'){currentView={type:'channel',id:'general'};openPrivateCallPicker();}
      if(surface==='groups')await openGroupDialog('group-1');
      if(surface==='staff')openSettings('admin');
      if(surface==='owner')openSettings('owner');
      if(surface==='subroles'){renderSubroleDialog();$('subrole-dialog').showModal();}
    },surface);
    await page.waitForTimeout(50);
    const box=await fit('dialog[open]');
    assert(box.rect.x>=0&&box.rect.right<=width+1,`${surface} fits ${width}`);
    assert(box.scroll<=box.width+1,`${surface} content fits ${width}: ${box.scroll}>${box.width}`);
    if(width===390){
      if(surface==='groups')assert(await page.locator('#group-members .group-person > span:not(.avatar)').nth(1).evaluate(el=>el.getBoundingClientRect().width)>=80,'mobile group names keep readable width');
      await capture(surface+'-mobile');
    }
  }
}
// Check bright themes and the voice stage as well as the dialogs.
await page.setViewportSize({width:1440,height:1000});
await page.evaluate(()=>{qsa('dialog[open]').forEach(d=>d.close());applyTheme('monolight');openPrivateCallPicker();});
await capture('calls-light');
await page.evaluate(()=>{$('private-call-dialog').close();openSettings('owner');});
await capture('owner-light');
await page.evaluate(()=>{$('settings-dialog').close();openVoiceRoom({type:'channel',id:'voice-chat'});});
await capture('voice-light');
await page.setViewportSize({width:390,height:844});
assert(await page.locator('#vc-stage').evaluate(el=>el.scrollWidth<=el.clientWidth),'mobile voice stage fits');
await capture('voice-mobile');
assert.deepEqual(errors,[]);
console.log('Browser checks passed: call search/availability, group selections and pending capacity, Staff/Owner navigation, analytics keyboard details and stale-data recovery, 42 header view/theme/width checks, plus 15 responsive dialog checks.');
await browser.close();
