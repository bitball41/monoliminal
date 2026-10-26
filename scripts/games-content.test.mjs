import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const read = p => readFile(new URL('../'+p,import.meta.url),'utf8');
const games = await read('Games/games.html');
const dashboard = await read('Admin/liminal-admin-dashboard.html');
const migration = await read('Backend/migrations/20261026001714_games_page_content.sql');

function publicHarness(initial) {
  class Element {
    constructor(){this.hidden=true;this.children=[];this.handlers={};}
    appendChild(child){this.children.push(child);}
    replaceChildren(){this.children=[];}
    get childElementCount(){return this.children.length;}
    setAttribute(){}
    addEventListener(name,fn){this.handlers[name]=fn;}
  }
  const fields=Object.fromEntries(['games-updates','games-announcement','games-announcement-text','games-links','games-link-grid','games-dismiss'].map(id=>[id,new Element()]));
  const storage=new Map(), events={}, pending=[]; let now=100000, content=initial, failed=false, requests=0, tick;
  const context={URL,JSON,String,Array,AbortController,Date:{now:()=>now},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    document:{hidden:false,getElementById:id=>fields[id],createElement:()=>new Element(),addEventListener:(n,fn)=>events[n]=fn},
    window:{addEventListener:(n,fn)=>events[n]=fn},setTimeout:()=>1,clearTimeout(){},setInterval:fn=>tick=fn,
    fetch:async()=>{requests++;if(failed)throw new Error('offline');return {ok:true,json:async()=>[{value:JSON.stringify(content)}]};}};
  vm.runInNewContext(games.match(/<script id="gamesPageContent">([\s\S]*?)<\/script>/)[1],context);
  return {fields,context,requests:()=>requests,storage,fail:()=>failed=true,async flush(){await new Promise(r=>setImmediate(r));},async update(value){content=value;now+=120000;tick();await this.flush();},events};
}
test('public content displays literal text, safe links and remembers dismissal until the text changes', async()=>{
  const h=publicHarness({announcement:'<img src=x onerror=alert(1)>',links:[{label:'Survey',url:'https://example.com/?x=1&y=2',description:'Tell us what you think'},{label:'Unsafe',url:'javascript:alert(1)'},{label:'Credentials',url:'https://u:p@example.com'}]});
  await h.flush();const f=h.fields;
  assert.equal(f['games-announcement-text'].textContent,'<img src=x onerror=alert(1)>');
  assert.equal(f['games-link-grid'].children.length,1);
  assert.equal(f['games-link-grid'].children[0].rel,'noopener noreferrer');
  f['games-dismiss'].handlers.click();assert.equal(f['games-announcement'].hidden,true);assert.equal(f['games-updates'].hidden,false);
  await h.update({announcement:'<img src=x onerror=alert(1)>',links:[]});assert.equal(f['games-updates'].hidden,true);
  await h.update({announcement:'Updated',links:[]});assert.equal(f['games-announcement'].hidden,false);
  h.fail();await h.update({});assert.equal(f['games-announcement-text'].textContent,'Updated');
});
test('empty content stays hidden and focus events are throttled',async()=>{
  const h=publicHarness({announcement:'',links:[]});await h.flush();
  assert.equal(h.fields['games-updates'].hidden,true);
  h.events.focus();h.events.visibilitychange();await h.flush();assert.equal(h.requests(),1);
});
function editorHarness() {
  const fields=Object.fromEntries(['games-page-announcement','games-page-count','games-page-preview','games-page-link-editor','games-page-add-link','games-page-publish','games-page-clear','games-page-save-status'].map(id=>[id,{value:'',addEventListener(n,fn){this[n]=fn;},focus(){}}]));
  const writes=[];let fail=false,resolve;
  const c=vm.createContext({$:id=>fields[id] || {focus(){}},URL,JSON,Number,Array,String,
    state:{settings:{}},admin:{is_owner:true,token:'fixture'},esc:v=>String(v).replaceAll('"','&quot;'),toast(){},
    rpc:async(n,p)=>{writes.push([n,p]);if(fail)throw new Error('offline');if(resolve)await new Promise(resolve);return p.p_content;}});
  const start=dashboard.indexOf('    let gamesPageDraft =');
  vm.runInContext(dashboard.slice(start,dashboard.indexOf('    async function setSetting(',start)),c);
  vm.runInContext('renderGamesPage()',c);
  return {c,fields,writes,setFailure(){fail=true;},defer(){let done;resolve=fn=>done=fn;return ()=>done();}};
}
test('editor protects drafts during refresh, preserves failed saves and publishes atomically',async()=>{
  const h=editorHarness();h.fields['games-page-announcement'].value='New announcement';h.fields['games-page-announcement'].input();
  vm.runInContext('renderGamesPage()',h.c);assert.equal(h.fields['games-page-announcement'].value,'New announcement');
  h.fields['games-page-add-link'].click();
  vm.runInContext('gamesPageDraft.links[0]={label:"Survey",url:"https://example.com",description:"Feedback"}',h.c);
  await h.fields['games-page-publish'].click();assert.equal(h.writes.length,1);assert.equal(h.writes[0][0],'admin_dashboard_set_games_content');
  assert.equal(JSON.parse(h.c.state.settings.games_page_content).links[0].label,'Survey');
  h.fields['games-page-announcement'].value='Keep this draft';h.fields['games-page-announcement'].input();h.setFailure();
  await h.fields['games-page-publish'].click();vm.runInContext('renderGamesPage()',h.c);assert.equal(h.fields['games-page-announcement'].value,'Keep this draft');
});
test('edits made during a publish are retained and unsafe URLs are rejected before RPC',async()=>{
  const h=editorHarness();h.fields['games-page-announcement'].value='First';h.fields['games-page-announcement'].input();
  const release=h.defer(),save=h.fields['games-page-publish'].click();
  h.fields['games-page-announcement'].value='Second';h.fields['games-page-announcement'].input();release();await save;
  assert.equal(h.fields['games-page-announcement'].value,'Second');
  h.fields['games-page-add-link'].click();vm.runInContext('gamesPageDraft.links[0]={label:"Bad",url:"javascript:alert(1)",description:""}',h.c);
  await h.fields['games-page-publish'].click();assert.equal(h.writes.length,1);
});

