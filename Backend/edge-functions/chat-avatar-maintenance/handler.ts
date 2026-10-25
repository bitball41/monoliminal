// Temporary, capability-gated migration of current avatars. Never rewrites an
// original or accepts arbitrary Storage destinations. Disabled after maintenance.
export function avatarMaintenanceHandler(config: {
  projectUrl: string; serviceKey: string; tokenHash: string; expiresAt: number;
  probeHtml?: string; fetchImpl?: typeof fetch;
}) {
  const request=config.fetchImpl || fetch;
  const digest=async(value: Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value))).map(b=>b.toString(16).padStart(2,'0')).join('');
  return async(req: Request)=>{
    const json=(data: unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
    if(!config.tokenHash || Date.now()>=config.expiresAt) return json({error:'Maintenance disabled'},410);
    const url=new URL(req.url),probe=req.method==='GET' && url.pathname.endsWith('/probe');
    const token=probe ? url.searchParams.get('token') || '' : req.headers.get('authorization')?.replace(/^Bearer /,'') || '';
    if(!token || token.length>256 || await digest(new TextEncoder().encode(token))!==config.tokenHash) return json({error:'Unauthorized'},401);
    if(probe && config.probeHtml) return new Response(config.probeHtml,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    if(req.method!=='POST') return json({error:'POST required'},405);
    if(!config.serviceKey) return json({error:'Server credentials unavailable'},503);
    if(Number(req.headers.get('content-length'))>350000) return json({error:'Payload too large'},413);
    let body;
    try { const raw=await req.text(); if(raw.length>350000) return json({error:'Payload too large'},413); body=JSON.parse(raw); }
    catch { return json({error:'Invalid JSON'},400); }
    const {user_id,expected_pfp,thumbnail}=body;
    if(!/^[0-9a-f-]{36}$/i.test(user_id || '') || typeof expected_pfp!=='string' || expected_pfp.length>2000
        || !expected_pfp.startsWith(config.projectUrl+'/storage/v1/object/public/') || typeof thumbnail!=='string' || thumbnail.length>349000) return json({error:'Invalid manifest'},400);
    let bytes;
    try { bytes=Uint8Array.from(atob(thumbnail),c=>c.charCodeAt(0)); } catch { return json({error:'Invalid thumbnail'},400); }
    if(bytes.length<12 || bytes.length>262144 || String.fromCharCode(...bytes.slice(0,4))!=='RIFF' || String.fromCharCode(...bytes.slice(8,12))!=='WEBP') return json({error:'WebP thumbnail required'},400);
    const headers: Record<string,string>={apikey:config.serviceKey};
    if(!config.serviceKey.startsWith('sb_secret_')) headers.Authorization='Bearer '+config.serviceKey;
    const lookup=config.projectUrl+'/rest/v1/profiles?user_id=eq.'+encodeURIComponent(user_id)+'&select=pfp,pfp_thumbnail';
    const profileResponse=await request(lookup,{headers});
    if(!profileResponse.ok) return json({error:'Profile lookup failed'},502);
    const profile=(await profileResponse.json())[0];
    if(!profile || profile.pfp!==expected_pfp) return json({status:'profile_changed'},409);
    if(profile.pfp_thumbnail) return json({status:'already_optimized'});
    const thumbnailHash=await digest(bytes);
    const key=user_id+'/thumbnails/'+thumbnailHash+'.webp';
    const uploaded=await request(config.projectUrl+'/storage/v1/object/liminal-pfp/'+key,{method:'POST',headers:{...headers,'Content-Type':'image/webp','Cache-Control':'max-age=604800','x-upsert':'false'},body:bytes});
    const uploadError=uploaded.status===400 ? await uploaded.clone().json().catch(()=>({})) : {};
    const conflict=uploaded.status===409 || uploadError.error==='Duplicate';
    if(!uploaded.ok && !conflict) return json({error:'Thumbnail upload failed'},502);
    const publicUrl=config.projectUrl+'/storage/v1/object/public/liminal-pfp/'+key;
    // Verify the HTTP object, not just its SQL metadata, before reporting success.
    // Storage HEAD responses can carry private/no-cache even when GET is
    // publicly cacheable. Verify the response the browser will actually use.
    const checked=await request(publicUrl);
    if(!checked.ok || !checked.headers.get('content-type')?.includes('image/webp') || !/max-age=604800/.test(checked.headers.get('cache-control') || '')) return json({error:'Thumbnail verification failed'},502);
    const storedBytes=new Uint8Array(await checked.arrayBuffer());
    if(storedBytes.length!==bytes.length || await digest(storedBytes)!==thumbnailHash) return json({error:'Thumbnail content verification failed'},502);
    const patch=await request(config.projectUrl+'/rest/v1/profiles?user_id=eq.'+encodeURIComponent(user_id)+'&pfp=eq.'+encodeURIComponent(expected_pfp)+'&pfp_thumbnail=eq.&select=user_id',{
      method:'PATCH',headers:{...headers,'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({pfp_thumbnail:publicUrl}),
    });
    if(!patch.ok) return json({error:'Profile update failed'},502);
    const updated=await patch.json();
    if(!updated.length) return json({status:'profile_changed'},409);
    return json({status:'optimized',bytes:bytes.length});
  };
}
