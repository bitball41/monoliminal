import { GetObjectCommand, HeadObjectCommand } from "npm:@aws-sdk/client-s3@3.1146.0";
import { s3,bucket,cors,json,all,keyOf,mime,manifest } from "./shared.ts";
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  if(!["GET","HEAD"].includes(req.method))return json({error:"Method not allowed"},405);
  const u=new URL(req.url);
  try{
    if(u.searchParams.has("key")){
      const key=keyOf(u.searchParams.get("key"),false,true);if(!key)return json({error:"Invalid file path"},400);
      const range=req.headers.get("range");if(range&&!/^bytes=\d*-\d*$/.test(range))return json({error:"Invalid range"},400);
      const input={Bucket:bucket,Key:key,...(range?{Range:range}:{})};
      const r:any=await s3.send(req.method==="HEAD"?new HeadObjectCommand(input):new GetObjectCommand(input));
      const name=key.split("/").pop()||"download";
      const download=u.searchParams.get("download")==="1";
      const headers:Record<string,string>={...cors,"Content-Type":r.ContentType&&r.ContentType!=="application/octet-stream"?r.ContentType:mime(key),"Accept-Ranges":"bytes","X-Content-Type-Options":"nosniff","Content-Disposition":`${download?"attachment":"inline"}; filename*=UTF-8''${encodeURIComponent(name)}`};
      if(r.ContentLength!==undefined)headers["Content-Length"]=String(r.ContentLength);
      if(r.ContentRange)headers["Content-Range"]=r.ContentRange;
      if(r.ETag)headers.ETag=r.ETag;
      // HTML runs only in the client's explicit sandboxed Run view. Direct URLs show source.
      if(!download&&/\.(html?|xhtml)$/i.test(key))headers["Content-Type"]="text/plain; charset=utf-8";
      headers["Content-Security-Policy"]="sandbox; default-src 'none'; style-src 'unsafe-inline'";
      return new Response(req.method==="HEAD"?null:r.Body!.transformToWebStream(),{status:r.ContentRange?206:200,headers});
    }
    const objects=await all();
    const files=objects.filter(o=>!o.key.startsWith(".liminal-trash/"));
    const ids=objects.filter(o=>/^\.liminal-trash\/[a-f0-9-]{36}\/\.entry\.json$/.test(o.key)).map(o=>o.key.split("/")[1]);
    const trash:any[]=[];
    for(let i=0;i<ids.length;i+=10){const entries=await Promise.all(ids.slice(i,i+10).map(async id=>{try{return {...await manifest(id),id};}catch{return null;}}));trash.push(...entries.filter(Boolean));}
    return json({ok:true,files,trash,count:files.length,truncated:false});
  }catch(e:any){console.error("[liminal-drive]",e.name);return json({ok:false,error:e?.$metadata?.httpStatusCode===404?"File not found":e.message||"Unable to load Drive"},e?.$metadata?.httpStatusCode===404?404:500);}
});

