/* Google Drive owns media; Firebase receives only these small file references.
   OAuth access tokens remain in memory and are never included in family links. */
(() => {
'use strict';
const CLIENT_ID = '233390696091-odvk9eh61c0u202hgauvtgn941a2tpe2.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
let accessToken='',expires=0,tokenClient,folderId='',connecting=false,accountKey='';
const inFlight=new Map();
const tell=message=>{const el=document.getElementById('drive-status');if(el)el.textContent=message;};
const validRef=ref=>!!ref&&ref.provider==='drive'&&/^[A-Za-z0-9_-]+$/.test(ref.id||'')&&/^[a-f0-9]{64}$/.test(ref.hash||'')&&Number.isSafeInteger(ref.size)&&ref.size>=0&&/^(image\/(png|jpeg|gif|webp|avif)|video\/[a-z0-9.+-]+|application\/octet-stream)$/i.test(ref.mimeType||'')&&(ref.folderId===undefined||/^[A-Za-z0-9_-]+$/.test(ref.folderId));
const connected=()=>!!accessToken&&Date.now()<expires;
function requireToken(){if(!connected())throw new Error('Connect Google Drive to upload or download media. Workout details still sync without it.');return accessToken;}
function database(){return new Promise((resolve,reject)=>{const req=indexedDB.open('TabataDriveMedia',1);req.onupgradeneeded=()=>req.result.createObjectStore('media');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function cache(key,value){const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('media',value===undefined?'readonly':'readwrite');const req=value===undefined?tx.objectStore('media').get(key):tx.objectStore('media').put(value,key);tx.oncomplete=()=>resolve(req.result);tx.onerror=tx.onabort=()=>reject(tx.error);});}finally{db.close();}}
async function hash(blob){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');}
async function api(path,options={}){
  const response=await fetch(API+path,{...options,headers:{Authorization:'Bearer '+requireToken(),...options.headers},signal:AbortSignal.timeout(60000)});
  if(response.status===401){accessToken='';tell('Google session expired. Connect Google Drive again.');throw new Error('Connect Google Drive again to continue.');}
  if(!response.ok){let reason='';try{reason=(await response.json()).error?.errors?.[0]?.reason||'';}catch{}
    if(reason==='storageQuotaExceeded')throw new Error('Google Drive is full. Free up space or choose another Google account. Your local files are safe.');
    if(response.status===403||response.status===404)throw new Error('This Google account cannot access the media. Use the account that uploaded it, or share the media folder with this account.');
    throw new Error('Google Drive is unavailable. Your local files are safe; retry when online.');}
  return response;
}
async function getFolder(){
  if(folderId)return folderId;
  const q="trashed=false and mimeType='application/vnd.google-apps.folder' and appProperties has { key='tabataMedia' and value='v1' }";
  const found=await (await api('/files?fields=files(id)&q='+encodeURIComponent(q))).json();
  if(found.files?.length)folderId=found.files[0].id;
  else {const folder=await (await api('/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Tabata Timer Media',mimeType:'application/vnd.google-apps.folder',appProperties:{tabataMedia:'v1'}})})).json();folderId=folder.id;}
  updateFolderLink();return folderId;
}
function updateFolderLink(id=folderId){const link=document.getElementById('drive-folder');if(link&&id){link.href='https://drive.google.com/drive/folders/'+encodeURIComponent(id);link.hidden=false;}}
function loadGoogle(){return new Promise((resolve,reject)=>{if(window.google?.accounts?.oauth2)return resolve();let script=document.getElementById('google-identity');if(!script){script=document.createElement('script');script.id='google-identity';script.src='https://accounts.google.com/gsi/client';script.async=true;document.head.appendChild(script);}script.addEventListener('load',resolve,{once:true});script.addEventListener('error',()=>reject(new Error('Could not load Google sign-in. Check your connection.')),{once:true});});}
async function prepare(){if(!CLIENT_ID){tell('Google Drive setup is awaiting OAuth configuration.');return;}await loadGoogle();tokenClient=google.accounts.oauth2.initTokenClient({client_id:CLIENT_ID,scope:SCOPE,include_granted_scopes:false,callback:()=>{},error_callback:()=>{connecting=false;tell('Google sign-in was cancelled or blocked. Try Connect Google Drive again.');}});}
function connect(){
  if(connecting)return;
  if(!tokenClient){tell('Google sign-in is loading. Try again in a moment.');prepare().catch(e=>tell(e.message));return;}
  connecting=true;tell('Choose your Google account…');
  tokenClient.callback=async response=>{connecting=false;if(response.error||!response.access_token||!google.accounts.oauth2.hasGrantedAllScopes(response,SCOPE)){tell('Google Drive permission was not granted. Your local files are unchanged.');return;}
    accessToken=response.access_token;expires=Date.now()+Math.max(0,Number(response.expires_in)-60)*1000;folderId='';accountKey='';tell('Google Drive connected');document.getElementById('drive-disconnect').hidden=false;
    try{const about=await (await api('/about?fields=user(permissionId)')).json();accountKey=about.user.permissionId;window.dispatchEvent(new Event('tabata-drive-connected'));}catch(error){disconnect();tell(error.message);}
  };
  tokenClient.requestAccessToken({prompt:'select_account'});
}
function disconnect(){accessToken='';expires=0;folderId='';accountKey='';document.getElementById('drive-disconnect').hidden=true;document.getElementById('drive-folder').hidden=true;tell('Google Drive disconnected on this page. Downloaded files remain available offline.');}
async function sendChunks(url,blob,progress=()=>{},send=fetch){
  const chunkSize=4*1024*1024;let offset=0,failures=0;
  while(failures<3){
    const end=Math.min(offset+chunkSize,blob.size);let response;
    try {response=await send(url,{method:'PUT',headers:{'Content-Type':blob.type||'application/octet-stream','Content-Range':offset<blob.size?`bytes ${offset}-${end-1}/${blob.size}`:`bytes */${blob.size}`},...(offset<blob.size?{body:blob.slice(offset,end)}:{}),signal:AbortSignal.timeout(120000)});}
    catch {response=null;}
    if(response?.ok)return response.json();
    if(response && response.status!==308 && response.status<500)throw new Error('Upload stopped. Reconnect Google Drive and retry.');
    if(response?.status!==308){
      failures++;
      try{response=await send(url,{method:'PUT',headers:{'Content-Range':`bytes */${blob.size}`},signal:AbortSignal.timeout(60000)});}catch{continue;}
      if(response.ok)return response.json();
      if(response.status!==308)continue;
    }
    const range=response.headers.get('Range');const next=range?Number(range.split('-')[1])+1:0;
    if(!Number.isSafeInteger(next)||next<0||next>blob.size)throw new Error('Invalid upload progress returned by Google Drive.');
    if(next>offset)failures=0;else failures++;
    offset=next;progress(Math.floor(offset/blob.size*100));
  }
  throw new Error('Upload interrupted. Your local file is safe; retry when online.');
}
async function upload(blob,label='media',previous){
  const digest=await hash(blob);
  if(validRef(previous)&&previous.hash===digest){await cache('blob:'+digest,blob);return previous;}
  requireToken();
  const existing=await cache('ref:'+accountKey+':'+digest);
  if(validRef(existing)){await cache('blob:'+digest,blob);return existing;}
  requireToken();
  const parent=await getFolder();
  // Find an earlier successful upload if a reload interrupted saving its reference.
  const q="trashed=false and '"+parent+"' in parents and appProperties has { key='tabataHash' and value='"+digest+"' }";
  const known=await (await api('/files?fields=files(id,size,mimeType)&q='+encodeURIComponent(q))).json();
  let id=known.files?.[0]?.id;
  if(!id){
    tell('Uploading '+label+'…');
    const init=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',{method:'POST',headers:{Authorization:'Bearer '+requireToken(),'Content-Type':'application/json','X-Upload-Content-Type':blob.type||'application/octet-stream','X-Upload-Content-Length':String(blob.size)},body:JSON.stringify({name:label,parents:[parent],appProperties:{tabataHash:digest}}),signal:AbortSignal.timeout(60000)});
    if(!init.ok)throw new Error('Could not start the Drive upload. Check your account storage and retry.');
    const url=init.headers.get('Location');if(!url||!url.startsWith('https://www.googleapis.com/'))throw new Error('Google Drive did not return an upload session.');
    const result=await sendChunks(url,blob,percent=>tell('Uploading '+label+' · '+percent+'%'));
    if(!result?.id)throw new Error('Upload did not finish. Retry to resume syncing.');id=result.id;
  }
  const ref={provider:'drive',id,hash:digest,size:blob.size,mimeType:blob.type||'application/octet-stream',folderId:parent};
  await cache('blob:'+digest,blob);await cache('ref:'+accountKey+':'+digest,ref);tell('Uploaded '+label);return ref;
}
async function get(ref,download=true){
  if(!validRef(ref))throw new Error('Invalid Google Drive media reference.');
  updateFolderLink(ref.folderId);const stored=await cache('blob:'+ref.hash);if(stored)return stored;
  if(!download)return null;
  if(inFlight.has(ref.hash))return inFlight.get(ref.hash);
  const pending=(async()=>{tell('Downloading media…');updateFolderLink(ref.folderId);const response=await api('/files/'+encodeURIComponent(ref.id)+'?alt=media');const data=await response.blob();if(data.size!==ref.size||await hash(data)!==ref.hash)throw new Error('Downloaded file does not match the saved media. It may have changed in Drive.');const blob=new Blob([data],{type:ref.mimeType});await cache('blob:'+ref.hash,blob);tell('Media saved for offline use');return blob;})();
  inFlight.set(ref.hash,pending);try{return await pending;}finally{inFlight.delete(ref.hash);}
}
async function dataURL(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});}
async function fromDataURL(value){const response=await fetch(value);return response.blob();}
window.DriveMedia={validRef,connected,upload,get,dataURL,fromDataURL,updateFolderLink,
  async init(){document.getElementById('drive-connect').addEventListener('click',connect);document.getElementById('drive-disconnect').addEventListener('click',disconnect);await prepare();},
  testing:{hash,validRef,sendChunks}
};
})();
