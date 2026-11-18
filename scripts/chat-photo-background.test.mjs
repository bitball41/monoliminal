import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('../Chat/chat.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('    const CHAT_BACKGROUNDS = {'), html.indexOf('    function compileBackgroundShader('));
const settle = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
function setup(records = new Map(), preferences = new Map()) {
  let serial = 0, storageError = null;
  const revoked = [], nodes = new Map(), timers = new Map(), writes = [], canvases = [];
  function element() {
    const children = [], props = new Map(), classes = new Set();
    return { hidden: false, value: '', disabled: false, textContent: '', dataset: {}, children,
      classList: { add: n => classes.add(n), remove: n => classes.delete(n) },
      style: { setProperty: (k,v) => props.set(k,v), removeProperty: k => props.delete(k) },
      setAttribute(k,v) { this[k]=v; }, removeAttribute(k) { delete this[k]; },
      append(n) { children.push(n); n.remove = () => { const i=children.indexOf(n); if(i>=0) children.splice(i,1); }; },
      replaceChildren() { children.length=0; }, querySelector: () => children[0], click() { this.clicked = true; } };
  }
  const $ = id => { if(!nodes.has(id)) nodes.set(id,element()); return nodes.get(id); };
  const c = vm.createContext({ Blob, Promise, Map, Object, Number, String, Math, console,
    me: { username: 'alice' }, settings: { theme: 'corazon' }, THEMES: { corazon: {}, fall: { background:'autumnLeaves' } },
    URL: { createObjectURL: () => `blob:photo-${++serial}`, revokeObjectURL: url => revoked.push(url) },
    $ , qsa: () => [], window: {},
    LS: { get: (k,f) => preferences.has(k) ? preferences.get(k) : f, set: (k,v) => preferences.set(k,v) },
    setTimeout: fn => { const id=++serial;timers.set(id,fn);return id; }, clearTimeout: id=>timers.delete(id),
    loadImageFile: async () => ({ naturalWidth:3840,naturalHeight:2160 }),
    document: { createElement: tag => {
      const el=element();
      if(tag==='canvas') { canvases.push(el);el.getContext=()=>({fillRect(){},drawImage(){}});el.toBlob=fn=>fn(new Blob(['compressed image'],{type:'image/jpeg'})); }
      return el;
    } },
    createWebGLBackground: () => ({destroy(){},updateTheme(){}}), createDotFieldBackground: () => ({destroy(){}}),
  });
  vm.runInContext(source,c);
  c.photoBackgroundStore = async (action,owner,value) => {
    if(storageError && action==='put') throw storageError;
    if(action==='get') return records.get(owner);
    writes.push({action,owner,value});
    if(action==='delete') records.delete(owner); else records.set(owner,value);
  };
  return {c,$,nodes,records,preferences,revoked,canvases,writes,timers,
    error: e=>storageError=e,
    flush: async()=>{for(const fn of [...timers.values()]) fn();timers.clear();await settle();},
    state: ()=>vm.runInContext('({choice:chatBackgroundChoice,owner:photoBackgroundOwner,photo:photoBackground,url:photoBackgroundUrl})',c)};
}
const file = {type:'image/png',size:1024};

test('choosing a photo creates a static personal background, saves a bounded image and restores after reopening', async()=>{
  const r=setup();
  await r.c.uploadPhotoBackground(file);
  assert.equal(r.state().choice,'photo');assert.equal(r.records.get('alice').blob.type,'image/jpeg');
  assert.equal(r.canvases[0].width,1920);assert.equal(r.canvases[0].height,1080);
  assert.equal(r.$('chat-background-stage').children.length,1);
  assert.equal(r.$('photo-background-preview-wrap').hidden,false);
  assert.equal(r.timers.size,0,'static photos schedule no animation');
  const next=setup(r.records,r.preferences);next.c.restoreChatBackground();await settle();
  assert.equal(next.state().choice,'photo');assert.equal(next.$('chat-background-stage').children.length,1);
  r.c.chooseChatBackground('off');assert.equal(r.$('chat-background-stage').children.length,0);
  r.c.restoreChatBackground();await settle();assert.equal(r.state().choice,'off','saved Off does not re-enable the photo');
});

test('photo controls save dimming, fit and crop position; removing clears the photo without affecting another background',async()=>{
  const r=setup();await r.c.uploadPhotoBackground(file);
  r.$('photo-background-dim').value='65';r.$('photo-background-position').value='20';r.$('photo-background-fit').value='contain';
  r.c.changePhotoBackgroundAppearance();await r.flush();
  assert.equal(r.records.get('alice').dim,65);assert.equal(r.records.get('alice').position,20);assert.equal(r.records.get('alice').fit,'contain');
  r.c.chooseChatBackground('autumnLeaves');await r.c.removePhotoBackground();
  assert.equal(r.state().choice,'autumnLeaves');assert.equal(r.records.has('alice'),false);assert.equal(r.$('photo-background-preview-wrap').hidden,true);
  assert(r.revoked.length>0,'removed photo URLs are released');
});

test('accounts on one browser do not inherit another account photo or a late image decode',async()=>{
  const r=setup();await r.c.uploadPhotoBackground(file);r.c.stopChatBackground();r.c.resetPhotoBackgroundState();
  r.c.me={username:'bob'};r.c.restoreChatBackground();await settle();
  assert.equal(r.state().photo,null);assert.equal(r.state().choice,'off');assert.equal(r.$('photo-background-preview-wrap').hidden,true);
  let resolveDecode;r.c.loadImageFile=()=>new Promise(resolve=>resolveDecode=resolve);
  const pending=r.c.uploadPhotoBackground(file);r.c.resetPhotoBackgroundState();r.c.me={username:'carol'};
  resolveDecode({naturalWidth:640,naturalHeight:480});await pending;
  assert.equal(r.records.has('carol'),false);assert.equal(r.records.has('bob'),false);assert.equal(r.state().photo,null);
});

test('a late restore cannot override a later Off choice or reveal the previous account photo',async()=>{
  const r=setup();await r.c.uploadPhotoBackground(file);
  let resolveRead;r.c.photoBackgroundStore=()=>new Promise(resolve=>resolveRead=resolve);
  r.c.restoreChatBackground();await settle();r.c.chooseChatBackground('off');resolveRead(r.records.get('alice'));await settle();
  assert.equal(r.state().choice,'off');
  r.c.restoreChatBackground();await settle();r.c.resetPhotoBackgroundState();r.c.me={username:'bob'};
  resolveRead(r.records.get('alice'));await settle();assert.equal(r.state().photo,null);
});

test('invalid images and storage failures preserve the current photo and report an actionable error',async()=>{
  const r=setup();await r.c.uploadPhotoBackground(file);const url=r.state().url;
  await r.c.uploadPhotoBackground({type:'image/svg+xml',size:12});assert.equal(r.state().url,url);
  await r.c.uploadPhotoBackground({type:'image/jpeg',size:16*1024*1024});assert.equal(r.state().url,url);
  r.error(Object.assign(new Error('full'),{name:'QuotaExceededError'}));await r.c.uploadPhotoBackground(file);
  assert.equal(r.state().url,url);assert.equal(r.state().choice,'photo');assert.match(r.$('photo-background-message').textContent,/storage is full/);
  assert.equal(r.$('photo-background-upload').disabled,false);
});

test('switching away from an active photo releases its renderer without deleting the saved photo',async()=>{
  const r=setup();await r.c.uploadPhotoBackground(file);
  r.c.chooseChatBackground('off');assert.equal(r.$('chat-background-stage').children.length,0);assert(r.records.has('alice'));
  r.c.chooseChatBackground('photo');assert.equal(r.$('chat-background-stage').children.length,1);
  await r.c.removePhotoBackground();assert.equal(r.state().choice,'off');assert.equal(r.records.has('alice'),false);
});

test('finishing an upload respects a newer Off selection',async()=>{
  const r=setup();let resolveDecode;
  r.c.loadImageFile=()=>new Promise(resolve=>resolveDecode=resolve);
  const pending=r.c.uploadPhotoBackground(file);
  r.c.chooseChatBackground('off');
  resolveDecode({naturalWidth:640,naturalHeight:480});await pending;
  assert(r.records.has('alice'),'the requested photo is still saved');
  assert.equal(r.state().choice,'off','a late save must not override the newer explicit choice');
});

test('blur and horizontal crop are saved, clamped, applied to the live photo and restored',async()=>{
  const r=setup();await r.c.uploadPhotoBackground(file);
  assert.equal(r.state().photo.blur,0,'new photos start sharp');assert.equal(r.state().photo.x,50);
  r.$('photo-background-blur').value='8';r.$('photo-background-position-x').value='15';
  r.c.changePhotoBackgroundAppearance();await r.flush();
  assert.equal(r.records.get('alice').blur,8);assert.equal(r.records.get('alice').x,15);
  const live=r.$('chat-background-stage').children[0];
  assert.equal(live.style.objectPosition,'15% 50%');assert.equal(live.style.filter,'blur(8px)');
  assert.match(live.style.transform,/^scale\(1\.0\d+\)$/,'blurred edges stay off screen');
  assert.equal(r.$('photo-background-blur-value').textContent,'8 px');
  // Older saved photos have no blur or x; out-of-range values are clamped.
  r.records.set('alice',{...r.records.get('alice'),blur:99,x:-5});
  const next=setup(r.records,r.preferences);next.c.restoreChatBackground();await settle();
  assert.equal(next.state().photo.blur,24);assert.equal(next.state().photo.x,0);
  const { blur, x, ...legacy } = r.records.get('alice');r.records.set('alice',legacy);
  const old=setup(r.records,r.preferences);old.c.restoreChatBackground();await settle();
  assert.equal(old.state().photo.blur,0);assert.equal(old.state().photo.x,50);
  assert.equal(old.$('photo-background-blur-value').textContent,'Off');
});

test('an uploaded GIF is kept as is, so the background stays animated, and restores after reopening',async()=>{
  const r=setup();
  const gif=new Blob(['GIF89a animated frames'],{type:'image/gif'});
  await r.c.uploadPhotoBackground(gif);
  assert.equal(r.state().choice,'photo');
  const saved=r.records.get('alice').blob;
  assert.equal(saved.type,'image/gif');assert.equal(saved.size,gif.size);
  assert.equal(r.canvases.length,0,'GIFs are not redrawn into a still JPEG');
  assert.match(r.$('photo-background-message').textContent,/GIF saved/);
  const next=setup(r.records,r.preferences);next.c.restoreChatBackground();await settle();
  assert.equal(next.state().choice,'photo');assert.equal(next.state().photo.blob.type,'image/gif');
  assert.equal(next.$('chat-background-stage').children.length,1);
});

test('a GIF from the picker is saved by address, survives setting changes and reopening, and is never revoked',async()=>{
  const r=setup();const url='https://static.klipy.com/ii/abc/dancing.gif';
  await r.c.choosePhotoBackgroundGif(url);
  assert.equal(r.state().choice,'photo');assert.equal(r.state().url,url);
  assert.deepEqual(Object.keys(r.records.get('alice')).sort(),['blur','dim','fit','position','url','x']);
  assert.equal(r.$('chat-background-stage').children[0].src,url);
  r.$('photo-background-dim').value='70';r.c.changePhotoBackgroundAppearance();await r.flush();
  assert.equal(r.records.get('alice').url,url);assert.equal(r.records.get('alice').dim,70);
  const next=setup(r.records,r.preferences);next.c.restoreChatBackground();await settle();
  assert.equal(next.state().url,url);assert.equal(next.$('chat-background-stage').children.length,1);
  await r.c.removePhotoBackground();
  assert.equal(r.records.has('alice'),false);assert(!r.revoked.includes(url),'a remote GIF address is not an object URL');
});

test('only https GIF addresses are accepted; a bad one keeps the current background',async()=>{
  const r=setup();await r.c.uploadPhotoBackground(file);const current=r.state().url;
  for(const bad of ['javascript:alert(1)','http://example.com/a.gif','https://x.test/a.gif" onerror="x','', 'https://'+'a'.repeat(2050)]){
    await r.c.choosePhotoBackgroundGif(bad);
    assert.equal(r.state().url,current);
  }
  assert.match(r.$('photo-background-message').textContent,/could not be used/);
  assert.equal(r.c.setPhotoBackgroundRecord('alice',{url:'data:image/gif;base64,AAAA'}),false);
});
