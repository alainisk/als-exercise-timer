/* Account files are private bucket objects; every download checks current access. */
(() => {
'use strict';
const current=()=>window.AccountSync.user;
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value)),b=>b.toString(16).padStart(2,'0')).join('');
const validRef=r=>!!r&&r.provider==='account'&&/^u_[a-f0-9]{64}$/.test(r.owner||'')&&/^[a-f0-9]{64}$/.test(r.id||'')&&r.hash===r.id&&Number.isSafeInteger(r.size)&&r.size>0&&r.size<=512*1024*1024&&/^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|quicktime|x-m4v|webm))$/.test(r.mimeType||'');
const status=s=>{document.getElementById('cloud-status').textContent=s;};
const dataURL=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
const fromDataURL=async data=>{if(!/^data:(image|video)\/[a-z0-9.+-]+;base64,/i.test(data))throw Error('Invalid media.');return (await fetch(data)).blob();};
async function cache(id,value){
 if(!current())return null;const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('TabataAccountMedia-'+current().uid,1);r.onupgradeneeded=()=>r.result.createObjectStore('media');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('media',value===undefined?'readonly':'readwrite'),r=value===undefined?tx.objectStore('media').get(id):tx.objectStore('media').put(value,id);tx.oncomplete=()=>resolve(r.result);tx.onerror=tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
async function upload(blob,label='media',previous){
 const user=current();if(!user)throw Error('Log in before uploading media.');if(!blob.size||blob.size>512*1024*1024)throw Error('Choose a file between 1 byte and 512 MB.');
 const id=await hash(await blob.arrayBuffer()),ref={provider:'account',owner:user.uid,id,hash:id,size:blob.size,mimeType:blob.type};if(!validRef(ref))throw Error('Use a supported image, MP4, MOV or WebM file.');
 if(!validRef(previous)||previous.owner!==user.uid||previous.id!==id){status('Uploading '+label+'…');await window.AccountSync.request('/media/'+user.uid+'/'+id,{method:'PUT',headers:{'Content-Type':blob.type},body:blob,signal:AbortSignal.timeout(600000)});}
 await cache(id,blob);status('Uploaded '+label);return ref;
}
async function get(ref,download=true){
 if(!validRef(ref))throw Error('This older file needs to be uploaded again to your account.');
 // Shared media is held in memory only. It always requires a live authorization check.
 const owned=ref.owner===current()?.uid;
 if(owned){const blob=await cache(ref.id);if(blob)return blob;}
 if(!download)return null;
 const {url}=await window.AccountSync.request('/media/'+ref.owner+'/'+ref.id),target=new URL(url);
 if(target.protocol!=='https:'||!target.hostname.endsWith('.storageapi.dev'))throw Error('Invalid file download address.');
 const response=await fetch(url,{cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(600000)});if(!response.ok)throw Error('Could not download this file.');
 const bytes=await response.arrayBuffer();if(bytes.byteLength!==ref.size||await hash(bytes)!==ref.id)throw Error('File integrity check failed.');
 const blob=new Blob([bytes],{type:ref.mimeType});if(owned)await cache(ref.id,blob);return blob;
}
window.DriveMedia={validRef,connected:()=>!!current(),upload,get,dataURL,fromDataURL,async init(){},updateFolderLink(){}};
})();
