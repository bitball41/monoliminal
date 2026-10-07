import { FetchHttpHandler, streamCollector } from "npm:@smithy/fetch-http-handler@5.8.0";
import { S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand } from "npm:@aws-sdk/client-s3@3.1146.0";

export const cors: Record<string,string> = {
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, apikey, content-type, range, x-drive-key, x-drive-overwrite",
  "Access-Control-Allow-Methods":"GET, HEAD, POST, PUT, OPTIONS",
  "Access-Control-Expose-Headers":"Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag",
  "Cache-Control":"no-store"
};
export const bucket = Deno.env.get("R2_BUCKET_NAME")!;
export const publicBase = (Deno.env.get("CLOUDFLARE_R2") || "").replace(/\/$/, "");
export const s3 = new S3Client({region:"auto", endpoint:`https://${Deno.env.get("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials:{accessKeyId:Deno.env.get("R2_ACCESS_KEY_ID")!,secretAccessKey:Deno.env.get("R2_SECRET_ACCESS_KEY")!},
  forcePathStyle:true, requestHandler:new FetchHttpHandler({requestTimeout:60000}), streamCollector, requestChecksumCalculation:"WHEN_REQUIRED", responseChecksumValidation:"WHEN_REQUIRED"});
export const json = (body: unknown,status=200) => new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json; charset=utf-8"}});
export function keyOf(value: unknown, folder=false, trash=false) {
  let key=String(value || "").replace(/^\/+/, "");
  if (!key || new TextEncoder().encode(key).length>1024 || /[\\\x00-\x1f\x7f]/.test(key) || key.split("/").some(p=>p==="."||p==="..") || (!trash && key.startsWith(".liminal-trash/"))) return null;
  if(folder&&!key.endsWith("/"))key+="/";
  return key;
}
export const publicUrl = (key:string) => publicBase ? publicBase+"/"+key.split("/").map(encodeURIComponent).join("/") : null;
export async function exists(key:string) {
  try{await s3.send(new HeadObjectCommand({Bucket:bucket,Key:key}));return true;}
  catch(e:any){if(e?.$metadata?.httpStatusCode===404||e.name==="NotFound"||e.name==="NoSuchKey")return false;throw e;}
}
export async function all(prefix="") {
  const out:any[]=[];let token:string|undefined;
  do{const r=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:prefix,ContinuationToken:token,MaxKeys:1000}));
    for(const o of r.Contents||[])if(o.Key)out.push({key:o.Key,name:o.Key.split("/").filter(Boolean).pop(),size:o.Size||0,lastModified:o.LastModified?.toISOString(),etag:o.ETag?.replace(/^"|"$/g,""),publicUrl:publicUrl(o.Key)});
    token=r.IsTruncated?r.NextContinuationToken:undefined;
  }while(token);return out;
}
export function mime(key:string) {
  const ext=key.split(".").pop()?.toLowerCase()||"";
  return ({html:"text/html; charset=utf-8",htm:"text/html; charset=utf-8",txt:"text/plain; charset=utf-8",md:"text/plain; charset=utf-8",js:"text/javascript; charset=utf-8",ts:"text/plain; charset=utf-8",css:"text/css; charset=utf-8",json:"application/json",csv:"text/csv; charset=utf-8",pdf:"application/pdf",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",webp:"image/webp",avif:"image/avif",svg:"image/svg+xml",mp4:"video/mp4",webm:"video/webm",mov:"video/quicktime",mp3:"audio/mpeg",wav:"audio/wav",ogg:"audio/ogg",m4a:"audio/mp4",zip:"application/zip",wasm:"application/wasm"} as Record<string,string>)[ext]||"application/octet-stream";
}
export async function manifest(id:string) {
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error("Invalid trash item");
  const r=await s3.send(new GetObjectCommand({Bucket:bucket,Key:`.liminal-trash/${id}/.entry.json`}));
  return JSON.parse(await r.Body!.transformToString());
}

