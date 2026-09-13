const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Execute the actual application logic with deterministic time and inert browser services.
function app() {
  let now = 100000, uuid = 0;
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', disabled: false, className: '',
      classList: {add(){},remove(){},toggle(){},contains(){return true;}},
      style: {setProperty(){}}, setAttribute(){}, toggleAttribute(){},
      pause(){}, play(){return Promise.resolve();}
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    crypto:{randomUUID:()=> uuid++ === 0 ? 'new-empty-profile' : 'test-id-' + uuid}, localStorage:{setItem(){}}, URL: {revokeObjectURL(){}}, structuredClone, Set, queueMicrotask, Date: class extends Date {static now(){return now;}},
    setInterval: () => 1, clearInterval(){},
    window: {scrollTo(){},speechSynthesis:{cancel(){}}},
    document: {getElementById:element,querySelector:element,querySelectorAll:()=>[]}
  });
  const code = fs.readFileSync(require.resolve('../app.js'),'utf8').replace('\ninit();\n', `
    playSound = vibrate = announcePhase = requestWakeLock = releaseWakeLock = startSilentAudio = stopSilentAudio = speak = () => {};
    saveSettings = () => Promise.resolve();
    state.workouts = [structuredClone(DEFAULT_WORKOUT)];
    state.activeWorkoutId = DEFAULT_WORKOUT.id;
    globalThis.testApp = {state, DEFAULT_WORKOUT, buildPhaseSequence, calcWorkoutTotalTime, pauseTimer, startPhase, skipToNext, timerTick, portableSettings, validateWorkoutData, commitEditedWorkout, discardEditorMedia, loadData, profileDatabase, deleteWorkout, deleteProfile, cloneForTransfer, transferWorkout, workoutHash, parseWorkoutHash, loadProfiles, mergeWorkouts, familySnapshot,
      familyFixture(items,read,media) {profiles=items; familyRead=read; window.DriveMedia=media; familyDatabase=async()=>({close(){},transaction(){const tx={objectStore(){return {put(){}};}};queueMicrotask(()=>tx.oncomplete());return tx;}});},
      registry(raw) {localStorage.getItem=()=>raw;},
      transferFixture(write,read,remove) {profiles=[{id:"default"},{id:"son"}]; activeProfileId="default"; writeTransferredWorkout=write; dbGet=read; deleteWorkout=remove;},
      profileFixture(items,active,clear) { profiles=items; activeProfileId=active; clearProfileData=clear; switchProfile=async id=>{activeProfileId=id;}; },
      profileState() {return {profiles,activeProfileId};},
      storage(read,write) {dbGetAll=read; dbPut=write;},
      stageVideo(id,file,url) {pendingVideos.set(id,{file,url});},
      database(value) {db=value;},
      pendingCount() {return pendingVideos.size;},
      sequence(value) {phaseSequence = value; currentPhaseIdx = 0;}
    };
  `);
  vm.runInContext(code,context);
  return {...context.testApp, clock(value){now=value;}, element};
}

test('Classic Tabata preview and runnable phases both total 4:07', () => {
  const a=app(), w=a.DEFAULT_WORKOUT, sequence=a.buildPhaseSequence(w);
  assert.equal(a.calcWorkoutTotalTime(w),247);
  assert.equal(sequence.reduce((sum,p)=>sum+p.duration,0),247);
  assert.equal(sequence.length,17);
  assert.equal(sequence[0].phase,'countdown');
  assert.equal(sequence[16].phase,'rest');
});

test('Warmup, cycle recovery and cooldown appear once in the right positions', () => {
  const a=app(); const w={...a.DEFAULT_WORKOUT,initialCountdown:0,warmupDuration:5,numberOfCycles:2,recoveryDuration:15,cooldownDuration:8,sets:[{exerciseDuration:20,restDuration:0}]};
  const sequence=a.buildPhaseSequence(w);
  assert.deepEqual(Array.from(sequence,p=>p.phase),['warmup','exercise','recovery','exercise','cooldown']);
  assert.equal(a.calcWorkoutTotalTime(w),68);
  assert.equal(sequence.reduce((sum,p)=>sum+p.duration,0),68);
});

