'use strict';
const {uidFor}=require('../accounts.cjs');
function memoryAccounts(){
 let tree={},tokens=new Map();const users=new Map();
 const get=path=>{let v=tree;for(const key of path.split('/'))v=v?.[key];return v==null?null:structuredClone(v);};
 const set=(path,value)=>{const keys=path.split('/');let v=tree;for(const key of keys.slice(0,-1))v=v[key]??={};if(value===null)delete v[keys.at(-1)];else v[keys.at(-1)]=structuredClone(value);};
 const accounts={
  async get(path){return get(path);},async update(changes){for(const [p,v] of Object.entries(changes))set(p,v);},async transaction(path,fn){const next=fn(get(path));if(next===undefined)return false;set(path,next);return true;},
  async lookup(name){return users.get(name)||null;},
  async authenticate(token){const u=tokens.get(token);if(!u)throw Object.assign(Error('Please log in.'),{status:401});return u;},
  add(name){const u={uid:uidFor(name),username:name};users.set(name,u);tokens.set('token-'+name,u);return u;},
  async login(input,signup){let u=users.get(input.username);if(signup&&u)throw Object.assign(Error('Already registered.'),{status:409});if(signup)u=accounts.add(input.username);if(!u||input.password!=='correct-password')throw Object.assign(Error('Invalid login.'),{status:400});return {...u,idToken:'token-'+u.username,refreshToken:'refresh-'+u.username,expiresIn:3600};},
  async refresh(input){const name=input.refreshToken.replace('refresh-','');return accounts.login({username:name,password:'correct-password'});},async reset(){return {ok:true};}
 };
 return accounts;
}
function memoryStore(){const media=new Map();return {media,async exists(key){return media.has(key);},async upload(key,stream){const chunks=[];for await(const chunk of stream)chunks.push(chunk);media.set(key,Buffer.concat(chunks));},async url(key){return 'https://test.storageapi.dev/'+key;}};}
const workout=(id='workout-1')=>({id,name:'Morning intervals',initialCountdown:7,warmupDuration:0,numberOfCycles:1,recoveryDuration:0,cooldownDuration:0,image:null,sets:[{id:'set-'+id,name:'Squats',exerciseDuration:20,restDuration:10,color:'#e86c3a',video:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',image:null,sound:'default'}]});
const library=()=>({version:2,profiles:[{id:'default',name:'My profile',workouts:[workout()],videos:[]}]});
module.exports={memoryAccounts,memoryStore,workout,library};
