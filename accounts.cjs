'use strict';
const {createHash,randomUUID}=require('node:crypto');
const VideoSources=require('./video-sources.js');
const hash=value=>createHash('sha256').update(value).digest('hex');
const UID=/^u_[a-f0-9]{64}$/;
const username=value=>typeof value==='string'&&/^[a-zA-Z0-9_]{3,24}$/.test(value)?value.toLowerCase():null;
const uidFor=name=>'u_'+hash(name);
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const mediaRef=(ref,owner)=>!!ref&&ref.provider==='account'&&UID.test(ref.owner||'')&&(!owner||ref.owner===owner)&&/^[a-f0-9]{64}$/.test(ref.id||'')&&ref.hash===ref.id&&Number.isSafeInteger(ref.size)&&ref.size>0&&ref.size<=512*1024*1024&&/^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|quicktime|x-m4v|webm))$/.test(ref.mimeType||'');
const workoutKey=(profileId,id)=>hash(profileId+'\0'+id);
function catalog(library){return (library?.profiles||[]).flatMap(p=>p.workouts.map(workout=>({key:workoutKey(p.id,workout.id),profileId:p.id,workout,videos:(p.videos||[]).filter(v=>workout.sets.some(s=>s.id===v.setId&&s.video==='blob:'+s.id))})));}
function validateLibrary(data,uid){
 const text=v=>typeof v==='string'&&v.length>0&&v.length<=1000;
 const num=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
 const image=item=>(item.image==null)&&(!item.imageRef||mediaRef(item.imageRef,uid));
 if(data?.version!==2||!Array.isArray(data.profiles)||!data.profiles.length||data.profiles.length>100)fail(400,'Invalid library.');
 const profileIds=new Set();
 for(const p of data.profiles){
  if(!p||!text(p.id)||profileIds.has(p.id)||!text(p.name)||!Array.isArray(p.workouts)||p.workouts.length>1000||!Array.isArray(p.videos))fail(400,'Invalid profile.');
  profileIds.add(p.id);const ids=new Set(),sets=new Set(),uploads=new Set();
  for(const w of p.workouts){
   if(!w||!text(w.id)||ids.has(w.id)||!text(w.name)||!image(w)||!num(w.initialCountdown,0,30)||!num(w.warmupDuration,0,600)||!num(w.cooldownDuration,0,600)||!num(w.recoveryDuration,0,600)||!num(w.numberOfCycles,1,50)||!Array.isArray(w.sets)||!w.sets.length||w.sets.length>1000)fail(400,'Invalid workout.');
   ids.add(w.id);
   for(const s of w.sets){if(!s||!text(s.id)||sets.has(s.id)||!text(s.name)||!image(s)||!num(s.exerciseDuration,1,600)||!num(s.restDuration,0,600)||(s.color!=null&&!/^#[a-f0-9]{6}$/i.test(s.color))||(s.video!=null&&s.video!=='blob:'+s.id&&!VideoSources.isLink(s.video)))fail(400,'Invalid exercise.');sets.add(s.id);if(s.video==='blob:'+s.id)uploads.add(s.id);}
  }
  const records=new Set();for(const v of p.videos){if(!v||records.has(v.setId)||!uploads.has(v.setId)||!mediaRef(v.drive,uid))fail(400,'Invalid video.');records.add(v.setId);}
  if(records.size!==uploads.size)fail(400,'An uploaded video is missing.');
 }
}

// Firebase stores metadata; Railway stores files. Only this trusted API uses Admin access.
class FirebaseAccounts {
 constructor(){
  const {initializeApp,cert,applicationDefault}=require('firebase-admin/app');
  const app=initializeApp({credential:process.env.FIREBASE_SERVICE_ACCOUNT_JSON?cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)):applicationDefault(),databaseURL:process.env.FIREBASE_DATABASE_URL});
  this.auth=require('firebase-admin/auth').getAuth(app);this.db=require('firebase-admin/database').getDatabase(app);this.apiKey=process.env.FIREBASE_WEB_API_KEY;
 }
 async identity(method,data){
  const refresh=method==='refresh';
  const url=refresh?'https://securetoken.googleapis.com/v1/token':'https://identitytoolkit.googleapis.com/v1/accounts:'+method;
  const response=await fetch(url+'?key='+encodeURIComponent(this.apiKey),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(20000)});
  const result=await response.json();
  if(!response.ok)fail(response.status===429?429:400,refresh?'Your session expired. Please log in again.':'Unable to sign in. Check your details or reset your password.');
  return result;
 }
 async authenticate(token){try{const user=await this.auth.verifyIdToken(token,true);if(!UID.test(user.uid))fail(401,'Please log in again.');return {uid:user.uid,username:user.name||''};}catch{fail(401,'Please log in again.');}}
 async lookup(name){try{const user=await this.auth.getUser(uidFor(name));return user.disabled?null:{uid:user.uid,username:user.displayName,email:user.email};}catch(e){if(e.code==='auth/user-not-found')return null;throw e;}}
 async login(input,register=false){
  const name=username(input.username);if(!name||typeof input.password!=='string'||input.password.length>256)fail(400,'Enter a valid username and password.');
  if(register){
   if(input.password.length<12||typeof input.email!=='string'||input.email.length>254||!/^\S+@\S+\.\S+$/.test(input.email))fail(400,'Use a valid email and a password of at least 12 characters.');
   try{await this.auth.createUser({uid:uidFor(name),displayName:name,email:input.email.trim(),password:input.password});}catch(e){if(['auth/uid-already-exists','auth/email-already-exists'].includes(e.code))fail(409,'That username or email is already registered. Try logging in.');fail(400,'Unable to create account. Check your email and password.');}
  }
  const user=await this.lookup(name);if(!user)fail(400,'Unable to sign in. Check your details or reset your password.');
  const result=await this.identity('signInWithPassword',{email:user.email,password:input.password,returnSecureToken:true});
  return {uid:user.uid,username:user.username,idToken:result.idToken,refreshToken:result.refreshToken,expiresIn:Number(result.expiresIn)};
 }
 async refresh(input){if(typeof input.refreshToken!=='string'||input.refreshToken.length>10000)fail(400,'Invalid session.');const r=await this.identity('refresh',{grant_type:'refresh_token',refresh_token:input.refreshToken});const user=await this.authenticate(r.id_token);return {...user,idToken:r.id_token,refreshToken:r.refresh_token,expiresIn:Number(r.expires_in)};}
 async reset(input){if(typeof input.email!=='string'||input.email.length>254)fail(400,'Enter your email address.');try{await this.identity('sendOobCode',{requestType:'PASSWORD_RESET',email:input.email});}catch(e){if(e.status!==400)throw e;}return {ok:true};}
 async get(path){return (await this.db.ref(path).get()).val();}
 async update(changes){await this.db.ref().update(changes);}
 async transaction(path,fn){
  let accepted=false;
  const r=await this.db.ref(path).transaction(current=>{
   const next=fn(current);accepted=next!==undefined;
   // Firebase may initially supply null before loading the server value. A
   // no-op compare-and-set lets it retry against existing data instead of
   // aborting a valid share on an empty local cache.
   return next===undefined&&current===null?null:next;
  });
  return r.committed&&accepted;
 }
}
function createAccountAPI(accounts,store,{body,allowWrite,activeUploads}){
 let authStart=Date.now(),authAttempts=0;
 const read=async req=>{try{return JSON.parse((await body(req,8*1024*1024)).toString());}catch(e){if(e.status)throw e;fail(400,'Invalid JSON.');}};
 const library=async uid=>{const row=await accounts.get('accounts/'+uid+'/library');return row?{revision:row.revision,data:JSON.parse(row.data)}:null;};
 return async(req,res,path,json)=>{
  if(!accounts)return json(503,{error:'Accounts are not configured yet. Your device library is safe.'});
  if(path.startsWith('/api/auth/')){
   if(req.method!=='POST')return json(405,{error:'Method not allowed'});
   if(Date.now()-authStart>60000){authStart=Date.now();authAttempts=0;}if(++authAttempts>60)fail(429,'Too many attempts. Try again in a minute.');
   const input=await read(req),action=path.slice('/api/auth/'.length);
   if(action==='signup'||action==='login')return json(200,await accounts.login(input,action==='signup'));
   if(action==='refresh')return json(200,await accounts.refresh(input));
   if(action==='reset')return json(200,await accounts.reset(input));
   return json(404,{error:'Not found'});
  }
  const token=(req.headers.authorization||'').match(/^Bearer (\S+)$/)?.[1];if(!token)fail(401,'Please log in.');
  const user=await accounts.authenticate(token),uid=user.uid;
  if(path==='/api/me'&&req.method==='GET')return json(200,{uid,username:user.username});
  if(path==='/api/library'){
   if(req.method==='GET')return json(200,await library(uid));
   if(req.method!=='PUT')return json(405,{error:'Method not allowed'});
   const input=await read(req);validateLibrary(input.data,uid);
   if(!(input.revision===null||typeof input.revision==='string'))fail(428,'A library revision is required.');
   if(!allowWrite(0))fail(429,'Save limit reached. Retry later.');
   const revision=randomUUID(),keys=new Set(catalog(input.data).map(w=>w.key));
   const ok=await accounts.transaction('accounts/'+uid,current=>{
    if((current?.library?.revision||null)!==input.revision)return;
    const next=current||{};next.library={revision,data:JSON.stringify(input.data)};
    for(const key of Object.keys(next.shares||{}))if(!keys.has(key))delete next.shares[key];
    return next;
   });
   if(!ok)fail(409,'Another device saved first. Sync again.');
   return json(200,{revision});
  }
  const shares=path.match(/^\/api\/workouts\/([a-f0-9]{64})\/shares(?:\/(u_[a-f0-9]{64}))?$/);
  if(shares){
   const key=shares[1],target=shares[2];
   if(!catalog((await library(uid))?.data).some(w=>w.key===key))fail(404,'Workout not found. Sync it first.');
   const prefix='accounts/'+uid+'/shares/'+key;
   if(req.method==='GET'&&!target)return json(200,Object.values(await accounts.get(prefix)||{}));
   if(req.method==='POST'&&!target){
    const name=username((await read(req)).username);if(!name)fail(400,'Enter a username.');const person=await accounts.lookup(name);if(!person)fail(404,'No account with that username. Ask them to sign up first.');if(person.uid===uid)fail(400,'This workout already belongs to you.');
    // Index first: a stale inbox entry grants no access. The authoritative grant
    // commits with a fresh library check, so concurrent deletion cannot revive it.
    await accounts.update({['inboxes/'+person.uid+'/'+uid+'_'+key]:{owner:uid,key,username:user.username}});
    const committed=await accounts.transaction('accounts/'+uid,current=>{
     if(!current?.library||!catalog(JSON.parse(current.library.data)).some(w=>w.key===key))return;
     const recipients=current.shares?.[key]||{};
     if(Object.keys(recipients).length>=100&&!recipients[person.uid])return;
     current.shares??={};current.shares[key]={...recipients,[person.uid]:{uid:person.uid,username:person.username}};return current;
    });
    if(!committed)fail(409,'The workout changed or has 100 recipients. Refresh and try again.');
    return json(200,{ok:true});
   }
   if(req.method==='DELETE'&&target){await accounts.update({[prefix+'/'+target]:null,['inboxes/'+target+'/'+uid+'_'+key]:null});return json(200,{ok:true});}
   return json(405,{error:'Method not allowed'});
  }
  if(path==='/api/shared'&&req.method==='GET'){
   const inbox=Object.values(await accounts.get('inboxes/'+uid)||{}),result=[];
   for(const entry of inbox){if(!await accounts.get('accounts/'+entry.owner+'/shares/'+entry.key+'/'+uid))continue;const item=catalog((await library(entry.owner))?.data).find(w=>w.key===entry.key);if(item)result.push({...item,owner:entry.owner,username:entry.username});}
   return json(200,result);
  }
  const media=path.match(/^\/api\/media\/(u_[a-f0-9]{64})\/([a-f0-9]{64})$/);
  if(media){
   if(!store)fail(503,'File storage is not configured.');
   const owner=media[1],id=media[2],key='accounts/'+owner+'/media/'+id;
   if(req.method==='GET'){
    if(owner!==uid){
     const grants=await accounts.get('accounts/'+owner+'/shares')||{};
     const permitted=catalog((await library(owner))?.data).some(item=>grants[item.key]?.[uid]&&[item.workout,...item.workout.sets,...item.videos].some(i=>{const ref=i.imageRef||i.drive;return ref?.owner===owner&&ref.id===id;}));
     if(!permitted)fail(403,'This workout is no longer shared with you.');
    }
    if(!await store.exists(key))fail(404,'File not found.');return json(200,{url:await store.url(key,60)});
   }
   if(req.method!=='PUT')return json(405,{error:'Method not allowed'});
   if(owner!==uid)fail(403,'You can upload only to your own account.');
   const size=Number(req.headers['content-length']);if(!Number.isSafeInteger(size)||size<=0||size>512*1024*1024)fail(413,'Choose a file smaller than 512 MB.');
   if(activeUploads.size>=3||activeUploads.has(key))fail(429,'Another upload is in progress. Retry shortly.');if(!allowWrite(size))fail(429,'Upload limit reached. Retry later.');
   activeUploads.add(key);
   try{
    if(await store.exists(key)){req.resume();return json(200,{ok:true});}
    const {Transform}=require('node:stream');let received=0;const digest=createHash('sha256');
    const checked=new Transform({transform(chunk,encoding,done){received+=chunk.length;if(received>size)return done(Error('Upload too large'));digest.update(chunk);done(null,chunk);},flush(done){done(received===size&&digest.digest('hex')===id?null:Error('Upload integrity check failed'));}});
    req.on('error',e=>checked.destroy(e));req.on('aborted',()=>checked.destroy(Error('Upload interrupted')));req.pipe(checked);await store.upload(key,checked,size);return json(200,{ok:true});
   }finally{activeUploads.delete(key);}
  }
  return json(404,{error:'Not found'});
 };
}
module.exports={FirebaseAccounts,createAccountAPI,validateLibrary,mediaRef,workoutKey,username,uidFor,catalog};