test('Pause/resume preserves milliseconds instead of rounding up a second', () => {
  const a=app(), t=a.state.timer;
  a.sequence([{phase:"exercise",duration:20,setIndex:0,cycle:0}]);
  Object.assign(t,{isRunning:true,isPaused:false,targetTime:120000,timeRemaining:20,startTime:100000});
  a.clock(100250); a.pauseTimer();
  assert.equal(t.pausedRemaining,19750);
  a.clock(105000); a.pauseTimer();
  assert.equal(t.targetTime,124750);
  assert.equal(t.startTime,104750);
  assert.equal(a.element('timer-status').textContent,'REMAINING');
});

test('Skipping while paused resets the new interval and stays paused', () => {
  const a=app(); a.sequence(a.buildPhaseSequence(a.DEFAULT_WORKOUT));
  Object.assign(a.state.timer,{isRunning:true,isPaused:true});
  a.skipToNext();
  assert.equal(a.state.timer.phase,'exercise');
  assert.equal(a.state.timer.isPaused,true);
  assert.equal(a.state.timer.pausedRemaining,20000);
  assert.equal(a.element('timer-status').textContent,'PAUSED');
});

test('Skipping the final interval completes and restores navigation', () => {
  const a=app(); a.sequence([{phase:'exercise',duration:1,setIndex:0,cycle:0}]);
  a.state.timer.isRunning=true;
  a.skipToNext();
  assert.equal(a.state.timer.isRunning,false);
  assert.equal(a.state.timer.phase,'complete');
  assert.equal(a.element('nav-workouts').disabled,false);
});


test('A late tick catches up across intervals without extending the workout', () => {
  const a=app();
  a.sequence(a.buildPhaseSequence(a.DEFAULT_WORKOUT));
  Object.assign(a.state.timer,{isRunning:true,startTime:100000});
  a.startPhase(0);
  a.clock(132250); a.timerTick();
  assert.equal(a.state.timer.phase,'rest');
  assert.equal(a.state.timer.targetTime,137000);
  assert.equal(a.state.timer.timeRemaining,5);
});

test('Returning after the workout ends uses its scheduled completion time', () => {
  const a=app();
  a.sequence(a.buildPhaseSequence(a.DEFAULT_WORKOUT));
  Object.assign(a.state.timer,{isRunning:true,startTime:100000,totalElapsed:0});
  a.startPhase(0);
  a.clock(500000); a.timerTick();
  assert.equal(a.state.timer.phase,'complete');
  assert.equal(a.element('complete-time').textContent,'04:07');
});

test('Completion reads the clock rather than a stale elapsed-display tick', () => {
  const a=app(); a.sequence([{phase:'exercise',duration:1,setIndex:0,cycle:0}]);
  Object.assign(a.state.timer,{isRunning:true,startTime:100000,totalElapsed:0});
  a.startPhase(0); a.clock(101000); a.timerTick();
  assert.equal(a.element('complete-time').textContent,'00:01');
});

test('Portable preferences omit credentials without changing device settings', () => {
  const a=app(); const settings={mute:true,syncToken:'test-secret',syncGistId:'test-gist'};
  const portable=a.portableSettings(settings);
  assert.equal(portable.mute,true);
  assert.equal('syncToken' in portable,false);
  assert.equal('syncGistId' in portable,false);
  assert.equal(settings.syncToken,'test-secret');
});

test('Malformed backup intervals are rejected before they can poison saved workouts', () => {
  const a=app();
  for (const invalid of [-1,0,1.5,'20',Infinity]) {
    const w=structuredClone(a.DEFAULT_WORKOUT); w.sets[0].exerciseDuration=invalid;
    assert.throws(()=>a.validateWorkoutData([w]));
  }
  const w=structuredClone(a.DEFAULT_WORKOUT); w.sets=[];
  assert.throws(()=>a.validateWorkoutData([w]));
  assert.doesNotThrow(()=>a.validateWorkoutData([a.DEFAULT_WORKOUT]));
});


