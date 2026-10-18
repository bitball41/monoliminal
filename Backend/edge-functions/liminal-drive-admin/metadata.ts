// This module is also deployed with liminal-drive-admin. Keep both copies equal.
export const METADATA_PREFIX = '.liminal-meta/';
const limits: Record<string,number> = { title:120, description:2000, genre:48, note:2000 };
const enums: Record<string,string[]> = {
  category:['games','apps','files'], status:['unknown','working','viewer','slow','broken'],
  launchMode:['default','details','download','new_tab'],
};
export function validateMetadata(input:unknown) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('File details must be an object');
  const out:Record<string,unknown>={};
  for(const [key,value] of Object.entries(input)) {
    if(Object.hasOwn(limits,key)){if(typeof value!=='string'||value.length>limits[key]||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw new Error(`Invalid ${key}`);if(value.trim())out[key]=value.trim();}
    else if(Object.hasOwn(enums,key)){if(typeof value!=='string'||!enums[key].includes(value))throw new Error(`Invalid ${key}`);out[key]=value;}
    else if(key==='rating'){if(value===null||value==='')continue;if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100)throw new Error('Rating must be between 0 and 100');out.rating=value;}
    else throw new Error('Unsupported file detail: '+key);
  }
  return out;
}
export async function metadataKey(key:string){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)));return METADATA_PREFIX+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')+'.json';}
type Storage = { get:(key:string)=>Promise<any>; put:(key:string,body:string,condition?:Record<string,string>)=>Promise<any> };
export function createMetadataStore(storage:Storage) {
  async function read(key:string){
    try{const r=await storage.get(await metadataKey(key));const text=await r.Body.transformToString();if(text.length>16384)throw new Error('File details are too large');const data=JSON.parse(text);if(data.key!==key)throw new Error('File details do not match this file');return {metadata:validateMetadata(data.metadata),metadataRevision:r.ETag,metadataUpdatedAt:data.updatedAt||null};}
    catch(e:any){if(e?.$metadata?.httpStatusCode===404||['NoSuchKey','NotFound'].includes(e.name))return {metadata:{},metadataRevision:null,metadataUpdatedAt:null};throw e;}
  }
  async function save(key:string,input:unknown,revision:unknown){
    if(revision!==null&&(typeof revision!=='string'||revision.length>256||/[\r\n]/.test(revision)))throw Object.assign(new Error('Invalid file revision'),{status:400});
    let metadata:Record<string,unknown>;try{metadata=validateMetadata(input);}catch(e:any){throw Object.assign(e,{status:400});}const updatedAt=new Date().toISOString();
    try{const r=await storage.put(await metadataKey(key),JSON.stringify({key,metadata,updatedAt}),revision?{IfMatch:revision}:{IfNoneMatch:'*'});return {metadata,metadataRevision:r.ETag,metadataUpdatedAt:updatedAt};}
    catch(e:any){if([409,412].includes(e?.$metadata?.httpStatusCode))throw Object.assign(new Error('Someone else changed this file’s details. Reload them before saving.'),{status:409});throw e;}
  }
  async function copy(from:string,to:string){const data=await read(from);if(data.metadataRevision)await storage.put(await metadataKey(to),JSON.stringify({key:to,metadata:data.metadata,updatedAt:data.metadataUpdatedAt}));}
  async function attach(files:any[],objects:any[]){const available=new Set(objects.filter(o=>o.key.startsWith(METADATA_PREFIX)).map(o=>o.key));const keys=await Promise.all(files.map(f=>metadataKey(f.key)));for(let i=0;i<files.length;i+=10)await Promise.all(files.slice(i,i+10).map(async(f,j)=>{if(available.has(keys[i+j]))Object.assign(f,await read(f.key));}));return files;}
  return {read,save,copy,attach};
}
