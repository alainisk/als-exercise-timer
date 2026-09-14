/* Account sessions, private libraries and explicit workout sharing. */
(() => {
'use strict';
const SESSION='tabata-account-session-v1',API=window.TABATA_CLOUD_API;
const $=id=>document.getElementById(id);
let session;try{session=JSON.parse(localStorage.getItem(SESSION)||'null');}catch{}
if(!/^u_[a-f0-9]{64}$/.test(session?.uid||'')||typeof session?.refreshToken!=='string')session=null;
let adapter,busy=false,timer,refreshing,signup=false,shareKey=null,baseline=null;
const status=message=>{$('family-status').textContent=message;$('family-badge').textContent=message;};
const dirtyKey=()=> 'tabata-account-dirty-'+session.uid;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function saveSession(value){session={...value,expiresAt:Date.now()+value.expiresIn*1000};localStorage.setItem(SESSION,JSON.stringify(session));}
async function raw(path,options={}){
 const r=await fetch(API+path,{cache:'no-store',referrerPolicy:'no-referrer',...options,signal:options.signal||AbortSignal.timeout(120000)});
 let data;try{data=await r.json();}catch{throw Error('Could not reach the account service. Try again shortly.');}
 if(!r.ok)throw Object.assign(Error(data.error||'Account request failed.'),{status:r.status});return data;
}
async function authRequest(path,data){return raw('/auth/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});}
async function accessToken(){
 if(!session)throw Error('Log in to continue.');
 if(session.expiresAt>Date.now()+60000)return session.idToken;
 if(!refreshing)refreshing=authRequest('refresh',{refreshToken:session.refreshToken}).then(saveSession).finally(()=>{refreshing=null;});
 await refreshing;return session.idToken;
}
async function request(path,options={}){return raw(path,{...options,headers:{...options.headers,Authorization:'Bearer '+await accessToken()}});}
async function meta(value){
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('TabataAccountSync',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('state',value===undefined?'readonly':'readwrite'),r=value===undefined?tx.objectStore('state').get(session.uid):tx.objectStore('state').put(value,session.uid);tx.oncomplete=()=>resolve(r.result);tx.onerror=tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
async function sync(throwErrors=false){
 if(!session||!adapter||busy||!adapter.idle()){if(throwErrors)throw Error('Return to My workouts and close the editor before syncing.');return;}
 busy=true;
 try{
  return await adapter.lock(async()=>{
   status('Syncing your workouts…');baseline=baseline||await meta();
   const local=await adapter.snapshot();adapter.validate(local);
   for(let attempt=0;attempt<3;attempt++){
    const remote=await request('/library');
    if(remote)adapter.validate(remote.data);
    // A first login adopts the server library; isolated account storage starts empty.
    let merged=remote?(baseline?window.mergeLibraries(baseline.data,local,remote.data):localStorage.getItem(dirtyKey())?window.mergeLibraries({version:2,profiles:[]},local,remote.data):remote.data):local;
    merged=await adapter.externalize(merged);let revision=remote?.revision||null;
    if(!remote||!same(merged,remote.data)){
     try{revision=(await request('/library',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,data:merged})})).revision;}
     catch(e){if(e.status===409)continue;throw e;}
    }
    if(!same(merged,local))await adapter.apply(merged);
    baseline={revision,data:merged};await meta(baseline);localStorage.removeItem(dirtyKey());status('Synced · @'+session.username);return true;
   }
   throw Error('Another device is saving. Please sync again.');
  });
 }catch(e){status(e.message||'Offline · changes will sync when you reconnect.');if(throwErrors)throw e;}
 finally{busy=false;}
}
function show(){
 if(busy||(!adapter?.idle()&&!adapter?.prepareHome())){status('Return to My workouts before managing your account.');return;}
 $('account-form').hidden=!!session;$('account-reset').hidden=!!session;$('account-connected').hidden=!session;
 $('account-name').textContent=session?'Logged in as @'+session.username:'';
 $('family-dialog').showModal();
}
function on(id,event,fn){$(id).addEventListener(event,fn);}
function setBusy(dialog,value){dialog.querySelectorAll('button,input').forEach(el=>el.disabled=value);}
async function listRecipients(){
 const recipients=await request('/workouts/'+shareKey+'/shares'),list=$('share-recipients');list.replaceChildren();
 if(!recipients.length){list.textContent='Only you have access.';return;}
 for(const person of recipients){const row=document.createElement('div');row.className='access-row';const name=document.createElement('span');name.textContent='@'+person.username;const button=document.createElement('button');button.className='btn-danger btn-small';button.textContent='Remove';button.setAttribute('aria-label','Remove '+person.username);button.onclick=()=>shareAction(async()=>{await request('/workouts/'+shareKey+'/shares/'+person.uid,{method:'DELETE'});await listRecipients();$('share-status').textContent='Access removed for @'+person.username+'.';});row.append(name,button);list.append(row);}
}
async function shareAction(action){const dialog=$('share-dialog');setBusy(dialog,true);try{await action();}catch(e){$('share-status').textContent=e.message;}finally{setBusy(dialog,false);}}
async function showShared(){
 if(!session){show();status('Log in to see workouts shared with you.');return;}
 if(!adapter.idle()&&!$('shared-dialog').open&&!adapter.prepareHome())return;
 const dialog=$('shared-dialog');if(!dialog.open)dialog.showModal();setBusy(dialog,true);$('shared-list').replaceChildren();$('shared-status').textContent='Loading…';
 try{
  const entries=await request('/shared');$('shared-status').textContent=entries.length?'':'No workouts shared with you yet.';
  for(const item of entries){const row=document.createElement('section');row.className='shared-workout';const title=document.createElement('h3');title.textContent=item.workout.name;const owner=document.createElement('p');owner.textContent='Shared by @'+item.username+' · View only';const controls=document.createElement('div');controls.className='dialog-actions';
   for(const [label,copy] of [['Open workout',false],['Save my own copy',true]]){const b=document.createElement('button');b.className=copy?'btn-secondary':'btn-primary';b.textContent=label;b.onclick=async()=>{
    setBusy(dialog,true);try{
     // Recheck the grant immediately before opening or copying.
     const current=(await request('/shared')).find(w=>w.owner===item.owner&&w.key===item.key);if(!current)throw Error('This workout is no longer shared with you.');
     await (copy?adapter.copyShared(current):adapter.openShared(current));dialog.close();
    }catch(e){$('shared-status').textContent=e.message;}finally{setBusy(dialog,false);}
   };controls.append(b);}row.append(title,owner,controls);$('shared-list').append(row);
  }
 }catch(e){$('shared-status').textContent=e.message;}finally{setBusy(dialog,false);}
}
const ready=(async()=>{
 if(!session)return;
 document.documentElement.classList.add('account-loading');
 try{const user=await request('/me');if(user.uid!==session.uid)throw Object.assign(Error('Session changed'),{status:401});}
 catch(e){if(e.status===401||e.status===400){localStorage.removeItem(SESSION);location.reload();await new Promise(()=>{});}}
 finally{document.documentElement.classList.remove('account-loading');}
})();
window.AccountSync={
 suffix:()=>'',
 get user(){return session?{uid:session.uid,username:session.username}:null;},ready,request,sync,
 mark(){if(session){localStorage.setItem(dirtyKey(),'1');status('Changes waiting to sync');clearTimeout(timer);timer=setTimeout(()=>sync(),800);}},
 async share(profileId,workout){
  if(!session){show();status('Log in to share your workout.');return;}
  try{await sync(true);const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(profileId+'\0'+workout.id));shareKey=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');$('share-workout-name').textContent=workout.name;$('share-status').textContent='';$('share-recipients').replaceChildren();$('share-dialog').showModal();await shareAction(listRecipients);}catch(e){status(e.message);}
 },
 async init(value){
  adapter=value;$('family-button').textContent=session?'@'+session.username:'Log in / Sign up';
  on('family-button','click',show);on('family-close','click',()=>{if(!busy)$('family-dialog').close();});
  on('family-dialog','cancel',e=>{if(busy)e.preventDefault();});
  on('account-mode','click',()=>{signup=!signup;$('account-email-row').hidden=!signup;$('account-email').required=signup;$('account-password').minLength=signup?12:1;$('account-password').autocomplete=signup?'new-password':'current-password';$('account-password').placeholder=signup?'At least 12 characters':'';$('account-submit').textContent=signup?'Sign up':'Log in';$('account-mode').textContent=signup?'I already have an account':'Create an account';});
  on('account-form','submit',async e=>{
   e.preventDefault();if(busy)return;busy=true;setBusy($('family-dialog'),true);status(signup?'Creating your account…':'Logging in…');
   try{saveSession(await authRequest(signup?'signup':'login',{username:$('account-username').value.trim(),password:$('account-password').value,email:$('account-email').value.trim()}));location.hash='';location.reload();}
   catch(error){status(error.message);}finally{busy=false;setBusy($('family-dialog'),false);$('account-password').value='';}
  });
  on('reset-form','submit',async e=>{e.preventDefault();setBusy($('family-dialog'),true);try{await authRequest('reset',{email:$('reset-email').value.trim()});status('If that email has an account, a password reset email is on its way.');}catch(error){status(error.message);}finally{setBusy($('family-dialog'),false);}});
  on('family-sync-now','click',()=>sync());
  on('account-import-device','click',async()=>{if(busy)return;busy=true;setBusy($('family-dialog'),true);try{const count=await adapter.lock(()=>adapter.importDevice());status(count?'Imported '+count+' workouts. Syncing next…':'No device workouts found on this browser.');}catch(e){status(e.message);}finally{busy=false;setBusy($('family-dialog'),false);}if(localStorage.getItem(dirtyKey()))await sync();});
  on('account-logout','click',async()=>{
   if(busy)return;
   try{await sync(true);busy=true;setBusy($('family-dialog'),true);const uid=session.uid;await meta(null);await adapter.clearAccount();localStorage.removeItem('tabata-account-dirty-'+uid);localStorage.removeItem(SESSION);location.hash='';location.reload();}
   catch(e){status('Could not log out safely: '+e.message+' Your workouts are still available on this device or in your account.');}finally{busy=false;setBusy($('family-dialog'),false);}
  });
  on('share-form','submit',e=>{e.preventDefault();shareAction(async()=>{await request('/workouts/'+shareKey+'/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('share-username').value.trim()})});$('share-username').value='';await listRecipients();$('share-status').textContent='Workout shared.';});});
  on('share-close','click',()=>$('share-dialog').close());on('shared-button','click',showShared);on('shared-refresh','click',showShared);on('shared-close','click',()=>$('shared-dialog').close());
  for(const id of ['share-dialog','shared-dialog'])on(id,'cancel',e=>{if($(id).querySelector('button:disabled'))e.preventDefault();});
  window.addEventListener('storage',e=>{if(e.key===SESSION){let next;try{next=JSON.parse(e.newValue);}catch{}if(next?.uid!==session?.uid)location.reload();else if(next)session=next;}});
  window.addEventListener('online',()=>sync());document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});
  if(session){await sync();setInterval(()=>{if(!document.hidden)sync();},15000);}else status('Device library · Log in to sync');
 }
};
})();