test('Video replacements and workout references commit in a single transaction', async () => {
  const a=app(), writes=[];
  const workout=structuredClone(a.DEFAULT_WORKOUT), id=workout.sets[0].id;
  const file={type:'video/mp4'};
  workout.sets[0].video='blob:'+id;
  a.stageVideo(id,file,'blob:test');
  assert.equal(writes.length,0);
  a.database({transaction(stores,mode) {
    assert.deepEqual(Array.from(stores),['workouts','videos']);
    assert.equal(mode,'readwrite');
    const tx={objectStore(store){return {put(value){writes.push({store,value});}};}};
    queueMicrotask(()=>tx.oncomplete());
    return tx;
  }});
  await a.commitEditedWorkout(workout);
  assert.deepEqual(writes.map(w=>w.store),['workouts','videos']);
  assert.equal(writes[1].value.blob,file);
  assert.equal(a.state.workouts[0].sets[0].video,'blob:'+id);
});

test('Discarding staged videos leaves the saved workout unchanged', () => {
  const a=app(), id=a.DEFAULT_WORKOUT.sets[0].id;
  a.stageVideo(id,{type:'video/mp4'},'blob:cancelled');
  a.discardEditorMedia();
  assert.equal(a.pendingCount(),0);
  assert.equal(a.state.workouts[0].sets[0].video,null);
});

test('A failed media save does not update the in-memory saved workout', async () => {
  const a=app(), workout=structuredClone(a.DEFAULT_WORKOUT);
  workout.name='Unsaved';
  a.database({transaction() {
    const tx={error:new Error('quota'),objectStore(){return {put(){}};}};
    queueMicrotask(()=>tx.onabort());
    return tx;
  }});
  await assert.rejects(a.commitEditedWorkout(workout),/quota/);
  assert.equal(a.state.workouts[0].name,'Classic Tabata');
});


test('Removing a saved video deletes its blob only during workout commit', async () => {
  const a=app(), removed=[];
  const id=a.state.workouts[0].sets[0].id;
  a.state.workouts[0].sets[0].video='blob:'+id;
  const edited=structuredClone(a.state.workouts[0]);
  edited.sets[0].video=null;
  a.database({transaction() {
    const tx={objectStore(){return {put(){},delete(id){removed.push(id);}};}};
    queueMicrotask(()=>tx.oncomplete()); return tx;
  }});
  assert.equal(removed.length,0);
  await a.commitEditedWorkout(edited);
  assert.deepEqual(removed,[id]);
});


test('Profiles use independent databases while preserving the original database', () => {
  const a=app();
  assert.equal(a.profileDatabase('default'),'AlsExerciseTimer');
  assert.notEqual(a.profileDatabase('father'),a.profileDatabase('son'));
});

test('Migrating existing workouts preserves them in the default profile', async () => {
  const a=app(), existing=structuredClone(a.DEFAULT_WORKOUT), writes=[];
  existing.name='My saved workout';
  a.storage(async store=>store==='workouts' ? [existing] : [],async(store,value)=>writes.push({store,value}));
  await a.loadData(true);
  assert.equal(a.state.workouts.length,1);
  assert.equal(a.state.workouts[0].name,'My saved workout');
  assert.equal(writes.some(w=>w.store==='workouts'),false);
});

test('Deleting the final workout stays empty on reload', async () => {
  const a=app();
  a.storage(async store=>store==='workouts' ? [] : [{key:'initialized',value:true}],async()=>{});
  await a.loadData(true);
  assert.equal(a.state.workouts.length,0);
  assert.equal(a.state.activeWorkoutId,null);
});

test('A newly created profile starts empty rather than inheriting another library', async () => {
  const a=app(); a.storage(async()=>[],async()=>{});
  await a.loadData(false);
  assert.equal(a.state.workouts.length,0);
  assert.equal(a.state.settings.syncToken,'');
});

test('Deleting the last workout removes it and selects no stale workout', async () => {
  const a=app(), deleted=[];
  a.database({transaction(){
    const tx={objectStore(store){return {delete(id){deleted.push({store,id});}};}};
    queueMicrotask(()=>tx.oncomplete()); return tx;
  }});
  await a.deleteWorkout('classic-tabata');
  assert.equal(a.state.workouts.length,0);
  assert.equal(a.state.activeWorkoutId,null);
  assert.equal(deleted[0].id,'classic-tabata');
});


