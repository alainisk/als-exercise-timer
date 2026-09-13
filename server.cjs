'use strict';
const http=require('node:http');
const {createHash}=require('node:crypto');
const {readFile}=require('node:fs/promises');
const {Transform}=require('node:stream');
const {S3Client,GetObjectCommand,PutObjectCommand,HeadObjectCommand,PutBucketCorsCommand}=require('@aws-sdk/client-s3');
const {Upload}=require('@aws-sdk/lib-storage');
const {getSignedUrl}=require('@aws-sdk/s3-request-presigner');
const HASH=/^[a-f0-9]{64}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const MAX_MEDIA=512*1024*1024+16;
const PUBLIC=new Set(['index.html','app.js','family-sync.js','drive-media.js','cloud-media.js','cloud-config.js','styles.css','redesign.css','sw.js','manifest.json','favicon.png','icon-192.png','icon-512.png','privacy.html']);
const mime={html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',png:'image/png'};
async function body(req,limit){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(Error('Request too large'),{status:413});chunks.push(chunk);}return Buffer.concat(chunks);}
function envelope(data){return data?.version===1&&typeof data.revision==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(data.revision)&&typeof data.iv==='string'&&/^[A-Za-z0-9+/]{16}$/.test(data.iv)&&Array.isArray(data.chunks)&&data.chunks.length>0&&data.chunks.length<=24&&data.chunks.every(c=>typeof c==='string'&&c.length<=1000000&&/^[A-Za-z0-9+/=]+$/.test(c));}
class BucketStore{
 constructor(){this.bucket=process.env.AWS_S3_BUCKET_NAME;this.client=new S3Client({endpoint:process.env.AWS_ENDPOINT_URL,region:process.env.AWS_DEFAULT_REGION||'auto',credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});}
 async get(key){try{const r=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key}));return {text:await r.Body.transformToString(),etag:r.ETag};}catch(e){if(e.$metadata?.httpStatusCode===404)return null;throw e;}}
 async put(key,text,etag){return this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:key,Body:text,ContentType:'application/json',...(etag==='null_etag'?{IfNoneMatch:'*'}:{IfMatch:etag})}));}
 async exists(key){try{await this.client.send(new HeadObjectCommand({Bucket:this.bucket,Key:key}));return true;}catch(e){if(e.$metadata?.httpStatusCode===404)return false;throw e;}}
 async upload(key,stream,size){await new Upload({client:this.client,params:{Bucket:this.bucket,Key:key,Body:stream,ContentLength:size,ContentType:'application/octet-stream'},partSize:5*1024*1024,queueSize:2,leavePartsOnError:false}).done();}
 async url(key){return getSignedUrl(this.client,new GetObjectCommand({Bucket:this.bucket,Key:key}),{expiresIn:900});}
 async cors(origins){await this.client.send(new PutBucketCorsCommand({Bucket:this.bucket,CORSConfiguration:{CORSRules:[{AllowedOrigins:origins,AllowedMethods:['GET','HEAD'],AllowedHeaders:['*'],ExposeHeaders:['ETag'],MaxAgeSeconds:3600}]}}));}
}
function createServer(store,{root=__dirname,origins=[]}={}){
 const allowed=new Set(['https://alainisk.github.io',...origins]);
 const activeUploads=new Set();
 let budgetStart=Date.now(),writeCount=0,uploadBytes=0;
 const allowWrite=bytes=>{if(Date.now()-budgetStart>3600000){budgetStart=Date.now();writeCount=0;uploadBytes=0;}if(writeCount>=1000||uploadBytes+bytes>Number(process.env.HOURLY_UPLOAD_BYTES||2147483648))return false;writeCount++;uploadBytes+=bytes;return true;};
 return http.createServer(async(req,res)=>{
  const json=(code,value,headers={})=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));};
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  try{
   const path=new URL(req.url,'http://localhost').pathname;
   const origin=req.headers.origin;
   if(path.startsWith('/api/')){
    if(origin&&!allowed.has(origin))return json(403,{error:'Origin not allowed'});
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Expose-Headers','ETag');}
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET,PUT,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type,If-Match,X-Firebase-ETag','Access-Control-Max-Age':'600'});return res.end();}
    if(path==='/api/health')return json(200,{ok:true,storage:!!store});
    if(!store)return json(503,{error:'Cloud storage is not configured'});
    const match=path.match(/^\/api\/families\/([a-f0-9]{64})(?:\/(revision|media\/([a-f0-9]{64})))?$/);
    if(!match)return json(404,{error:'Not found'});
    const auth=(req.headers.authorization||'').replace(/^Bearer /,'');if(!HASH.test(auth))return json(401,{error:'A private family link is required'});
    const prefix='families/'+match[1]+'/'+sha(auth)+'/';
    if(match[3]){
     const key=prefix+'media/'+match[3];
     if(req.method==='GET'){if(!await store.exists(key))return json(404,{error:'Media not uploaded yet'});return json(200,{url:await store.url(key)});}
     if(req.method!=='PUT')return json(405,{error:'Method not allowed'});
     const size=Number(req.headers['content-length']);if(!Number.isSafeInteger(size)||size<16||size>MAX_MEDIA)return json(413,{error:'Choose a file smaller than 512 MB'});
     if(activeUploads.size>=3||activeUploads.has(key))return json(429,{error:'Another upload is in progress. Retry shortly.'});
     if(!allowWrite(size))return json(429,{error:'Upload limit reached. Please retry later.'});
     activeUploads.add(key);
     try{
      if(await store.exists(key)){req.resume();return json(200,{ok:true});}
      let received=0;const hash=createHash('sha256');
      const checked=new Transform({transform(chunk,enc,done){received+=chunk.length;if(received>size)return done(Error('Upload too large'));hash.update(chunk);done(null,chunk);},flush(done){done(received===size&&hash.digest('hex')===match[3]?null:Error('Upload integrity check failed'));}});
      req.on('error',e=>checked.destroy(e));req.on('aborted',()=>checked.destroy(Error('Upload interrupted')));req.pipe(checked);
      await store.upload(key,checked,size);return json(200,{ok:true});
     }finally{activeUploads.delete(key);}
    }
    const key=prefix+'snapshot.json';
    if(req.method==='GET'){const current=await store.get(key);const data=current?JSON.parse(current.text):null;return json(200,match[2]==='revision'?data?.revision||null:data,{ETag:current?.etag||'null_etag'});}
    if(req.method!=='PUT'||match[2])return json(405,{error:'Method not allowed'});
    const etag=req.headers['if-match'];if(!etag||!(etag==='null_etag'||/^"[a-zA-Z0-9-]+"$/.test(etag)))return json(428,{error:'A revision is required'});
    const text=(await body(req,24*1024*1024)).toString();let data;try{data=JSON.parse(text);}catch{return json(400,{error:'Invalid family data'});}if(!envelope(data))return json(400,{error:'Invalid family data'});
    if(!allowWrite(0))return json(429,{error:'Write limit reached. Please retry later.'});
    await store.put(key,text,etag);return json(200,{ok:true});
   }
   if(!['GET','HEAD'].includes(req.method))return json(405,{error:'Method not allowed'});
   const name=path==='/'?'index.html':path.slice(1);if(!PUBLIC.has(name))return json(404,{error:'Not found'});
   const content=await readFile(root+'/'+name);res.writeHead(200,{'Content-Type':mime[name.split('.').pop()]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
  }catch(e){const status=e.status||e.$metadata?.httpStatusCode; if(res.headersSent){res.destroy();return;}json(status===412?412:status===413?413:503,{error:status===412?'Another device saved first. Retry syncing.':'Cloud request failed. Local data is safe; retry shortly.'});}
 });
}
if(require.main===module){
 const origins=(process.env.ALLOWED_ORIGINS||'').split(',').filter(Boolean);if(process.env.RAILWAY_PUBLIC_DOMAIN)origins.push('https://'+process.env.RAILWAY_PUBLIC_DOMAIN);
 const store=process.env.AWS_S3_BUCKET_NAME?new BucketStore():null;
 (async()=>{if(store)await store.cors(['https://alainisk.github.io',...origins]);const server=createServer(store,{origins});server.requestTimeout=600000;server.listen(Number(process.env.PORT)||4174,'0.0.0.0',()=>console.log('Tabata Timer listening'));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));})().catch(()=>{console.error('Storage initialization failed; check bucket configuration');process.exit(1);});
}
module.exports={createServer,envelope};
