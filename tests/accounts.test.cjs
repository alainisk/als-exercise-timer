'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createServer}=require('../server.cjs');
const {validateLibrary,uidFor,username,workoutKey}=require('../accounts.cjs');
const {memoryAccounts,memoryStore,library}=require('./account-fixture.cjs');
test('Firebase transactions retry an initially empty cache without accepting missing records',async()=>{
 const {FirebaseAccounts}=require('../accounts.cjs');const service=Object.create(FirebaseAccounts.prototype);
 service.db={ref(){return {async transaction(fn){assert.equal(fn(null),null);assert.deepEqual(fn({exists:true}),{exists:true,saved:true});return {committed:true};}};}};
 assert.equal(await service.transaction('record',current=>current?{...current,saved:true}:undefined),true);
 service.db={ref(){return {async transaction(fn){assert.equal(fn(null),null);return {committed:true};}};}};
 assert.equal(await service.transaction('missing',()=>undefined),false);
});
async function fixture(t){
 const accounts=memoryAccounts(),store=memoryStore();const alice=accounts.add('alice'),bob=accounts.add('bob'),eve=accounts.add('eve');
 const server=createServer(store,{accounts});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const url='http://127.0.0.1:'+server.address().port;
 const request=(user,path,method='GET',data)=>fetch(url+'/api'+path,{method,headers:{...(user?{Authorization:'Bearer token-'+user}:{}),'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const save=(user,data,revision=null)=>request(user,'/library','PUT',{data,revision});
 return {accounts,store,alice,bob,eve,url,request,save};
}
test('Usernames normalize consistently and reject invalid account identifiers',()=>{assert.equal(username('Alain_Fit'),'alain_fit');for(const v of ['a','bad/name','a.b','a'.repeat(25),null])assert.equal(username(v),null);assert.equal(uidFor(username('ALICE')),uidFor('alice'));});
test('Account endpoints fail closed and old private links are retired',async t=>{const f=await fixture(t);assert.equal((await f.request(null,'/library')).status,401);assert.equal((await f.request('unknown','/library')).status,401);assert.equal((await f.request(null,'/families/'+'a'.repeat(64))).status,410);assert.equal((await fetch(f.url+'/accounts.cjs')).status,404);});
test('Owned libraries are isolated and stale writes cannot overwrite newer changes',async t=>{const f=await fixture(t),data=library();const saved=await (await f.save('alice',data)).json();assert.ok(saved.revision);assert.equal(await (await f.request('bob','/library')).json(),null);assert.equal((await f.save('alice',data)).status,409);data.profiles[0].workouts[0].name='Updated';assert.equal((await f.save('alice',data,saved.revision)).status,200);assert.equal((await (await f.request('alice','/library')).json()).data.profiles[0].workouts[0].name,'Updated');});
test('Sharing lists named recipients, prevents non-owner edits and revokes future reads',async t=>{
 const f=await fixture(t);await f.save('alice',library());const key=workoutKey('default','workout-1'),path='/workouts/'+key+'/shares';
 assert.equal((await f.request('alice',path,'POST',{username:'bob'})).status,200);
 assert.deepEqual(await (await f.request('alice',path)).json(),[{uid:f.bob.uid,username:'bob'}]);
 const shared=await (await f.request('bob','/shared')).json();assert.equal(shared.length,1);assert.equal(shared[0].username,'alice');assert.equal(shared[0].workout.name,'Morning intervals');
 assert.deepEqual(await (await f.request('eve','/shared')).json(),[]);
 assert.equal((await f.request('bob',path,'POST',{username:'eve'})).status,404);
 assert.equal((await f.request('bob',path+'/'+f.bob.uid,'DELETE')).status,404);
 assert.equal((await f.request('alice',path+'/'+f.bob.uid,'DELETE')).status,200);
 assert.deepEqual(await (await f.request('bob','/shared')).json(),[]);
});
test('Private uploaded media checks the current grant; another owner cannot adopt a reference',async t=>{
 const f=await fixture(t),payload=Buffer.from('test-uploaded-video'),id=createHash('sha256').update(payload).digest('hex'),ref={provider:'account',owner:f.alice.uid,id,hash:id,size:payload.length,mimeType:'video/mp4'};
 const route='/media/'+f.alice.uid+'/'+id;
 assert.equal((await fetch(f.url+'/api'+route,{method:'PUT',headers:{Authorization:'Bearer token-alice'},body:payload})).status,200);
 assert.equal((await f.request('bob',route)).status,403);
 const data=library(),set=data.profiles[0].workouts[0].sets[0];set.video='blob:'+set.id;data.profiles[0].videos=[{setId:set.id,drive:ref}];await f.save('alice',data);
 assert.equal((await f.save('bob',data)).status,400);
 const path='/workouts/'+workoutKey('default','workout-1')+'/shares';await f.request('alice',path,'POST',{username:'bob'});
 assert.equal((await f.request('bob',route)).status,200);
 await f.request('alice',path+'/'+f.bob.uid,'DELETE');assert.equal((await f.request('bob',route)).status,403);
 assert.equal((await fetch(f.url+'/api'+route,{method:'PUT',headers:{Authorization:'Bearer token-bob'},body:payload})).status,403);
});
test('Deleting a workout removes grants and does not resurrect them if its ID is reused',async t=>{
 const f=await fixture(t),data=library();let saved=await (await f.save('alice',data)).json();const path='/workouts/'+workoutKey('default','workout-1')+'/shares';await f.request('alice',path,'POST',{username:'bob'});
 const empty=library();empty.profiles[0].workouts=[];saved=await (await f.save('alice',empty,saved.revision)).json();await f.save('alice',data,saved.revision);
 assert.deepEqual(await (await f.request('bob','/shared')).json(),[]);
});
test('Server validation rejects missing uploads, dangerous links, foreign references and duplicate set IDs',()=>{
 const valid=library();assert.doesNotThrow(()=>validateLibrary(valid,uidFor('alice')));
 for(const video of ['javascript:alert(1)','https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ','blob:set-workout-1']){const data=library();data.profiles[0].workouts[0].sets[0].video=video;assert.throws(()=>validateLibrary(data,uidFor('alice')));}
 const duplicate=library();duplicate.profiles[0].workouts[0].sets.push({...duplicate.profiles[0].workouts[0].sets[0]});assert.throws(()=>validateLibrary(duplicate,uidFor('alice')));
});

test('A share racing with deletion cannot restore access when the workout ID is reused',async t=>{
 const f=await fixture(t);await f.save('alice',library());const original=f.accounts.transaction;let race=true;
 f.accounts.transaction=async(path,fn)=>{if(race&&path==='accounts/'+f.alice.uid){race=false;await f.accounts.update({[path+'/library']:null});}return original(path,fn);};
 const path='/workouts/'+workoutKey('default','workout-1')+'/shares';assert.equal((await f.request('alice',path,'POST',{username:'bob'})).status,409);
 await f.save('alice',library());assert.deepEqual(await (await f.request('bob','/shared')).json(),[]);
});

test('Firebase token verification checks revocation and rejects unsupported user IDs',async()=>{
 const {FirebaseAccounts}=require('../accounts.cjs');const service=Object.create(FirebaseAccounts.prototype);
 service.auth={async verifyIdToken(token,revoked){assert.equal(token,'signed-token');assert.equal(revoked,true);return {uid:uidFor('alice'),name:'alice'};}};
 assert.deepEqual(await service.authenticate('signed-token'),{uid:uidFor('alice'),username:'alice'});
 service.auth.verifyIdToken=async()=>({uid:'unregistered-firebase-user'});await assert.rejects(service.authenticate('signed-token'),e=>e.status===401);
 service.auth.verifyIdToken=async()=>{throw Error('Token revoked');};await assert.rejects(service.authenticate('signed-token'),e=>e.status===401);
});
