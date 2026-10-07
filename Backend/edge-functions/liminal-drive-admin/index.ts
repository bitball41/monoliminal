import { PutObjectCommand,CopyObjectCommand,DeleteObjectCommand,DeleteObjectsCommand,GetBucketCorsCommand,PutBucketCorsCommand,CreateMultipartUploadCommand,UploadPartCommand,CompleteMultipartUploadCommand,AbortMultipartUploadCommand } from "npm:@aws-sdk/client-s3@3.1146.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.1146.0";
import { s3,bucket,cors,json,all,keyOf,exists,publicUrl,manifest } from "./shared.ts";
import { drivePermissions } from "./permissions.ts";
const MAX_PROXY_BYTES=32*1024*1024;
async function authorize(req:Request){
  const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"").trim();if(!token)return null;
  const url=Deno.env.get("SUPABASE_URL")!;
  const keys=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}");
  const key=keys.default||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userRes=await fetch(url+"/auth/v1/user",{headers:{apikey:key,Authorization:`Bearer ${token}`}});
  if(!userRes.ok)return null;const user=await userRes.json();if(!user.id)return null;
  const pRes=await fetch(url+"/rest/v1/profiles?select=username,display_name,pfp,ring,is_owner,is_admin,is_banned,staff_role&user_id=eq."+encodeURIComponent(user.id),{headers:{apikey:key}});
  if(!pRes.ok)throw new Error("Unable to verify Drive permissions");const p=(await pRes.json())[0];
  if(!p||p.is_banned)return null;
  return {...p,...drivePermissions(p)};
}
let corsPromise:Promise<boolean>|null=null;
function ensureCors(){
  return corsPromise ||= (async()=>{
    try{let rules:any[]=[];try{rules=(await s3.send(new GetBucketCorsCommand({Bucket:bucket}))).CORSRules||[];}catch(e:any){if(![404,501].includes(e?.$metadata?.httpStatusCode))throw e;}
      if(!rules.some(r=>r.AllowedOrigins?.includes("*")&&["GET","HEAD","PUT"].every(m=>r.AllowedMethods?.includes(m))&&r.AllowedHeaders?.includes("*"))){
        rules.push({AllowedOrigins:["*"],AllowedMethods:["GET","HEAD","PUT"],AllowedHeaders:["*"],ExposeHeaders:["ETag","Content-Length","Content-Range"],MaxAgeSeconds:3600});
        await s3.send(new PutBucketCorsCommand({Bucket:bucket,CORSConfiguration:{CORSRules:rules}}));
      }return true;
    }catch(e:any){console.warn("[liminal-drive] Direct upload CORS unavailable",e.name);return false;}
  })();
}
const copy=async(oldKey:string,newKey:string)=>s3.send(new CopyObjectCommand({Bucket:bucket,Key:newKey,CopySource:(bucket+"/"+oldKey).split("/").map(encodeURIComponent).join("/")}));
async function remove(keys:string[]){for(let i=0;i<keys.length;i+=1000){const r=await s3.send(new DeleteObjectsCommand({Bucket:bucket,Delete:{Objects:keys.slice(i,i+1000).map(Key=>({Key})),Quiet:true}}));if(r.Errors?.length)throw new Error("Some files could not be removed. Refresh Drive before retrying.");}}
async function movePairs(pairs:{from:string,to:string}[]){
  // Complete every copy before deleting any source; preserve originals on a copy failure.
  for(let i=0;i<pairs.length;i+=10)await Promise.all(pairs.slice(i,i+10).map(p=>copy(p.from,p.to)));
  await remove(pairs.map(p=>p.from));
}
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  if(!["POST","PUT"].includes(req.method))return json({error:"Method not allowed"},405);
  try{
    const actor=await authorize(req);if(!actor)return json({error:"Sign in with a valid Liminal account"},401);
    if(req.method==="PUT"){
      if(!actor.canUpload)return json({error:"Uploads require a Liminal moderator role or above"},403);
      const u=new URL(req.url),key=keyOf(u.searchParams.get("key"));if(!key)return json({error:"Invalid file path"},400);
      const uploadId=u.searchParams.get("upload_id");
      const partNumber=Number(u.searchParams.get("part_number"));
      if(uploadId&&(uploadId.length>1024||!Number.isInteger(partNumber)||partNumber<1||partNumber>10000))return json({error:"Invalid upload part"},400);
      if(!uploadId&&await exists(key)){
        if(u.searchParams.get("overwrite")!=="1")return json({error:"A file with this name already exists",exists:true},409);
        if(!actor.canManage)return json({error:"Replacing existing files requires an Admin role"},403);
      }
      const parts:Uint8Array[]=[];let size=0;const reader=req.body?.getReader();
      if(reader){while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>MAX_PROXY_BYTES){await reader.cancel();return json({error:"This upload part is too large. Retry the upload."},413);}parts.push(r.value);}}
      const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
      if(uploadId){const r=await s3.send(new UploadPartCommand({Bucket:bucket,Key:key,UploadId:uploadId,PartNumber:partNumber,Body:bytes}));return json({ok:true,etag:r.ETag,partNumber,size});}
      await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:bytes,ContentType:(req.headers.get("content-type")||"application/octet-stream").slice(0,200)}));
      return json({ok:true,key,publicUrl:publicUrl(key),size});
    }
    let body:any;try{body=await req.json();}catch{return json({error:"JSON body required"},400);}
    const action=String(body.action||"");
    if(action==="status")return json({ok:true,username:actor.username,displayName:actor.display_name,pfp:actor.pfp,ring:actor.ring,role:actor.is_owner?'owner':actor.staff_role|| (actor.is_admin?'admin':'member'),canUpload:actor.canUpload,canManage:actor.canManage,maxProxyBytes:MAX_PROXY_BYTES});
    const uploading=['presign_upload','multipart_create','multipart_complete','multipart_abort','create_folder'].includes(action);
    if(uploading?!actor.canUpload:!actor.canManage)return json({error:uploading?"Uploads require a Liminal moderator role or above":"File management requires a Liminal administrator role"},403);
    if(action==="presign_upload"){
      const key=keyOf(body.key);if(!key)return json({error:"Invalid file path"},400);
      if(await exists(key)){
        if(body.overwrite!==true)return json({error:"A file with this name already exists",exists:true},409);
        if(!actor.canManage)return json({error:"Replacing existing files requires an Admin role"},403);
      }
      const contentType=String(body.content_type||"application/octet-stream").slice(0,200);
      const direct=await ensureCors();
      const uploadUrl=await getSignedUrl(s3,new PutObjectCommand({Bucket:bucket,Key:key,ContentType:contentType}),{expiresIn:900});
      return json({ok:true,key,uploadUrl,headers:{"Content-Type":contentType},publicUrl:publicUrl(key),direct,expiresIn:900,maxProxyBytes:MAX_PROXY_BYTES});
    }
    if(action==="multipart_create"){
      const key=keyOf(body.key);if(!key)return json({error:"Invalid file path"},400);
      if(await exists(key)){
        if(body.overwrite!==true)return json({error:"A file with this name already exists",exists:true},409);
        if(!actor.canManage)return json({error:"Replacing existing files requires an Admin role"},403);
      }
      const r=await s3.send(new CreateMultipartUploadCommand({Bucket:bucket,Key:key,ContentType:String(body.content_type||"application/octet-stream").slice(0,200)}));
      return json({ok:true,uploadId:r.UploadId,partSize:8*1024*1024});
    }
    if(action==="multipart_complete"||action==="multipart_abort"){
      const key=keyOf(body.key),uploadId=String(body.upload_id||"");if(!key||!uploadId||uploadId.length>1024)return json({error:"Invalid multipart upload"},400);
      if(action==="multipart_abort"){await s3.send(new AbortMultipartUploadCommand({Bucket:bucket,Key:key,UploadId:uploadId}));return json({ok:true});}
      if(!Array.isArray(body.parts)||!body.parts.length||body.parts.length>10000)return json({error:"Invalid upload parts"},400);
      const parts=body.parts.map((p:any)=>({PartNumber:Number(p.partNumber),ETag:String(p.etag||"")})).sort((a:any,b:any)=>a.PartNumber-b.PartNumber);
      if(parts.some((p:any,i:number)=>p.PartNumber!==i+1||!p.ETag||p.ETag.length>256))return json({error:"Invalid upload parts"},400);
      await s3.send(new CompleteMultipartUploadCommand({Bucket:bucket,Key:key,UploadId:uploadId,MultipartUpload:{Parts:parts}}));
      return json({ok:true,key,publicUrl:publicUrl(key)});
    }
    if(action==="create_folder"){
      const prefix=keyOf(body.prefix,true);if(!prefix)return json({error:"Invalid folder path"},400);
      if((await all(prefix)).length)return json({error:"This folder already exists"},409);
      await s3.send(new PutObjectCommand({Bucket:bucket,Key:prefix+".liminal-folder",Body:"",ContentType:"text/plain"}));return json({ok:true,prefix});
    }
    if(action==="rename"||action==="rename_folder"||action==="move"){
      const folder=action==="rename_folder"||body.folder===true;
      const from=keyOf(folder?body.prefix:body.key,folder),to=keyOf(folder?body.new_prefix:body.new_key,folder);
      if(!from||!to)return json({error:"Invalid destination path"},400);if(from===to)return json({ok:true});
      if(folder&&to.startsWith(from))return json({error:"A folder cannot be moved inside itself"},400);
      const objects=folder?await all(from):await exists(from)?[{key:from}]:[];
      if(!objects.length)return json({error:"File or folder no longer exists"},404);
      if(folder?(await all(to)).length:await exists(to))return json({error:"The destination already exists"},409);
      await movePairs(objects.map(o=>({from:o.key,to:folder?to+o.key.slice(from.length):to})));
      return json({ok:true,key:to,prefix:to,moved:objects.length,publicUrl:publicUrl(to)});
    }
    if(action==="trash"||action==="trash_folder"){
      const folder=action==="trash_folder",original=keyOf(folder?body.prefix:body.key,folder);if(!original)return json({error:"Invalid file path"},400);
      const objects=folder?await all(original):await exists(original)?(await all(original)).filter(o=>o.key===original):[];
      if(!objects.length)return json({error:"File or folder no longer exists"},404);
      const id=crypto.randomUUID(),base=`.liminal-trash/${id}/`;
      const entry={originalKey:original,name:original.replace(/\/$/,"").split("/").pop(),folder,deletedAt:new Date().toISOString(),size:objects.reduce((a,o)=>a+o.size,0),count:objects.filter(o=>!o.key.endsWith("/.liminal-folder")).length,keys:objects.map(o=>o.key),previewKey:base+"files/"+objects[0].key};
      for(let i=0;i<objects.length;i+=10)await Promise.all(objects.slice(i,i+10).map(o=>copy(o.key,base+"files/"+o.key)));
      await s3.send(new PutObjectCommand({Bucket:bucket,Key:base+".entry.json",Body:JSON.stringify(entry),ContentType:"application/json"}));
      await remove(objects.map(o=>o.key));return json({ok:true,id});
    }
    if(action==="restore"||action==="delete_trash"){
      const id=String(body.id||"");const entry=await manifest(id);const base=`.liminal-trash/${id}/`;
      if(action==="restore"){
        for(const key of entry.keys)if(await exists(key))return json({error:"A file already exists at the original location. Rename or move it before restoring."},409);
        for(let i=0;i<entry.keys.length;i+=10)await Promise.all(entry.keys.slice(i,i+10).map((key:string)=>copy(base+"files/"+key,key)));
      }
      await remove((await all(base)).map(o=>o.key));return json({ok:true});
    }
    // Compatibility for older clients: preserve their explicit permanent-delete actions.
    if(action==="delete"||action==="delete_folder"){
      const folder=action==="delete_folder",key=keyOf(folder?body.prefix:body.key,folder);if(!key)return json({error:"Invalid file path"},400);
      if(folder)await remove((await all(key)).map(o=>o.key));else await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));return json({ok:true});
    }
    return json({error:"Unsupported action"},400);
  }catch(e:any){console.error("[liminal-drive-admin]",e.name);return json({error:e.message||"Drive action failed"},e?.$metadata?.httpStatusCode===404?404:500);}
});
