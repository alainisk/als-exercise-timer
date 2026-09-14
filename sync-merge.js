(() => {
'use strict';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
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
    const add=(w,vs,copy=false)=>{if(!w)return;w=structuredClone(w);if(copy){w.id=crypto.randomUUID();w.name+=' (conflict copy)';}for(const s of w.sets){const video=vs.get(s.id);if(copy){s.id=crypto.randomUUID();if(s.video?.startsWith('blob:'))s.video='blob:'+s.id;}if(video&&s.video)p.videos.push({...video,setId:s.id});}p.workouts.push(w);};
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
window.mergeLibraries=merge;
})();
