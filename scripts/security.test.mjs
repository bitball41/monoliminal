import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { canResetPassword, isOwner, usernamePattern } from '../Backend/edge-functions/chat-auth/permissions.ts';

const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const authSource = await file('Backend/edge-functions/chat-auth/index.ts');
const roles = ['member','mod','manager','admin','super_mega_tuff_admin','dusty','co_owner','owner','preston'];
const rank = role => roles.slice(3,6).includes(role) ? 4 : ({member:1,mod:2,manager:3,co_owner:5,owner:6,preston:7})[role];

function authHandler(actorRole, targetRole, options = {}) {
  let handler;
  const updates = [], patterns = [], calls = [];
  const actor = { username:'actor',user_id:'actor-id',staff_role:actorRole,is_banned:options.banned || false,
    is_admin:true,is_owner:true }; // Forged legacy flags must never grant a role.
  const target = { username:'target_one',user_id:'target-id',staff_role:targetRole };
  const client = {
    auth: {getUser:async () => ({data:{user:options.invalidToken ? null : {id:actor.user_id}},error:null}),
      admin:{updateUserById:async (...args) => { updates.push(args); return {error:null}; }}},
    rpc:async (name,body) => { calls.push([name,body]); return {error:options.rpcError ? {message:'Permission denied'} : null}; },
    from() {
      let selectedActor = false;
      return {select(){return this;},eq(){selectedActor=true;return this;},
        ilike(key,value){patterns.push(value);return this;},
        async maybeSingle(){return {data:selectedActor ? actor : target,
          error:!selectedActor && options.targetError ? {message:'Unavailable'} : null};}};
    },
  };
  const context = {Request,Response,URL,TextEncoder,Uint8Array,console,crypto,
    canResetPassword,isOwner,usernamePattern,createClient:() => client,
    Deno:{env:{get:key => ({SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEYS:'{}',
      SUPABASE_SERVICE_ROLE_KEY:'fixture-server-key',SUPABASE_PUBLISHABLE_KEYS:'{"default":"fixture-public-key"}'})[key]},
      serve:fn => {handler=fn;}}};
  vm.runInNewContext(stripTypeScriptTypes(authSource.replace(/^import .*;$/gm,'')),context);
  return {updates,patterns,calls,invoke:(username='target_one') => handler(new Request('https://fixture.invalid',{
    method:'POST',headers:{apikey:'fixture-public-key',authorization:'Bearer fixture-jwt','content-type':'application/json'},
    body:JSON.stringify({action:'admin_reset_password',username,password:'fixture-password',is_owner:true,staff_role:'owner'})}))};
}

test('all password-reset role combinations obey the server hierarchy', async () => {
  for (const actor of roles) for (const target of roles) {
    const expected = rank(actor) >= 4 && rank(actor) > rank(target) && !['owner','preston'].includes(target);
    const b=authHandler(actor,target), response=await b.invoke();
    assert.equal(response.status,expected ? 200 : 403, actor+' resets '+target);
    assert.equal(b.updates.length,expected ? 1 : 0);
    assert.equal(b.calls.length,expected ? 1 : 0);
  }
});

test('invalid authentication, bans, lookup failures and revoked permissions fail before Auth writes', async () => {
  for (const options of [{invalidToken:true},{banned:true},{targetError:true},{rpcError:true}]) {
    const b=authHandler('owner','member',options);
    assert.notEqual((await b.invoke()).status,200);
    assert.equal(b.updates.length,0);
  }
  const b=authHandler('owner','member');
  assert.equal((await b.invoke('%')).status,400);
  assert.equal(b.updates.length,0);
  assert.equal((await b.invoke()).status,200);
  assert.equal(b.patterns.at(-1),'target\\_one');
  assert.equal(b.calls.at(-1)[1].p_actor_user_id,'actor-id');
});

test('unknown roles, legacy flags and self-targets do not authorize password resets', () => {
  const actor={username:'actor',user_id:'one',staff_role:'member',is_owner:true,is_admin:true};
  const target={username:'target',user_id:'two',staff_role:'member'};
  assert.equal(canResetPassword(actor,target),false);
  assert.equal(canResetPassword({...actor,staff_role:'owner'}, {...target,user_id:'one'}),false);
  assert.equal(canResetPassword({...actor,staff_role:'owner'}, {...target,staff_role:'unknown'}),false);
  assert.equal(isOwner(actor),false);
});

test('database migration rejects tampered and legacy clients while preserving normal Chat actions', async () => {
  const db=new PGlite({extensions:{pgcrypto}});
  const run=async path => {
    try {return await db.exec(await file(path));}
    catch (error) {throw new Error(path+': '+error.message+(error.where ? ' ('+error.where+')' : ''));}
  };
  try {
    await run('Backend/tests/authorization-fixture.sql');
    for (const migration of (await readdir(new URL('../Backend/migrations/',import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
      await run('Backend/migrations/'+migration);
    }
    await run('Backend/tests/authorization-triggers.sql');
    const result=await run('Backend/tests/authorization-regression.sql');
    const checks=result.find(r => r.rows?.[0]?.results)?.rows[0].results;
    assert.equal(checks?.length,80,'All SQL regression checks ran');
    for (const check of checks) assert.equal(check.passed,true,JSON.stringify(check));
    assert.equal((await db.query("select count(*)::integer n from public.profiles")).rows[0].n,0,'fixtures rolled back');
    console.log('Database authorization checks:',checks.length);
  } finally {await db.close();}
});