test('Deleting an inactive profile clears only that profile and preserves the current user', async () => {
  const a=app(), cleared=[];
  a.profileFixture([{id:'parent',name:'Parent'},{id:'son',name:'Son'}],'parent',async id=>cleared.push(id));
  await a.deleteProfile('son');
  assert.deepEqual(cleared,['son']);
  assert.equal(a.profileState().activeProfileId,'parent');
  assert.equal(a.profileState().profiles.length,1);
});

test('Deleting the active profile switches to a surviving profile', async () => {
  const a=app();
  a.profileFixture([{id:'parent',name:'Parent'},{id:'son',name:'Son'}],'son',async()=>{});
  await a.deleteProfile('son');
  assert.equal(a.profileState().activeProfileId,'parent');
  assert.equal(a.profileState().profiles[0].id,'parent');
});

test('Deleting the final profile creates a fresh empty profile with a different database', async () => {
  const a=app(); a.profileFixture([{id:'default',name:'Only user'}],'default',async()=>{});
  await a.deleteProfile('default');
  assert.equal(a.profileState().profiles.length,1);
  assert.equal(a.profileState().activeProfileId,'new-empty-profile');
});

test('A failed profile clear retains its registry entry for retry', async () => {
  const a=app();
  a.profileFixture([{id:'parent',name:'Parent'},{id:'son',name:'Son'}],'parent',async()=>{throw new Error('storage failure');});
  await assert.rejects(a.deleteProfile('son'),/storage failure/);
  assert.equal(a.profileState().profiles.length,2);
});

test('Profile deletion is unavailable during an active workout', async () => {
  const a=app(); let cleared=false;
  a.profileFixture([{id:'parent',name:'Parent'}],'parent',async()=>{cleared=true;});
  a.state.timer.isRunning=true;
  await a.deleteProfile('parent');
  assert.equal(cleared,false);
});


test('Transfer gives workouts and exercises independent IDs without changing the original', () => {
  const a=app(), source=structuredClone(a.DEFAULT_WORKOUT);
  source.sets[0].video='blob:original';
  const copy=a.cloneForTransfer(source);
  assert.notEqual(copy.id,source.id);
  assert.equal(new Set(copy.sets.map(s=>s.id)).size,copy.sets.length);
  assert.equal(copy.sets[0].video,'blob:'+copy.sets[0].id);
  copy.sets[0].name='Changed';
  assert.notEqual(source.sets[0].name,'Changed');
});

test('Copy preserves the source and remaps stored video records', async () => {
  const a=app(); let saved,removed=false;
  a.state.workouts[0].sets[0].video='blob:original';
  a.transferFixture(async (id,w,v)=>{saved={id,w,v};},async()=>({setId:'old',blob:'video bytes'}),async()=>{removed=true;});
  await a.transferWorkout('classic-tabata','son','copy');
  assert.equal(saved.id,'son');
  assert.equal(saved.v[0].setId,saved.w.sets[0].id);
  assert.equal(saved.v[0].blob,'video bytes');
  assert.equal(removed,false);
});

test('Move removes the original only after destination commit', async () => {
  const a=app(), order=[];
  a.transferFixture(async()=>{order.push('commit');},async()=>null,async()=>{order.push('remove');});
  await a.transferWorkout('classic-tabata','son','move');
  assert.deepEqual(order,['commit','remove']);
});

test('Destination failure keeps the original workout', async () => {
  const a=app(); let removed=false;
  a.transferFixture(async()=>{throw new Error('disk full');},async()=>null,async()=>{removed=true;});
  await assert.rejects(a.transferWorkout('classic-tabata','son','move'),/disk full/);
  assert.equal(removed,false);
});

test('Missing media aborts transfer before either library is changed', async () => {
  const a=app(); let wrote=false;
  a.state.workouts[0].sets[0].video='blob:missing';
  a.transferFixture(async()=>{wrote=true;},async()=>null,async()=>{});
  await assert.rejects(a.transferWorkout('classic-tabata','son','move'),/video is missing/);
  assert.equal(wrote,false);
});

test('Source cleanup failure explains that both copies are retained', async () => {
  const a=app();
  a.transferFixture(async()=>{},async()=>null,async()=>{throw new Error('failed');});
  await assert.rejects(a.transferWorkout('classic-tabata','son','move'),/Both copies have been kept/);
});

