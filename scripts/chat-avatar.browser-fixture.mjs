// A native-browser probe made from the production image loader, not a DOM mock.
// Serve temporarily on the project's HTTPS origin with capability authorization.
export function buildAvatarProbe({chat, avatar, secondAvatar, projectUrl, cacheName}) {
  const from=chat.indexOf('    const AVATAR_CACHE ='),to=chat.indexOf('    function avatarHtml(',from);
  if(from<0 || to<from) throw new Error('Avatar loader not found');
  const loader=chat.slice(from,to).replace("'liminal-avatars-v1'",JSON.stringify(cacheName));
  const script=`
const runtimeSupabaseUrl=${JSON.stringify(projectUrl)};
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const initialsOf=s=>(s||'?').slice(0,2);
${loader}
const avatar=${JSON.stringify(avatar)},secondAvatar=${JSON.stringify(secondAvatar)};
const phaseKey=${JSON.stringify('liminal-probe:'+cacheName)},phase=sessionStorage.getItem(phaseKey)||'cold';
const wait=async check=>{const until=Date.now()+20000;while(!check()){if(Date.now()>until)throw new Error('Image load timeout');await new Promise(resolve=>setTimeout(resolve,40));}};
const ensure=(value,message)=>{if(!value)throw new Error(message)};
async function run(){
  const persistentCacheAvailable=typeof caches==='object';
  if(phase==='cold'&&persistentCacheAvailable)await caches.delete(AVATAR_CACHE);
  const host=document.getElementById('avatars'),offscreen=document.getElementById('offscreen');
  const identity={username:'fixture',pfp:avatar,pfp_thumbnail:avatar};
  const render=()=>host.innerHTML=Array.from({length:30},()=>'<span class="avatar">'+avatarImageHtml(identity)+'</span>').join('');
  render();offscreen.innerHTML='<span class="avatar">'+avatarImageHtml({username:'offscreen',pfp:secondAvatar})+'</span>';
  setupAvatarLoading();
  await wait(()=>Array.from(host.querySelectorAll('img')).every(img=>img.complete&&img.naturalWidth>0));
  ensure(!offscreen.querySelector('img').getAttribute('src'),'offscreen avatar fetched before it was visible');
  const initialFetches=avatarUsage.fetches;
  for(let i=0;i<30;i++){render();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);}
  await wait(()=>Array.from(host.querySelectorAll('img')).every(img=>img.complete&&img.naturalWidth>0));
  ensure(avatarUsage.fetches===initialFetches,'re-render caused another fetch');
  ensure(initialFetches===(phase==='cold'||!persistentCacheAvailable?1:0),'unexpected cold/warm fetch count');
  ensure(phase==='cold'||!persistentCacheAvailable||avatarUsage.persistentHits===1,'fresh document did not reuse persisted avatar');
  const resources=performance.getEntriesByType('resource').filter(entry=>entry.name===avatar);
  const beforeReveal={...avatarUsage};
  const report={status:'PASS',phase,persistentCacheAvailable,rebuilds:30,avatarsPerRebuild:30,offscreenDeferred:true,initialFetches,
    actualAvatarResourceRequests:resources.length,transferredBytes:resources.some(r=>r.decodedBodySize>0)?resources.reduce((sum,r)=>sum+r.transferSize,0):null,
    decodedBytes:resources.some(r=>r.decodedBodySize>0)?resources.reduce((sum,r)=>sum+r.decodedBodySize,0):null,usage:beforeReveal};
  document.getElementById('report').textContent=JSON.stringify(report,null,2);
  document.title='Avatar probe PASS '+phase;
  sessionStorage.setItem(phaseKey,'warm');
}
run().catch(error=>{document.title='Avatar probe FAIL';document.getElementById('report').textContent=JSON.stringify({status:'FAIL',phase,error:error.message,usage:avatarUsage},null,2)});
`;
  return `<!doctype html><meta charset="utf-8"><title>Avatar probe running</title><style>body{font:16px system-ui;margin:24px;background:#111827;color:#eee}.avatar{display:inline-block;position:relative;width:36px;height:36px;margin:4px;overflow:hidden;border-radius:50%;background:#374151}.avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}pre{white-space:pre-wrap}#offscreen{margin-top:3500px}</style><h1>Avatar network verification</h1><pre id="report">Running…</pre><div id="avatars"></div><div id="offscreen"></div><script>${script.replaceAll('</script','<\\/script')}</script>`;
}
