/* Firebase private-link sync. The fragment contains a random encryption key;
   Firebase receives only its SHA-256 address and AES-GCM ciphertext. */
(() => {
'use strict';
const ENDPOINT = 'https://tabata-timer-d9aae-default-rtdb.firebaseio.com';
const TOKEN_KEY = 'tabata-family-key-v1';
const validToken = token => /^[a-f0-9]{64}$/.test(token || '');
const fragmentToken = new URLSearchParams(location.hash.split('?')[1] || '').get('family');
const savedToken = localStorage.getItem(TOKEN_KEY);
let token = validToken(fragmentToken) ? fragmentToken : validToken(savedToken) ? savedToken : null;
let adapter, busy = false, timer, baseline = null;
const isJoining = !!token && token !== savedToken;
const bytes = hex => Uint8Array.from(hex.match(/../g), v => parseInt(v,16));
const hex = buffer => Array.from(new Uint8Array(buffer), b=>b.toString(16).padStart(2,'0')).join('');
const encode = buffer => {let s='';const a=new Uint8Array(buffer);for(let i=0;i<a.length;i+=32768)s+=String.fromCharCode(...a.subarray(i,i+32768));return btoa(s);};
const decode = text => Uint8Array.from(atob(text),c=>c.charCodeAt(0));
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const dirtyKey = () => 'tabata-family-dirty-' + token;
const status = message => { const el=document.getElementById('family-status'); if(el)el.textContent=message; const badge=document.getElementById('family-badge');if(badge)badge.textContent=message; };
async function address(key=token) {return hex(await crypto.subtle.digest('SHA-256',bytes(key)));}
async function cipherKey(key=token) {return crypto.subtle.importKey('raw',bytes(key),'AES-GCM',false,['encrypt','decrypt']);}
async function seal(data,key=token) {
  const plain=new TextEncoder().encode(JSON.stringify(data));
  if(plain.length>100*1024*1024)throw new Error('The workout metadata is too large to sync. Your local library is safe; media should be stored separately in Drive.');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=encode(await crypto.subtle.encrypt({name:'AES-GCM',iv},await cipherKey(key),plain));
  const chunks=[];for(let i=0;i<cipher.length;i+=1000000)chunks.push(cipher.slice(i,i+1000000));
  return {version:1,revision:crypto.randomUUID(),iv:encode(iv),chunks};
}
async function unseal(data,key=token) {
  if(data?.version!==1 || !Array.isArray(data.chunks) || data.chunks.length>150)throw new Error('Invalid family data.');
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(data.iv)},await cipherKey(key),decode(data.chunks.join('')));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function request(path='',options={},key=token) {
  const response=await fetch(`${ENDPOINT}/families/${await address(key)}${path}.json`,{cache:'no-store',referrerPolicy:'no-referrer',...options,signal:AbortSignal.timeout(120000)});
  if(!response.ok && response.status!==412)throw new Error(response.status===401||response.status===403?'Family access was denied. Check the link.':'Could not reach family storage. Your local changes are safe; retry when online.');
  return response;
}
function metaDB() {return new Promise((resolve,reject)=>{const r=indexedDB.open('TabataFamilySync',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function meta(value) {
  const db=await metaDB();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('state',value===undefined?'readonly':'readwrite');const req=value===undefined?tx.objectStore('state').get(token):tx.objectStore('state').put(value,token);tx.oncomplete=()=>resolve(req.result);tx.onabort=tx.onerror=()=>reject(tx.error);});}finally{db.close();}
}
// Three-way merge preserves independent edits and keeps both conflicting workouts.
function merge(base,local,remote) {
  const out={version:Math.max(base?.version||1,local.version||1,remote.version||1),profiles:[]};const index=list=>new Map((list||[]).map(p=>[p.id,p]));
  const bm=index(base?.profiles),lm=index(local.profiles),rm=index(remote.profiles);
  for(const id of new Set([...bm.keys(),...lm.keys(),...rm.keys()])) {
    const b=bm.get(id),l=lm.get(id),r=rm.get(id);
    if(same(l,b)){if(r)out.profiles.push(r);continue;}
    if(same(r,b)||same(l,r)){if(l)out.profiles.push(l);continue;}
    if(!l||!r){out.profiles.push(structuredClone(l||r));continue;}
    const p={id,name:l.name!==b?.name?l.name:r.name,workouts:[],videos:[]};
    const bw=index(b?.workouts),lw=index(l.workouts),rw=index(r.workouts);
    const lv=new Map((l.videos||[]).map(v=>[v.setId,v])),rv=new Map((r.videos||[]).map(v=>[v.setId,v]));
    const bv=new Map((b?.videos||[]).map(v=>[v.setId,v]));
    const pack=(w,vs)=>w?{w,v:w.sets.filter(s=>s.video).map(s=>vs.get(s.id))}:undefined;
    const add=(w,vs,copy=false)=>{if(!w)return;w=structuredClone(w);if(copy){w.id=crypto.randomUUID();w.name+=' (conflict copy)';}for(const s of w.sets){const video=vs.get(s.id);if(copy){s.id=crypto.randomUUID();if(s.video)s.video='blob:'+s.id;}if(video&&s.video)p.videos.push({...video,setId:s.id});}p.workouts.push(w);};
    for(const wid of new Set([...bw.keys(),...lw.keys(),...rw.keys()])) {
      const bwv=bw.get(wid),lwv=lw.get(wid),rwv=rw.get(wid);
      if(same(pack(lwv,lv),pack(bwv,bv)))add(rwv,rv);
      else if(same(pack(rwv,rv),pack(bwv,bv))||same(pack(lwv,lv),pack(rwv,rv)))add(lwv,lv);
      else {add(rwv,rv);add(lwv,lv,!!rwv);}
    }
    out.profiles.push(p);
  }
  if(!out.profiles.length)out.profiles.push({id:crypto.randomUUID(),name:'My profile',workouts:[],videos:[]});
  return out;
}
async function sync(force=false) {
  if(!token||busy||!adapter.idle())return;
  busy=true;
  try {
    baseline=baseline||await meta();
    const revision=await (await request('/revision')).json();
    if(!force && !localStorage.getItem(dirtyKey()) && baseline?.revision===revision){status('Family synced');return;}
    await adapter.lock(async()=>{
      status('Syncing family…');
      const local=await adapter.snapshot();
      for(let attempt=0;attempt<3;attempt++) {
        const response=await request('',{headers:{'X-Firebase-ETag':'true'}});
        const remoteCipher=await response.json();
        if(!remoteCipher)throw new Error('This family link no longer exists. Local workouts are safe.');
        const remote=await unseal(remoteCipher);adapter.validate(remote);
        let merged=baseline?merge(baseline.data,local,remote):remote;
        if(baseline && adapter.externalize)merged=await adapter.externalize(merged);
        let nextRevision=remoteCipher.revision;
        if(!same(merged,remote)) {
          const encrypted=await seal(merged);
          const put=await request('',{method:'PUT',headers:{'Content-Type':'application/json','if-match':response.headers.get('etag')},body:JSON.stringify(encrypted)});
          if(put.status===412)continue;
          nextRevision=encrypted.revision;
        }
        // Apply before recording the baseline so a failed local write retries safely.
        if(!same(merged,local))await adapter.apply(merged);
        baseline={revision:nextRevision,data:merged};await meta(baseline);
        localStorage.removeItem(dirtyKey());
        status('Family synced');return;
      }
      throw new Error('Another device is saving. Please try Sync now again.');
    });
  }catch(error){status(error.message||'Could not sync. Your local changes are safe.');}
  finally{busy=false;}
}
async function create() {
  if(busy||!adapter.idle())return;busy=true;
  try {await adapter.lock(async()=>{
    status('Creating private family link…');
    const data=await adapter.snapshot();adapter.validate(data);
    const next=hex(crypto.getRandomValues(new Uint8Array(32)));
    const encrypted=await seal(data,next);
    const result=await request('',{method:'PUT',headers:{'Content-Type':'application/json','if-match':'null_etag'},body:JSON.stringify(encrypted)},next);
    if(result.status===412)throw new Error('Please try creating the family link again.');
    token=next;localStorage.setItem(TOKEN_KEY,token);
    location.hash='#/?family='+token;location.reload();
  });}catch(error){status(error.message);}finally{busy=false;}
}
function link() {return location.origin+location.pathname+'#/?family='+token;}
function show() {
  const dialog=document.getElementById('family-dialog');
  document.getElementById('family-create').hidden=!!token;
  document.getElementById('family-connected').hidden=!token;
  document.getElementById('family-link').value=token?link():'';
  dialog.showModal();
}
window.FamilySync={
  get token(){return token;},
  suffix:()=>token?'?family='+token:'',
  mark(){if(token){localStorage.setItem(dirtyKey(),'1');status('Changes waiting to sync');clearTimeout(timer);timer=setTimeout(()=>sync(),800);}},
  async init(value){
    adapter=value;
    document.getElementById('family-button').addEventListener('click',show);
    document.getElementById('family-close').addEventListener('click',()=>{if(!busy)document.getElementById('family-dialog').close();});
    document.getElementById('family-dialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
    document.getElementById('family-create').addEventListener('click',create);
    document.getElementById('family-local').addEventListener('click',()=>{if(busy)return;localStorage.removeItem(TOKEN_KEY);location.hash='';location.reload();});
    document.getElementById('family-sync-now').addEventListener('click',()=>sync(true));
    document.getElementById('family-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(link());status('Family link copied');}catch{const input=document.getElementById('family-link');input.focus();input.select();status('Select and copy the family link.');}});
    document.getElementById('family-join').addEventListener('click',()=>{try{const url=new URL(document.getElementById('family-join-url').value);const key=new URLSearchParams(url.hash.split('?')[1]).get('family');if(!validToken(key))throw Error();location.hash='#/?family='+key;location.reload();}catch{status('Paste a valid family link.');}});
    window.addEventListener('online',()=>sync());
    window.addEventListener('tabata-drive-connected',()=>sync(true));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});
    if(token){
      await sync(true);
      if(baseline){localStorage.setItem(TOKEN_KEY,token);}
      else if(isJoining){show();status('Could not open this family yet. Check the link and try Sync now.');}
      setInterval(()=>{if(!document.hidden)sync();},15000);
    }else status('Saved on this device');
  },
  // Pure helpers are also exercised by Node regression tests.
  testing:{merge,seal,unseal,validToken}
};
})();
