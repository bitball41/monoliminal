import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const chat = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
const migration = await readFile(new URL('../Backend/migrations/20261025222612_chat_name_styles.sql', import.meta.url), 'utf8');
const section = (start, end) => chat.slice(chat.indexOf(start), chat.indexOf(end, chat.indexOf(start)));
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
function names() {
  const context = vm.createContext({esc, profileOf: username => ({username,display_name:username}),
    displayNameOf: profile => profile?.display_name || profile?.username || 'Unknown user'});
  vm.runInContext(section('    const NAME_FONTS =', '    /* ============================= 6. SUPABASE'), context);
  return context;
}
const style = {font:'mono',effect:'shift',from:'#aabbcc',to:'#ff0099',speed:'slow'};

test('untrusted profile styling cannot inject markup, CSS, URLs or prototype keys', () => {
  const n = names();
  for (const raw of [null, [], 'broken JSON', {font:'__proto__',effect:'<script>',from:'red;position:fixed',to:'url(https://evil.test)',speed:'constructor'}]) {
    const html = n.displayNameHtml({username:'" onmouseover="bad',display_name:'<img src=x onerror=bad>',name_style:raw});
    assert.doesNotMatch(html, /<img|<script|position:fixed|url\(|name-font-__proto__|name-effect-<|name-speed:undefined/);
    assert.match(html, /&lt;img/);
    assert.match(html, /data-name-user="&quot; onmouseover=&quot;bad"/);
  }
  const html = n.displayNameHtml({username:'alice',display_name:'Alice',name_style:style});
  assert.match(html,/name-font-mono name-effect-shift/);
  assert.match(html,/--name-speed:10s/);
});

test('equivalent JSON profiles do not rebuild timelines or restart name animations', () => {
  const n = names();
  const profile = {username:'alice',name_style:{...style},staff_role:'member'};
  Object.assign(n,{profiles:new Map([['alice',profile]]),isHiddenBot:()=>false,staffRoleOf:p=>p.staff_role,me:null});
  vm.runInContext(section('    function handleProfileChange(', '    function refreshTimelineForAuthor('),n);
  // Every later UI dependency is deliberately absent: an unchanged update must return first.
  assert.doesNotThrow(()=>n.handleProfileChange({new:{...profile,name_style:{...style}}}));
});

test('name styling is self-only even with permissive legacy RLS; invalid payloads are rejected', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth; create schema private;
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth,private to authenticated,anon;
      create table public.profiles(username text primary key,user_id uuid,is_banned boolean default false);
      insert into profiles values ('alice','11111111-1111-1111-1111-111111111111',false),('bob','22222222-2222-2222-2222-222222222222',false);
      alter table profiles enable row level security;
      create policy legacy_read on profiles for select using(true);
      create policy legacy_update on profiles for update using(true) with check(true);
      grant select,update on profiles to authenticated;`);
    await db.exec(migration);
    await db.exec("set role authenticated; select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false)");
    await db.query("update profiles set name_style=$1::jsonb where username='alice'", [JSON.stringify(style)]);
    assert.deepEqual((await db.query("select name_style from profiles where username='alice'")).rows[0].name_style,style);
    await assert.rejects(db.query("update profiles set name_style=$1::jsonb where username='bob'",[JSON.stringify(style)]), /only change your own/);
    for (const invalid of [[],null,{...style,css:'color:red'},{...style,from:'red'},{...style,to:'#00000000'},{...style,font:'url(bad)'},{...style,effect:null},{...style,speed:0}, {font:'mono'}]) {
      await assert.rejects(db.query("update profiles set name_style=$1::jsonb where username='alice'",[JSON.stringify(invalid)]), /profiles_name_style_check/);
    }
    await db.exec("update profiles set name_style='{}' where username='alice'; reset role; update profiles set is_banned=true where username='alice'; set role authenticated");
    await assert.rejects(db.query("update profiles set name_style=$1::jsonb where username='alice'",[JSON.stringify(style)]), /only change your own/);
    await db.exec("reset role; set role anon");
    await assert.rejects(db.query("update profiles set name_style='{}'"), /permission denied/);
  } finally {await db.close();}
});
