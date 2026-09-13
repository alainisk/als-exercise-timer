const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Execute the actual application logic with deterministic time and inert browser services.
function app() {
  let now = 100000;
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
    URL: {revokeObjectURL(){}}, structuredClone, Set, Date: class extends Date {static now(){return now;}},
    setInterval: () => 1, clearInterval(){},
    window: {scrollTo(){},speechSynthesis:{cancel(){}}},
    document: {getElementById:element,querySelector:element,querySelectorAll:()=>[]}
  });
  const code = fs.readFileSync(require.resolve('../app.js'),'utf8').replace('\ninit();\n', `
    playSound = vibrate = announcePhase = requestWakeLock = releaseWakeLock = startSilentAudio = stopSilentAudio = speak = () => {};
    saveSettings = () => Promise.resolve();
    state.workouts = [structuredClone(DEFAULT_WORKOUT)];
    state.activeWorkoutId = DEFAULT_WORKOUT.id;
    globalThis.testApp = {state, DEFAULT_WORKOUT, buildPhaseSequence, calcWorkoutTotalTime, pauseTimer, startPhase, skipToNext, timerTick, portableSettings, validateWorkoutData, commitEditedWorkout, discardEditorMedia, loadData, profileDatabase, deleteWorkout,
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
