// Benchmark: what the Super Mega Tuff Co-owner migrations cost the database.
// Builds two isolated databases (PGlite, no network): every migration except
// the two role migrations ("before"), and every migration ("after"), then times
// the hot paths both share plus the role's own functions.
//   node scripts/chat-super-mega-tuff.bench.mjs [rounds]
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ROUNDS = Number(process.argv[2]) || 3;
const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const ROLE_MIGRATIONS = /_chat_super_mega_tuff_co_owner(_2)?\.sql$/;

async function build(withRole) {
  const db = new PGlite({ extensions: { pgcrypto } });
  const people = { owner: 'owner', PomKnee: 'co_owner', alice: 'member', bob: 'member' };
  const ids = Object.fromEntries(Object.keys(people).map((n, i) => [n, `00000000-0000-4000-8000-0000000005${10 + i}`]));
  await db.exec(await file('Backend/tests/authorization-fixture.sql'));
  for (const name of (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
    if (!withRole && ROLE_MIGRATIONS.test(name)) continue;
    await db.exec(await file('Backend/migrations/' + name));
  }
  await db.exec(`insert into public.channels(id,label,kind,min_speak_role) values ('general','general','chat','member')`);
  await db.exec(await file('Backend/tests/authorization-triggers.sql'));
  for (const [name, role] of Object.entries(people)) {
    await db.query('insert into auth.users(id) values($1)', [ids[name]]);
    await db.query('insert into public.profiles(username,display_name,user_id,staff_role) values($1,$1,$2,$3)', [name, ids[name], role]);
  }
  if (withRole) await db.query(`update public.profiles set staff_role='super_mega_tuff_co_owner' where username='PomKnee'`);
  const as = name => db.exec(`reset role; select set_config('request.jwt.claim.sub','${ids[name]}',false); set role authenticated;`);
  return { db, as };
}

async function time(label, n, fn) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  return { label, n, msPerOp: (performance.now() - t0) / n };
}

async function run(withRole) {
  const { db, as } = await build(withRole);
  const r = [];
  try {
    // Shared paths: every member pays these.
    await as('alice');
    r.push(await time('profile update (own bio)', 300, i => db.query(`update public.profiles set bio=$1 where username='alice'`, ['bio ' + i])));
    r.push(await time('message insert (member)', 300, i => db.query(`insert into public.messages(channel_id,sender,content,type) values('general','alice',$1,'text')`, ['m' + i])));
    await as('owner');
    r.push(await time('timeout + clear (owner on member)', 100, async () => {
      await db.query(`select public.chat_staff_timeout_user('owner','', 'bob', 5)`);
      await db.query(`select public.chat_staff_timeout_user('owner','', 'bob', 0)`);
    }));
    r.push(await time('announcement (owner)', 100, i => db.query(`select public.chat_owner_set_app_setting('announcement',$1)`, ['a' + i])));
    await as('PomKnee');
    r.push(await time('message insert (PomKnee)', 300, i => db.query(`insert into public.messages(channel_id,sender,content,type) values('general','PomKnee',$1,'text')`, ['p' + i])));
    const src = (await db.query(`select id from public.messages where sender='alice' limit 1`)).rows[0].id;
    if (withRole) {
      // The role's lighter QuoteBot limits (1 s apart): age the ledger between
      // quotes, outside the timed call.
      let quoteMs = 0;
      for (let i = 0; i < 25; i++) {
        await db.exec('reset role');
        await db.query(`update private.chat_quote_requests set created_at = created_at - interval '2 minutes'`);
        await as('PomKnee');
        const t0 = performance.now();
        await db.query(`select public.chat_post_quote($1,'classic')`, [src]);
        quoteMs += performance.now() - t0;
      }
      r.push({ label: 'QuoteBot quote (PomKnee)', n: 25, msPerOp: quoteMs / 25 });
      r.push(await time('troll apply (2 effects)', 100, () => db.query(`select public.chat_troll_apply('alice', array['popups','fail_send'], 5)`)));
      r.push(await time('troll refresh', 100, () => db.query(`select public.chat_troll_refresh('alice')`)));
      r.push(await time('set check mark', 100, () => db.query(`select public.chat_set_smt_check('🔥', array['#ff0000','#00ff00'], 'spin')`)));
      r.push(await time('troll list', 100, () => db.query(`select public.chat_troll_list()`)));
      await as('alice');
      r.push(await time('my troll effects (on connect)', 300, () => db.query(`select public.chat_my_troll_effects()`)));
    }
  } finally { await db.exec('reset role'); await db.close(); }
  return r;
}

const results = { before: [], after: [] };
for (let i = 0; i < ROUNDS; i++) {
  results.before.push(await run(false));
  results.after.push(await run(true));
}
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const labels = [...new Set(results.after.flat().map(x => x.label))];
const rows = labels.map(label => {
  const pick = side => results[side].map(rs => rs.find(x => x.label === label)?.msPerOp).filter(x => x != null);
  const before = pick('before'), after = pick('after');
  return { label, before: before.length ? +median(before).toFixed(3) : null, after: +median(after).toFixed(3),
    change: before.length ? `${(((median(after) / median(before)) - 1) * 100).toFixed(0)}%` : 'new' };
});
console.table(rows);
console.log(`median of ${ROUNDS} rounds, ms per operation, PGlite in-process (relative numbers only)`);
