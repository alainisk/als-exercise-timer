/* Media is encrypted on the device. Only ciphertext reaches Railway. */
(()=>{
'use strict';
if(!window.TABATA_CLOUD_API)return;
const legacy=window.DriveMedia;
const hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');
const bytes=h=>Uint8Array.from(h.match(/../g),v=>parseInt(v,16));
const digest=async b=>hex(await crypto.subtle.digest('SHA-256',b));
const validRef=r=>!!r&&r.provider==='railway'&&[r.id,r.hash,r.family].every(h=>/^[a-f0-9]{64}$/.test(h||''))&&/^[a-f0-9]{24}$/.test(r.iv||'')&&Number.isSafeInteger(r.size)&&r.size>=0&&r.size<=512*1024*1024&&/^(image\/(png|jpeg|gif|webp|avif)|video\/[a-z0-9.+-]+|application\/octet-stream)$/i.test(r.mimeType||'');
const tell=s=>{const el=document.getElementById('cloud-status');if(el)el.textContent=s;};
async function context(){const token=window.FamilySync?.token;if(!/^[a-f0-9]{64}$/.test(token||''))throw Error('Create a family link before uploading media.');return {family:await digest(bytes(token)),auth:await digest(new TextEncoder().encode('tabata-api:'+token)),key:await crypto.subtle.importKey('raw',bytes(token),'AES-GCM',false,['encrypt','decrypt'])};}
async function cache(key,value){const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('TabataDriveMedia',1);r.onupgradeneeded=()=>r.result.createObjectStore('media');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise((resolve,reject)=>{const tx=db.transaction('media',value===undefined?'readonly':'readwrite');const r=value===undefined?tx.objectStore('media').get(key):tx.objectStore('media').put(value,key);tx.oncomplete=()=>resolve(r.result);tx.onabort=tx.onerror=()=>reject(tx.error);});}finally{db.close();}}
async function request(ctx,id,options={}){const r=await fetch(window.TABATA_CLOUD_API+'/families/'+ctx.family+'/media/'+id,{...options,headers:{Authorization:'Bearer '+ctx.auth,...options.headers},signal:AbortSignal.timeout(600000)});if(!r.ok)throw Error(r.status===413?'Choose a file smaller than 512 MB. Your local file is safe.':r.status===429?'An upload is already running. Try Sync now shortly.':'Could not transfer media. Your local file is safe; retry when online.');return r;}
async function upload(blob,label='media',previous){
 if(blob.size>512*1024*1024)throw Error('Choose a file smaller than 512 MB. Your local file is safe.');
 const ctx=await context(),plain=await blob.arrayBuffer(),hash=await digest(plain);
 const old=validRef(previous)&&previous.family===ctx.family?previous:await cache('railway:'+ctx.family+':'+hash);
 if(validRef(old)&&old.hash===hash){await cache('blob:'+hash,blob);return old;}
 tell('Encrypting '+label+'…');const iv=crypto.getRandomValues(new Uint8Array(12));
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},ctx.key,plain);const id=await digest(encrypted);
 tell('Uploading '+label+'…');await request(ctx,id,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:encrypted});
 const ref={provider:'railway',id,hash,family:ctx.family,iv:hex(iv),size:blob.size,mimeType:blob.type||'application/octet-stream'};
 await cache('blob:'+hash,blob);await cache('railway:'+ctx.family+':'+hash,ref);tell('Uploaded '+label);return ref;
}
const pending=new Map();
async function get(ref,download=true){
 if(legacy.validRef(ref))return legacy.get(ref,download);
 if(!validRef(ref))throw Error('Invalid cloud media reference.');
 const local=await cache('blob:'+ref.hash);if(local)return local;if(!download)return null;
 if(pending.has(ref.id))return pending.get(ref.id);
 const task=(async()=>{const ctx=await context();if(ctx.family!==ref.family)throw Error('Open the original family link to download this media.');tell('Downloading media…');const {url}=await (await request(ctx,ref.id)).json();const target=new URL(url);if(target.protocol!=='https:'||!target.hostname.endsWith('.storageapi.dev'))throw Error('Invalid media download address.');const response=await fetch(url,{referrerPolicy:'no-referrer',signal:AbortSignal.timeout(600000)});if(!response.ok)throw Error('Download interrupted. Try again.');const encrypted=await response.arrayBuffer();if(await digest(encrypted)!==ref.id)throw Error('Media integrity check failed.');const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(ref.iv)},ctx.key,encrypted);if(plain.byteLength!==ref.size||await digest(plain)!==ref.hash)throw Error('Media integrity check failed.');const blob=new Blob([plain],{type:ref.mimeType});await cache('blob:'+ref.hash,blob);tell('Media saved for offline use');return blob;})();
 pending.set(ref.id,task);try{return await task;}finally{pending.delete(ref.id);}
}
window.DriveMedia={validRef:r=>validRef(r)||legacy.validRef(r),connected:()=>true,upload,get,dataURL:legacy.dataURL,fromDataURL:legacy.fromDataURL,updateFolderLink:()=>{},async init(){const section=document.querySelector('.drive-controls');section.hidden=true;const region=document.createElement('section');region.className='cloud-controls';region.innerHTML='<h3>Family cloud storage</h3><p>Videos and images sync with your private family link. No Google sign-in needed. Use Download for offline to save a workout on this device.</p><p id="cloud-status" role="status">Ready to sync</p><details><summary>Recover older Google Drive media</summary><p>Only needed if a file was previously uploaded to Google Drive and is no longer on this device.</p><button id="legacy-drive-setup" class="btn-secondary">Connect old Drive storage</button></details><a href="./privacy.html" target="_blank" rel="noopener">Privacy</a>';section.before(region);document.getElementById('legacy-drive-setup').addEventListener('click',async()=>{section.hidden=false;try{await legacy.init();}catch(e){tell(e.message);}});},testing:{validRef,digest}};
})();
