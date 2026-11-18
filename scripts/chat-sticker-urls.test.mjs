// Stickers and media must be hosted files, never one browser tab's blob: link.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const file = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const FIX = '20261117232947_reject_local_media_urls.sql';

test('broken blob stickers and their messages are removed, and new local links are rejected', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(await file('Backend/tests/authorization-fixture.sql'));
    const names = (await readdir(new URL('../Backend/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort();
    for (const name of names.filter(n => n < FIX)) await db.exec(await file('Backend/migrations/' + name));
    await db.exec(await file('Backend/tests/authorization-triggers.sql'));
    await db.exec(`insert into public.channels(id,label) values('general','general');
      insert into public.profiles(username,display_name) values('alice','alice');
      insert into public.public_stickers(name,url,added_by) values
        ('broken','blob:null/e4b0a158-63bf-40ec-93f6-9b792001544e','alice'),
        ('hosted','https://example.supabase.co/storage/v1/object/public/liminal-stickers/sticker/a.png','alice'),
        ('inline','data:image/png;base64,iVBORw0KGgo=','alice');
      select set_config('app.chat_admin_delete','true',false);
      insert into public.messages(channel_id,sender,content,type,media_url) values
        ('general','alice','','sticker','blob:null/e4b0a158-63bf-40ec-93f6-9b792001544e'),
        ('general','alice','','sticker','https://example.supabase.co/storage/v1/object/public/liminal-stickers/sticker/a.png');
      select set_config('app.chat_admin_delete','false',false);`);
    await db.exec(await file('Backend/migrations/' + FIX));
    assert.deepEqual((await db.query('select name from public.public_stickers order by name')).rows.map(r => r.name), ['hosted', 'inline']);
    assert.deepEqual((await db.query(`select media_url ~ '^blob:' blob, deleted, deleted_by from public.messages order by media_url`)).rows,
      [{ blob: true, deleted: true, deleted_by: 'system' }, { blob: false, deleted: false, deleted_by: null }]);
    await assert.rejects(db.query(`insert into public.public_stickers(name,url,added_by) values('x','blob:https://chat/abc','alice')`), /public_stickers_url_hosted/);
    await db.exec(`select set_config('app.chat_admin_delete','true',false)`);
    await assert.rejects(db.query(`insert into public.messages(channel_id,sender,content,type,media_url) values('general','alice','','sticker','BLOB:null/x')`), /messages_media_url_not_local/);
  } finally { await db.close(); }
});

test('saving a local image as a sticker uploads the file instead of storing its link', async () => {
  const html = await file('Chat/chat.html');
  const start = html.indexOf('    function isLocalMediaUrl(url)');
  const source = html.slice(start, html.indexOf('    function syncLightboxSaveButton(url)'));
  const uploads = [];
  const c = vm.createContext({
    STICKER_EXT_BY_TYPE: { 'image/png': 'png' }, STICKER_FILE_MAX_BYTES: 1000, STICKER_BUCKET: 'liminal-stickers',
    fetch: async () => ({ ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) }),
    putStickerFile: async (blob, options) => { uploads.push(options); return { url: 'https://host/storage/v1/object/public/liminal-stickers/sticker/u/k__quote.png' }; },
    stickerStorageKeyFromUrl: () => null, console, Blob,
  });
  vm.runInContext(source, c);
  const url = await c.copyUrlIntoStickerBucket('blob:null/1234', { kind: 'sticker', name: 'quote alice' });
  assert.match(url, /^https:\/\//);
  assert.deepEqual(JSON.parse(JSON.stringify(uploads)), [{ kind: 'sticker', name: 'quote alice', ext: 'png' }]);
  c.fetch = async () => ({ ok: true, blob: async () => new Blob(['x'], { type: 'image/svg+xml' }) });
  await assert.rejects(c.copyUrlIntoStickerBucket('blob:null/5678', { kind: 'sticker', name: 'x' }), /cannot be a sticker/);
  assert.match(html, /if \(!\/\^https:\\\/\\\/\/i\.test\(storedUrl\)\) throw/, 'never inserts a non-hosted sticker URL');
});

test('the page lets Chat read its own blob: and data: images (quote cards saved as stickers)', async () => {
  // copyUrlIntoStickerBucket fetch()es a local link before uploading it. Without
  // blob:/data: in connect-src the browser blocks that with "Failed to fetch".
  const html = await file('Chat/chat.html');
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  const connect = csp.split(';').map(d => d.trim()).find(d => d.startsWith('connect-src')).split(/\s+/);
  assert(connect.includes('blob:'), 'connect-src allows blob:');
  assert(connect.includes('data:'), 'connect-src allows data:');
});