test('database publication requires an owner session, validates content, and commits one audited setting',async()=>{
  const db=new PGlite();try{
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA private;
      CREATE TABLE public.app_settings(key text PRIMARY KEY,value text,updated_at timestamptz DEFAULT now());
      ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.app_settings TO anon,authenticated;
      CREATE POLICY public_read ON public.app_settings FOR SELECT TO anon,authenticated USING(true);
      CREATE TABLE private.chat_admin_audit(actor_username text,action text,target text,details jsonb);
      CREATE FUNCTION private.require_chat_admin(token text,owner_only boolean) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN IF owner_only IS DISTINCT FROM true OR token NOT IN ('owner','preston') OR token IS NULL THEN RAISE EXCEPTION 'Owner access is required'; END IF; RETURN token; END $$;`);
    await db.exec(migration);
    const save=(token,content)=>db.query('select public.admin_dashboard_set_games_content($1,$2::jsonb) content',[token,JSON.stringify(content)]);
    const content={announcement:' Hello ',links:[{label:' Survey ',url:'https://example.com',description:' Feedback '}]};
    for(const token of [null,'member','admin','co_owner','expired'])await assert.rejects(save(token,content),/Owner access/);
    await db.exec('SET ROLE anon');await assert.rejects(save('owner',content),/permission denied/);await db.exec('RESET ROLE');
    for(const invalid of [null,{}, {announcement:'a'.repeat(1001),links:[]}, {announcement:'',links:Array(13).fill(content.links[0])},
      ...['javascript:alert(1)','data:text/html,hello','//example.com','https://u:p@example.com','https://example.com\\@evil.com','https://example.com/ bad'].map(url=>({announcement:'',links:[{label:'Bad',url}]}))])await assert.rejects(save('owner',invalid));
    for(const token of ['owner','preston'])assert.equal((await save(token,content)).rows[0].content.announcement,'Hello');
    assert.equal((await db.query('select count(*)::int n from private.chat_admin_audit')).rows[0].n,2);
    await db.exec('SET ROLE authenticated');await assert.rejects(db.exec("update public.app_settings set value='{}'"),/permission denied/);await db.exec('RESET ROLE');
    assert.equal((await db.query("select value::jsonb->'links'->0->>'label' label from public.app_settings where key='games_page_content'")).rows[0].label,'Survey');
  }finally{await db.close();}
});