test('Workout URL safely encodes IDs and rejects malformed links', () => {
  const a=app(), route=a.parseWorkoutHash(a.workoutHash('A/B','work out#1'));
  assert.equal(route.profileId,'A/B');
  assert.equal(route.workoutId,'work out#1');
  assert.equal(a.parseWorkoutHash('#/workout/a/%ZZ'),null);
  assert.equal(a.parseWorkoutHash('#/workout/a'),null);
});


test('Malformed profile metadata recovers the original library', () => {
  const a=app(); a.registry('{broken'); a.loadProfiles();
  assert.equal(a.profileState().activeProfileId,'default');
});

test('Invalid and duplicate profile entries do not hide surviving profiles', () => {
  const a=app(); a.registry(JSON.stringify({profiles:[null,{id:'son',name:'Son'},{id:'son',name:'Duplicate'},{id:5,name:'Invalid'}],activeId:'son'}));
  a.loadProfiles();
  assert.equal(a.profileState().profiles.length,1);
  assert.equal(a.profileState().activeProfileId,'son');
});

test('An empty profile backup is valid', () => {
  assert.doesNotThrow(()=>app().validateWorkoutData([]));
});

test('Import failure keeps visible workouts and preferences unchanged', async () => {
  const a=app(), original=a.state.workouts;
  a.database({transaction(){const tx={error:new Error('quota exceeded'),objectStore(){return {put(){}};}};queueMicrotask(()=>tx.onabort());return tx;}});
  const workout=structuredClone(a.DEFAULT_WORKOUT); workout.id='imported';
  await assert.rejects(a.mergeWorkouts([workout],{theme:'light'}),/quota exceeded/);
  assert.equal(a.state.workouts,original);
  assert.notEqual(a.state.settings.theme,'light');
});

test('Import commits workouts and preferences together and selects a workout in an empty profile', async () => {
  const a=app(), stores=[]; a.state.workouts=[]; a.state.activeWorkoutId=null;
  a.database({transaction(names){assert.equal(Array.from(names).join(','),'workouts,settings');const tx={objectStore(name){return {put(){stores.push(name);}};}};queueMicrotask(()=>tx.oncomplete());return tx;}});
  await a.mergeWorkouts([a.DEFAULT_WORKOUT],{syncToken:'must-not-import'});
  assert.deepEqual(stores,['workouts','settings']);
  assert.equal(a.state.activeWorkoutId,a.DEFAULT_WORKOUT.id);
  assert.notEqual(a.state.settings.syncToken,'must-not-import');
});


test('A family with over 100 MB of videos serializes only Drive references', async () => {
  const a=app(),w=structuredClone(a.DEFAULT_WORKOUT);let uploaded=0;
  w.sets.slice(0,3).forEach(s=>s.video='blob:'+s.id);
  const records=w.sets.slice(0,3).map(s=>({setId:s.id,blob:{size:45*1024*1024,type:'video/mp4'}}));
  a.familyFixture([{id:'parent',name:'Parent'}],async(_db,store)=>store==='workouts'?[w]:records,{upload:async blob=>{uploaded+=blob.size;return {provider:'drive',id:'file_'+uploaded,hash:'a'.repeat(64),size:blob.size,mimeType:blob.type};},validRef:ref=>ref?.provider==='drive'});
  const data=await a.familySnapshot();
  assert.equal(uploaded,135*1024*1024);
  assert.ok(JSON.stringify(data).length<10000);
  assert.equal(data.profiles[0].videos.length,3);
  assert.equal(data.profiles[0].videos[0].data,undefined);
});

test('Metadata can sync without downloading remote-only videos', async () => {
  const a=app(),w=structuredClone(a.DEFAULT_WORKOUT),ref={provider:'drive',id:'remote_file',hash:'a'.repeat(64),size:100,mimeType:'video/mp4'};
  w.sets[0].video='blob:'+w.sets[0].id;
  a.familyFixture([{id:'parent',name:'Parent'}],async(_db,store)=>store==='workouts'?[w]:[{setId:w.sets[0].id,drive:ref}],{upload:async()=>{throw Error('should not upload');},validRef:ref=>ref?.provider==='drive'});
  const data=await a.familySnapshot();assert.equal(data.profiles[0].videos[0].drive.id,'remote_file');
});
