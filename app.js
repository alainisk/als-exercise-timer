/* ============================================================
   Tabata Timer — PWA Application
   ============================================================ */

(() => {
'use strict';

// ─── Constants ───────────────────────────────────────────────
const PHASES = {
  IDLE: 'idle',
  COUNTDOWN: 'countdown',
  WARMUP: 'warmup',
  EXERCISE: 'exercise',
  REST: 'rest',
  RECOVERY: 'recovery',
  COOLDOWN: 'cooldown',
  COMPLETE: 'complete'
};

const PHASE_COLORS = {
  [PHASES.COUNTDOWN]: 'countdown',
  [PHASES.WARMUP]: 'warmup',
  [PHASES.EXERCISE]: 'exercise',
  [PHASES.REST]: 'rest',
  [PHASES.RECOVERY]: 'recovery',
  [PHASES.COOLDOWN]: 'cooldown',
};

const DEFAULT_WORKOUT = {
  id: 'classic-tabata',
  name: 'Classic Tabata',
  image: null,
  initialCountdown: 7,
  warmupDuration: 0,
  sets: Array.from({ length: 8 }, (_, i) => ({
    id: `default-set-${i}`,
    name: `Exercise ${i + 1}`,
    exerciseDuration: 20,
    restDuration: 10,
    color: '#E86C3A',
    image: null,
    video: null,
    sound: 'default'
  })),
  numberOfCycles: 1,
  recoveryDuration: 60,
  cooldownDuration: 0
};

// ─── State ───────────────────────────────────────────────────
const state = {
  workouts: [],
  activeWorkoutId: null,
  settings: {
    mute: false,
    vibration: true,
    intervalBeep: 'short-beep',
    continuousBeep: 'off',
    threeSecondBeep: 'short-beep',
    halfwayBeep: 'double-beep',
    voiceEnabled: true,
    voiceAnnounce: 'all',
    theme: 'dark',
    lastWorkout: null,
    lastActiveWorkoutId: null,
    syncToken: '',
    syncGistId: ''
  },
  timer: {
    phase: PHASES.IDLE,
    currentSetIndex: 0,
    currentCycle: 0,
    timeRemaining: 0,
    totalElapsed: 0,
    isRunning: false,
    isPaused: false,
    targetTime: 0,
    interval: null,
    totalElapsedInterval: null,
    pausedElapsed: 0,
    startTime: 0,
    playedSounds: new Set(),
    wakeLock: null
  },
  editingWorkout: null,
  editingSetIndex: -1,
  editingSets: []
};

// ─── Storage (IndexedDB) ────────────────────────────────────
const DB_NAME = 'AlsExerciseTimer';
const DB_VERSION = 2;
let db = null;

// Map of video setId -> blobURL for playback
const videoBlobURLs = {};

function openDB(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('workouts')) d.createObjectStore('workouts', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('videos')) d.createObjectStore('videos', { keyPath: 'setId' });
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = e => reject(e.target.error);
  });
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function saveVideoBlob(setId, blob, mimeType) {
  await dbPut('videos', { setId, blob, mimeType });
  // Revoke old URL if exists
  if (videoBlobURLs[setId]) URL.revokeObjectURL(videoBlobURLs[setId]);
  videoBlobURLs[setId] = URL.createObjectURL(blob);
}

async function getVideoBlobURL(setId) {
  if (videoBlobURLs[setId]) return videoBlobURLs[setId];
  try {
    const record = await dbGet('videos', setId);
    if (record?.blob) {
      videoBlobURLs[setId] = URL.createObjectURL(record.blob);
      return videoBlobURLs[setId];
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function deleteVideoBlob(setId) {
  try {
    if (videoBlobURLs[setId]) {
      URL.revokeObjectURL(videoBlobURLs[setId]);
      delete videoBlobURLs[setId];
    }
    await dbDelete('videos', setId);
  } catch (e) { /* ignore */ }
}

function dbPut(store, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = e => reject(e.target.error);
  });
}

function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

const DEFAULT_SETTINGS = structuredClone(state.settings);
const PROFILE_STORAGE_KEY = 'tabata-timer-profiles-v1';
let profiles = [];
let activeProfileId = 'default';
let switchingProfile = false;
let profileOperations = 0;
async function withProfileOperation(action) {
  profileOperations++;
  document.getElementById('profile-button').disabled = true;
  try { return await action(); }
  finally {
    profileOperations--;
    document.getElementById('profile-button').disabled = switchingProfile || state.timer.isRunning || profileOperations > 0;
  }
}
function loadProfiles() {
  const saved = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || 'null');
  profiles = saved?.profiles?.length ? saved.profiles : [{id:'default', name:'My profile'}];
  activeProfileId = profiles.some(p => p.id === saved?.activeId) ? saved.activeId : profiles[0].id;
  persistProfiles();
}
function persistProfiles() {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({profiles, activeId:activeProfileId}));
}
function profileDatabase(id) { return id === 'default' ? DB_NAME : `${DB_NAME}-profile-${id}`; }
async function loadData(seedDefault = true) {
  const workouts = await dbGetAll('workouts');
  const settingsRows = await dbGetAll('settings');
  const initialized = settingsRows.some(r => r.key === 'initialized');
  state.workouts = workouts;
  if (!initialized && !workouts.length && seedDefault) {
    state.workouts = [structuredClone(DEFAULT_WORKOUT)];
    await dbPut('workouts', state.workouts[0]);
  }
  await dbPut('settings', {key:'initialized', value:true});
  state.settings = structuredClone(DEFAULT_SETTINGS);
  const saved = settingsRows.find(r => r.key === 'app-settings');
  if (saved) Object.assign(state.settings, saved.value);
  state.activeWorkoutId = state.workouts.some(w => w.id === state.settings.lastActiveWorkoutId)
    ? state.settings.lastActiveWorkoutId : state.workouts[0]?.id || null;
}
function renderProfileName() {
  document.getElementById('profile-current').textContent = profiles.find(p => p.id === activeProfileId)?.name || 'My profile';
}
async function switchProfile(id) {
  if (state.timer.isRunning || switchingProfile || profileOperations || !profiles.some(p => p.id === id)) return;
  switchingProfile = true;
  const previousId = activeProfileId;
  document.getElementById('profile-button').disabled = true;
  document.getElementById('profile-close').disabled = true;
  try {
    await saveSettings();
    discardEditorMedia();
    for (const key of Object.keys(videoBlobURLs)) { URL.revokeObjectURL(videoBlobURLs[key]); delete videoBlobURLs[key]; }
    db.close();
    await openDB(profileDatabase(id));
    await loadData(id === 'default');
    activeProfileId = id;
    persistProfiles();
    GIST_FILENAME = id === 'default' ? 'als-exercise-timer-sync.json' : `tabata-timer-${id}.json`;
    document.documentElement.setAttribute('data-theme',state.settings.theme);
    renderProfileName();
    showScreen('screen-home');
    renderHomeWorkoutList();
    document.getElementById('profile-dialog').close();
  } catch (error) {
    await openDB(profileDatabase(previousId));
    await loadData(previousId === 'default');
    activeProfileId = previousId;
    renderProfileName();
    renderHomeWorkoutList();
    document.getElementById('profile-error').textContent = 'Could not open this profile. Please try again.';
  } finally {
    switchingProfile = false;
    document.getElementById('profile-button').disabled = false;
    document.getElementById('profile-close').disabled = false;
  }
}
function showProfiles() {
  if (state.timer.isRunning) return;
  const list = document.getElementById('profile-list');
  list.replaceChildren();
  for (const profile of profiles) {
    const button = document.createElement('button');
    button.className = 'profile-option' + (profile.id === activeProfileId ? ' selected' : '');
    button.textContent = profile.name + (profile.id === activeProfileId ? ' · Current' : '');
    button.addEventListener('click', () => switchProfile(profile.id));
    list.appendChild(button);
  }
  document.getElementById('profile-error').textContent = '';
  document.getElementById('profile-dialog').showModal();
}
async function addProfile(name) {
  name = name.trim();
  if (!name || name.length > 40) throw new Error('Enter a name of up to 40 characters.');
  if (profiles.some(p => p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('A profile with that name already exists.');
  const profile = {id:crypto.randomUUID(),name};
  profiles.push(profile);
  try { persistProfiles(); } catch (error) { profiles.pop(); throw error; }
  await switchProfile(profile.id);
}

async function saveSettings() {
  state.settings.lastActiveWorkoutId = state.activeWorkoutId;
  await dbPut('settings', { key: 'app-settings', value: state.settings });
}

async function saveWorkout(workout) {
  await dbPut('workouts', workout);
  const idx = state.workouts.findIndex(w => w.id === workout.id);
  if (idx >= 0) state.workouts[idx] = workout;
  else state.workouts.push(workout);
}

async function deleteWorkout(id) {
  const workout = state.workouts.find(w => w.id === id);
  if (!workout) return;
  await new Promise((resolve,reject) => {
    const tx = db.transaction(['workouts','videos'],'readwrite');
    tx.objectStore('workouts').delete(id);
    for (const set of workout.sets) {
      if (set.video && !state.workouts.some(w => w.id !== id && w.sets.some(s => s.id === set.id && s.video))) tx.objectStore('videos').delete(set.id);
    }
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not delete workout'));
  });
  for (const set of workout.sets) {
    if (videoBlobURLs[set.id]) { URL.revokeObjectURL(videoBlobURLs[set.id]); delete videoBlobURLs[set.id]; }
  }
  state.workouts = state.workouts.filter(w => w.id !== id);
  if (state.activeWorkoutId === id) {
    state.activeWorkoutId = state.workouts[0]?.id || null;
    await saveSettings();
  }
}

// ─── Sound Manager (Web Audio API) ──────────────────────────
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTone(freq, duration, type = 'sine', sweep = null) {
  if (state.settings.mute) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    if (sweep) osc.frequency.linearRampToValueAtTime(sweep, ctx.currentTime + duration);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (e) { /* ignore audio errors */ }
}

function playSound(soundType) {
  if (state.settings.mute) return;
  switch (soundType) {
    case 'short-beep': playTone(880, 0.15); break;
    case 'double-beep':
      playTone(880, 0.1);
      setTimeout(() => playTone(880, 0.1), 200);
      break;
    case 'whistle': playTone(600, 0.35, 'sine', 1200); break;
    case 'bell':
      playTone(523, 0.3, 'triangle');
      playTone(659, 0.3, 'triangle');
      playTone(784, 0.3, 'triangle');
      break;
    case 'rapid':
      for (let i = 0; i < 4; i++) setTimeout(() => playTone(1000, 0.06), i * 120);
      break;
    case 'long-beep': playTone(660, 0.4); break;
    case 'complete':
      playTone(523, 0.15);
      setTimeout(() => playTone(659, 0.15), 180);
      setTimeout(() => playTone(784, 0.15), 360);
      setTimeout(() => playTone(1047, 0.3), 540);
      break;
  }
}

function vibrate(pattern) {
  if (!state.settings.vibration || state.settings.mute) return;
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// ─── Speech Manager ─────────────────────────────────────────
function speak(text) {
  if (!state.settings.voiceEnabled || state.settings.mute) return;
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.1;
  u.pitch = 1;
  window.speechSynthesis.speak(u);
}

function announcePhase(phase, setName) {
  const mode = state.settings.voiceAnnounce;
  if (mode === 'exercises' && phase !== PHASES.EXERCISE) return;
  if (phase === PHASES.EXERCISE) {
    if (mode === 'intervals') speak('Exercise');
    else speak(setName || 'Exercise');
  } else if (phase === PHASES.REST) {
    if (mode !== 'exercises') speak('Rest');
  } else if (phase === PHASES.RECOVERY) {
    if (mode !== 'exercises') speak('Recovery');
  } else if (phase === PHASES.WARMUP) {
    if (mode !== 'exercises') speak('Warm up');
  } else if (phase === PHASES.COOLDOWN) {
    if (mode !== 'exercises') speak('Cool down');
  } else if (phase === PHASES.COUNTDOWN) {
    if (mode !== 'exercises') speak('Get ready');
  }
}

// ─── Wake Lock (keep screen on) ─────────────────────────────
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.timer.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* not supported or denied */ }
}

function releaseWakeLock() {
  if (state.timer.wakeLock) {
    state.timer.wakeLock.release();
    state.timer.wakeLock = null;
  }
}

// ─── Background Audio (keep alive when screen locked) ───────
let silentAudio = null;

function startSilentAudio() {
  try {
    const ctx = getAudioCtx();
    if (silentAudio) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    silentAudio = { osc, gain };
  } catch (e) { /* ignore */ }
}

function stopSilentAudio() {
  if (silentAudio) {
    try { silentAudio.osc.stop(); } catch (e) {}
    silentAudio = null;
  }
}

// ─── Image Utilities ────────────────────────────────────────
function resizeImage(file, maxSize = 400) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > maxSize || h > maxSize) {
          if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
          else { w = Math.round(w * maxSize / h); h = maxSize; }
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function readFileAsDataURL(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.readAsDataURL(file);
  });
}

// ─── Timer Engine ───────────────────────────────────────────
function getActiveWorkout() {
  return state.workouts.find(w => w.id === state.activeWorkoutId) || state.workouts[0];
}

function buildPhaseSequence(workout) {
  const phases = [];
  if (workout.initialCountdown > 0) {
    phases.push({ phase: PHASES.COUNTDOWN, duration: workout.initialCountdown, setIndex: -1, cycle: -1 });
  }
  if (workout.warmupDuration > 0) {
    phases.push({ phase: PHASES.WARMUP, duration: workout.warmupDuration, setIndex: -1, cycle: -1 });
  }
  for (let c = 0; c < workout.numberOfCycles; c++) {
    for (let s = 0; s < workout.sets.length; s++) {
      const set = workout.sets[s];
      phases.push({ phase: PHASES.EXERCISE, duration: set.exerciseDuration, setIndex: s, cycle: c });
      if (set.restDuration > 0) {
        phases.push({ phase: PHASES.REST, duration: set.restDuration, setIndex: s, cycle: c });
      }
    }
    if (c < workout.numberOfCycles - 1 && workout.recoveryDuration > 0) {
      phases.push({ phase: PHASES.RECOVERY, duration: workout.recoveryDuration, setIndex: -1, cycle: c });
    }
  }
  if (workout.cooldownDuration > 0) {
    phases.push({ phase: PHASES.COOLDOWN, duration: workout.cooldownDuration, setIndex: -1, cycle: workout.numberOfCycles - 1 });
  }
  return phases;
}

let phaseSequence = [];
let currentPhaseIdx = 0;

function startWorkout() {
  const workout = getActiveWorkout();
  if (!workout || workout.sets.length === 0) return;

  // Initialize audio context on user gesture
  try { getAudioCtx(); } catch (e) { /* Timing works without audio support. */ }

  phaseSequence = buildPhaseSequence(workout);
  if (phaseSequence.length === 0) return;

  currentPhaseIdx = 0;
  state.timer.totalElapsed = 0;
  updateElapsedDisplay();
  state.timer.pausedElapsed = 0;
  state.timer.isRunning = true;
  state.timer.isPaused = false;
  state.timer.playedSounds = new Set();

  requestWakeLock();
  startSilentAudio();
  document.getElementById('session-workout').textContent = workout.name;
  updateMuteButton();
  showScreen('screen-timer');
  startElapsedCounter();
  startPhase(currentPhaseIdx);
}

function startPhase(idx, deadline) {
  if (idx >= phaseSequence.length) {
    completeWorkout();
    return;
  }
  currentPhaseIdx = idx;
  const p = phaseSequence[idx];
  const workout = getActiveWorkout();

  state.timer.phase = p.phase;
  state.timer.currentSetIndex = p.setIndex;
  state.timer.currentCycle = p.cycle;
  state.timer.timeRemaining = deadline === undefined ? p.duration : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  state.timer.playedSounds = new Set();
  document.getElementById('timer-countdown').classList.remove('pulsing');
  state.timer.targetTime = deadline ?? (Date.now() + p.duration * 1000);
  state.timer.pausedRemaining = p.duration * 1000;

  // Sound & speech
  const setData = p.setIndex >= 0 ? workout.sets[p.setIndex] : null;
  const soundType = (setData?.sound && setData.sound !== 'default') ? setData.sound : state.settings.intervalBeep;
  if (soundType !== 'off') playSound(soundType);
  vibrate([100]);
  announcePhase(p.phase, setData?.name);

  updateTimerUI();
  clearInterval(state.timer.interval);
  state.timer.interval = setInterval(timerTick, 100);
}

function timerTick() {
  if (!state.timer.isRunning || state.timer.isPaused) return;
  const now = Date.now();
  // Preserve scheduled deadlines even when the browser throttles background ticks.
  if (now >= state.timer.targetTime) {
    let idx = currentPhaseIdx;
    let deadline = state.timer.targetTime;
    while (now >= deadline) {
      idx++;
      if (idx >= phaseSequence.length) { completeWorkout(deadline); return; }
      deadline += phaseSequence[idx].duration * 1000;
    }
    startPhase(idx, deadline);
  }
  const remaining = Math.max(0, (state.timer.targetTime - now) / 1000);
  const secondsLeft = Math.ceil(remaining);
  state.timer.timeRemaining = secondsLeft;

  const p = phaseSequence[currentPhaseIdx];
  const played = state.timer.playedSounds;
  const halfwayPoint = Math.ceil(p.duration / 2);

  // Halfway beep
  if (state.settings.halfwayBeep !== 'off' && secondsLeft === halfwayPoint && !played.has('half')) {
    playSound(state.settings.halfwayBeep);
    played.add('half');
  }

  // Three second beeps
  if (state.settings.threeSecondBeep !== 'off') {
    for (let t = 3; t >= 1; t--) {
      if (secondsLeft === t && !played.has(`three-${t}`)) {
        playSound(state.settings.threeSecondBeep);
        vibrate([50]);
        played.add(`three-${t}`);
      }
    }
  }

  // Continuous beep in last 3 seconds
  if (state.settings.continuousBeep !== 'off' && secondsLeft <= 3 && secondsLeft > 0) {
    const key = `cont-${secondsLeft}-${Math.floor((now % 1000) / 250)}`;
    if (!played.has(key)) {
      playSound(state.settings.continuousBeep === 'rapid' ? 'rapid' : state.settings.continuousBeep);
      played.add(key);
    }
  }

  updateTimerCountdown();

  // Add pulsing class in last 3 seconds
  const countdownEl = document.getElementById('timer-countdown');
  if (secondsLeft <= 3 && secondsLeft > 0) countdownEl.classList.add('pulsing');
  else countdownEl.classList.remove('pulsing');

  if (remaining <= 0) {
    clearInterval(state.timer.interval);
    nextPhase();
  }
}

function nextPhase() {
  startPhase(currentPhaseIdx + 1);
}

function prevPhase() {
  if (currentPhaseIdx > 0) startPhase(currentPhaseIdx - 1);
  else startPhase(0);
}

function skipToNext() {
  if (state.timer.isRunning) startPhase(currentPhaseIdx + 1);
}

function pauseTimer() {
  if (!state.timer.isRunning) return;
  if (!state.timer.isPaused) {
    timerTick();
    if (!state.timer.isRunning) return;
  }
  if (state.timer.isPaused) {
    state.timer.isPaused = false;
    state.timer.targetTime = Date.now() + state.timer.pausedRemaining;
    state.timer.startTime = Date.now() - state.timer.pausedElapsed;
    requestWakeLock();
    startSilentAudio();
    updatePauseButton();
  } else {
    state.timer.pausedRemaining = Math.max(0, state.timer.targetTime - Date.now());
    state.timer.isPaused = true;
    state.timer.pausedElapsed = Date.now() - state.timer.startTime;
    releaseWakeLock();
    stopSilentAudio();
    updatePauseButton();
  }
}

function resetTimer() {
  clearInterval(state.timer.interval);
  clearInterval(state.timer.totalElapsedInterval);
  state.timer.isRunning = false;
  state.timer.isPaused = false;
  state.timer.phase = PHASES.IDLE;
  releaseWakeLock();
  stopSilentAudio();
  document.getElementById('timer-exercise-video').pause();
  window.speechSynthesis?.cancel();
  showScreen('screen-workout-start');
  updateWorkoutStartScreen();
}

function startElapsedCounter() {
  clearInterval(state.timer.totalElapsedInterval);
  state.timer.startTime = Date.now();
  state.timer.totalElapsedInterval = setInterval(() => {
    if (!state.timer.isPaused) {
      state.timer.totalElapsed = Math.floor((Date.now() - state.timer.startTime) / 1000);
      updateElapsedDisplay();
    }
  }, 500);
}

function completeWorkout(completedAt = Date.now()) {
  state.timer.totalElapsed = Math.max(0, Math.floor((state.timer.isPaused
    ? state.timer.pausedElapsed : completedAt - state.timer.startTime) / 1000));
  clearInterval(state.timer.interval);
  clearInterval(state.timer.totalElapsedInterval);
  state.timer.isRunning = false;
  state.timer.isPaused = false;
  document.getElementById('timer-exercise-video').pause();
  state.timer.phase = PHASES.COMPLETE;
  releaseWakeLock();
  stopSilentAudio();

  playSound('complete');
  vibrate([200, 100, 200, 100, 400]);
  speak('Workout complete! Great job!');

  state.settings.lastWorkout = new Date().toLocaleDateString();
  saveSettings();

  const workout = getActiveWorkout();
  document.getElementById('complete-time').textContent = formatTime(state.timer.totalElapsed);
  document.getElementById('complete-sets').textContent = workout.sets.length * workout.numberOfCycles;
  document.getElementById('complete-cycles').textContent = workout.numberOfCycles;
  showScreen('screen-complete');
}

// ─── UI Helpers ─────────────────────────────────────────────
function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function showScreen(id) {
  if (id !== 'screen-editor' && document.getElementById('screen-editor').classList.contains('active')) discardEditorMedia();
  if (id === 'screen-workout-start') { id = 'screen-home'; renderHomeWorkoutList(); }
  const settings = id === 'screen-settings';
  document.getElementById('nav-workouts').classList.toggle('selected', !settings);
  document.getElementById('btn-settings').classList.toggle('selected', settings);
  document.getElementById('nav-workouts').setAttribute('aria-current', settings ? 'false' : 'page');
  document.getElementById('btn-settings').setAttribute('aria-current', settings ? 'page' : 'false');
  document.getElementById('nav-workouts').disabled = state.timer.isRunning;
  document.getElementById('brand-home').disabled = state.timer.isRunning;
  document.getElementById('profile-button').disabled = state.timer.isRunning || switchingProfile || profileOperations > 0;
  document.getElementById('btn-settings').disabled = state.timer.isRunning;
  window.scrollTo(0, 0);
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function calcWorkoutTotalTime(w) {
  let t = (w.initialCountdown || 0) + (w.warmupDuration || 0) + (w.cooldownDuration || 0);
  const cycleTime = w.sets.reduce((sum, s) => sum + s.exerciseDuration + s.restDuration, 0);
  t += cycleTime * w.numberOfCycles;
  t += (w.recoveryDuration || 0) * Math.max(0, w.numberOfCycles - 1);
  return t;
}

// ─── Timer UI Updates ───────────────────────────────────────
function updateTimerUI() {
  const p = phaseSequence[currentPhaseIdx];
  const workout = getActiveWorkout();
  const set = p.setIndex >= 0 ? workout.sets[p.setIndex] : null;
  const timerBottom = document.querySelector('.timer-bottom');

  // Phase label
  document.getElementById('timer-phase-label').textContent = p.phase.toUpperCase();

  // Exercise name
  const nameEl = document.getElementById('timer-exercise-name');
  if (p.phase === PHASES.EXERCISE && set) {
    nameEl.textContent = set.name;
  } else if (p.phase === PHASES.REST && set) {
    const nextSet = getNextExerciseSet(currentPhaseIdx);
    nameEl.textContent = nextSet ? `Next: ${nextSet.name}` : 'Rest';
  } else if (p.phase === PHASES.RECOVERY) {
    const nextSet = getNextExerciseSet(currentPhaseIdx);
    nameEl.textContent = nextSet ? `Next: ${nextSet.name}` : 'Recovery';
  } else if (p.phase === PHASES.COUNTDOWN) {
    nameEl.textContent = 'Get Ready';
  } else if (p.phase === PHASES.WARMUP) {
    nameEl.textContent = 'Warm Up';
  } else if (p.phase === PHASES.COOLDOWN) {
    nameEl.textContent = 'Cool Down';
  }

  // Phase color class
  timerBottom.className = 'timer-bottom';
  const countdownEl = document.getElementById('timer-countdown');
  const nameElRef = document.getElementById('timer-exercise-name');
  countdownEl.classList.remove('custom-color');
  nameElRef.classList.remove('custom-color');

  if (p.phase === PHASES.EXERCISE && set?.color) {
    timerBottom.style.setProperty('--set-color', set.color);
    countdownEl.classList.add('custom-color');
    nameElRef.classList.add('custom-color');
  } else {
    timerBottom.classList.add(`phase-${PHASE_COLORS[p.phase] || 'exercise'}`);
  }

  const nextPhase = phaseSequence[currentPhaseIdx + 1];
  const nextName = nextPhase?.phase === PHASES.EXERCISE ? workout.sets[nextPhase.setIndex].name : nextPhase?.phase;
  document.getElementById('timer-up-next').textContent = nextName ? 'Up next · ' + nextName.charAt(0).toUpperCase() + nextName.slice(1) : 'Bring it home. This is your final interval.';

  // Image/Video
  updateTimerMedia(p, workout);

  // Stats
  const currentSetDisplay = p.setIndex >= 0 ? p.setIndex + 1 : (p.phase === PHASES.COUNTDOWN || p.phase === PHASES.WARMUP ? 0 : workout.sets.length);
  const currentCycleDisplay = p.cycle >= 0 ? p.cycle + 1 : (p.phase === PHASES.COUNTDOWN || p.phase === PHASES.WARMUP ? 0 : workout.numberOfCycles);

  document.getElementById('stat-set').textContent = pad2(currentSetDisplay);
  document.getElementById('stat-set-total').textContent = '/' + pad2(workout.sets.length);
  document.getElementById('stat-cycle').textContent = pad2(currentCycleDisplay);
  document.getElementById('stat-cycle-total').textContent = '/' + pad2(workout.numberOfCycles);

  updateTimerCountdown();
  updatePauseButton();
}

function updateTimerMedia(p, workout) {
  const imgEl = document.getElementById('timer-exercise-image');
  const vidEl = document.getElementById('timer-exercise-video');
  const placeholder = document.getElementById('timer-image-placeholder');

  let mediaSet = null;
  if (p.phase === PHASES.EXERCISE) {
    mediaSet = p.setIndex >= 0 ? workout.sets[p.setIndex] : null;
  } else if (p.phase === PHASES.REST || p.phase === PHASES.RECOVERY) {
    mediaSet = getNextExerciseSet(currentPhaseIdx);
  } else if (p.phase === PHASES.COUNTDOWN || p.phase === PHASES.WARMUP) {
    mediaSet = workout.sets[0] || null;
  }

  imgEl.classList.add('hidden');
  vidEl.classList.add('hidden');
  vidEl.pause();
  placeholder.classList.remove('hidden');

  if (mediaSet?.video) {
    // Get blob URL for video playback
    const setId = mediaSet.id;
    getVideoBlobURL(setId).then(blobURL => {
      if (blobURL && phaseSequence[currentPhaseIdx] === p && state.timer.isRunning) {
        vidEl.src = blobURL;
        vidEl.load();
        vidEl.classList.remove('hidden');
        placeholder.classList.add('hidden');
        if (!state.timer.isPaused) vidEl.play().catch(() => {});
      }
    });
  } else if (mediaSet?.image) {
    imgEl.src = mediaSet.image;
    imgEl.classList.remove('hidden');
    placeholder.classList.add('hidden');
  }
}

function getNextExerciseSet(fromIdx) {
  const workout = getActiveWorkout();
  for (let i = fromIdx + 1; i < phaseSequence.length; i++) {
    if (phaseSequence[i].phase === PHASES.EXERCISE) {
      return workout.sets[phaseSequence[i].setIndex];
    }
  }
  return null;
}

function updateTimerCountdown() {
  const duration = phaseSequence[currentPhaseIdx]?.duration || 1;
  const remaining = state.timer.isPaused ? state.timer.pausedRemaining / 1000 : Math.max(0,(state.timer.targetTime-Date.now())/1000);
  document.getElementById('timer-ring').style.strokeDashoffset = 100 * (1 - Math.min(1, remaining / duration));
  document.getElementById('timer-countdown').textContent = formatTime(state.timer.timeRemaining);
}

function updateElapsedDisplay() {
  document.getElementById('stat-time').textContent = formatTime(state.timer.totalElapsed);
}

function updateMuteButton() {
  const button = document.getElementById('timer-mute');
  button.textContent = state.settings.mute ? 'Sound off' : 'Sound on';
  button.setAttribute('aria-pressed', String(state.settings.mute));
}
function updatePauseButton() {
  const paused = state.timer.isPaused;
  document.getElementById('btn-pause').setAttribute('aria-label', paused ? 'Resume' : 'Pause');
  document.getElementById('pause-label').textContent = paused ? 'Resume' : 'Pause';
  document.getElementById('timer-status').textContent = paused ? 'PAUSED' : 'REMAINING';
  const video = document.getElementById('timer-exercise-video');
  if (paused) { video.pause(); window.speechSynthesis?.cancel(); }
  else if (!video.classList.contains('hidden')) video.play().catch(() => {});
  document.getElementById('pause-icon').classList.toggle('hidden', state.timer.isPaused);
  document.getElementById('play-icon').classList.toggle('hidden', !state.timer.isPaused);
}

// ─── Home Screen (Workout List) ─────────────────────────────
const editIcon = '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
function renderHomeWorkoutList() {
  const list = document.getElementById('workout-list');
  list.innerHTML = '';
  if (!state.workouts.some(w => w.id === state.activeWorkoutId)) state.activeWorkoutId = state.workouts[0]?.id;
  document.getElementById('workout-count').textContent = state.workouts.length;
  state.workouts.forEach(w => {
    const card = document.createElement('div');
    card.className = 'workout-card' + (w.id === state.activeWorkoutId ? ' selected' : '');
    card.innerHTML = `<button class="workout-select" aria-pressed="${w.id === state.activeWorkoutId}">
      <span class="workout-card-name">${escapeHtml(w.name)}</span>
      <span class="workout-card-detail" style="display:block">${w.sets.length} set${w.sets.length === 1 ? '' : 's'} · ${w.numberOfCycles} cycle${w.numberOfCycles > 1 ? 's' : ''}</span>
      <span class="workout-card-time">${formatTime(calcWorkoutTotalTime(w))}</span></button>
      <div class="workout-card-actions"><button class="btn-edit" aria-label="Edit ${escapeHtml(w.name)}">${editIcon}</button>
      ${'<button class="btn-delete" aria-label="Delete workout"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg><span>Delete</span></button>'}</div>`;
    card.querySelector('.workout-select').addEventListener('click', () => {
      state.activeWorkoutId = w.id;
      saveSettings();
      renderHomeWorkoutList();
      list.querySelector('.selected .workout-select').focus({ preventScroll: true });
    });
    card.querySelector('.btn-edit').addEventListener('click', () => openWorkoutEditor(w));
    card.querySelector('.btn-delete')?.addEventListener('click', () => {
      requestWorkoutDeletion(w);
    });
    list.appendChild(card);
  });
  renderWorkoutPreview();
}

let workoutPendingDeletion = null;
function requestWorkoutDeletion(workout) {
  workoutPendingDeletion = workout.id;
  document.getElementById('delete-message').textContent = `“${workout.name}” will be removed from this profile.`;
  document.getElementById('delete-dialog').showModal();
}

function renderWorkoutPreview() {
  const w = getActiveWorkout();
  document.querySelector('.workout-preview').classList.toggle('hidden', !w);
  document.querySelector('.sequence-panel').classList.toggle('hidden', !w);
  document.getElementById('empty-workouts').classList.toggle('hidden', !!w);
  if (!w) return;
  const work = [...new Set(w.sets.map(s => s.exerciseDuration))];
  const rest = [...new Set(w.sets.map(s => s.restDuration))];
  document.getElementById('preview-name').textContent = w.name;
  document.getElementById('preview-duration').textContent = formatTime(calcWorkoutTotalTime(w));
  document.getElementById('preview-description').textContent = work.length === 1 && rest.length === 1
    ? `${work[0]} second${work[0] === 1 ? '' : 's'} on. ${rest[0]} second${rest[0] === 1 ? '' : 's'} off. Find your rhythm.` : 'A routine built around you. One interval at a time.';
  document.getElementById('preview-work').textContent = work.length === 1 ? work[0] + 's' : 'Varied';
  document.getElementById('preview-rest').textContent = rest.length === 1 ? rest[0] + 's' : 'Varied';
  document.getElementById('preview-sets').textContent = w.sets.length;
  document.getElementById('sequence-cycles').textContent = `${w.numberOfCycles} cycle${w.numberOfCycles > 1 ? 's' : ''}`;
  const photo = document.getElementById('preview-image');
  const src = w.image || w.sets[0]?.image;
  photo.classList.toggle('hidden', !src);
  if (src) photo.src = src;
  const strip = document.getElementById('sequence-strip');
  strip.replaceChildren();
  const phases = buildPhaseSequence(w);
  const names = {countdown:'Prepare',exercise:'Work',rest:'Rest',warmup:'Warmup',recovery:'Recovery',cooldown:'Cooldown'};
  phases.slice(0,80).forEach(p => {
    const step = document.createElement('div');
    step.className = 'sequence-step ' + (p.phase === 'exercise' ? 'work' : p.phase === 'countdown' ? 'prepare' : '');
    step.innerHTML = `${names[p.phase]}<span>${p.duration}s</span>`;
    step.title = `${p.cycle >= 0 ? 'Cycle ' + (p.cycle + 1) + ' · ' : ''}${p.setIndex >= 0 ? w.sets[p.setIndex].name + ' · ' : ''}${names[p.phase]} ${p.duration}s`;
    strip.appendChild(step);
  });
  if (phases.length > 80) {
    const more = document.createElement('div'); more.className = 'sequence-step sequence-more';
    more.textContent = `+ ${phases.length - 80} intervals`; strip.appendChild(more);
  }
}

// ─── Workout Start Screen ───────────────────────────────────
function updateWorkoutStartScreen() {
  const workout = getActiveWorkout();
  if (!workout) return;

  document.getElementById('start-workout-name').textContent = workout.name;
  const totalTime = calcWorkoutTotalTime(workout);
  document.getElementById('start-workout-detail').textContent =
    `${workout.sets.length} sets \u00B7 ${workout.numberOfCycles} cycle${workout.numberOfCycles > 1 ? 's' : ''} \u00B7 ~${formatTime(totalTime)}`;
  document.getElementById('start-last-workout').textContent =
    `Last Workout: ${state.settings.lastWorkout || 'Never'}`;

  // Workout image
  const imgEl = document.getElementById('start-workout-image');
  const placeholder = document.getElementById('start-image-placeholder');
  const imgSrc = workout.image || (workout.sets[0]?.image) || null;
  if (imgSrc) {
    imgEl.src = imgSrc;
    imgEl.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    imgEl.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }
}

// ─── Settings Screen ────────────────────────────────────────
function loadSettingsUI() {
  document.getElementById('snd-mute').checked = state.settings.mute;
  document.getElementById('snd-vibration').checked = state.settings.vibration;
  document.getElementById('snd-interval').value = state.settings.intervalBeep;
  document.getElementById('snd-continuous').value = state.settings.continuousBeep;
  document.getElementById('snd-three-second').value = state.settings.threeSecondBeep;
  document.getElementById('snd-halfway').value = state.settings.halfwayBeep;
  document.getElementById('voice-enabled').checked = state.settings.voiceEnabled;
  document.getElementById('voice-announce').value = state.settings.voiceAnnounce;
  document.getElementById('theme-toggle').checked = state.settings.theme === 'light';
}

function saveSettingsFromUI() {
  state.settings.mute = document.getElementById('snd-mute').checked;
  state.settings.vibration = document.getElementById('snd-vibration').checked;
  state.settings.intervalBeep = document.getElementById('snd-interval').value;
  state.settings.continuousBeep = document.getElementById('snd-continuous').value;
  state.settings.threeSecondBeep = document.getElementById('snd-three-second').value;
  state.settings.halfwayBeep = document.getElementById('snd-halfway').value;
  state.settings.voiceEnabled = document.getElementById('voice-enabled').checked;
  state.settings.voiceAnnounce = document.getElementById('voice-announce').value;
  const newTheme = document.getElementById('theme-toggle').checked ? 'light' : 'dark';
  state.settings.theme = newTheme;
  document.documentElement.setAttribute('data-theme', newTheme);
  saveSettings();
}

// ─── Workout Editor ─────────────────────────────────────────
const pendingVideos = new Map();
let setDraft = null;
function discardEditorMedia() {
  releaseSetDraft();
  for (const pending of pendingVideos.values()) URL.revokeObjectURL(pending.url);
  pendingVideos.clear();
}
function releaseSetDraft() {
  if (setDraft?.url && pendingVideos.get(setDraft.id)?.url !== setDraft.url) URL.revokeObjectURL(setDraft.url);
  setDraft = null;
}
async function commitEditedWorkout(workout) { return withProfileOperation(() => commitEditedWorkoutInternal(workout)); }
async function commitEditedWorkoutInternal(workout) {
  // Workout references and their replacement video blobs commit together.
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['workouts', 'videos'], 'readwrite');
    tx.objectStore('workouts').put(workout);
    const previous = state.workouts.find(w => w.id === workout.id);
    for (const oldSet of previous?.sets || []) {
      if (oldSet.video && !workout.sets.some(set => set.id === oldSet.id && set.video)) {
        tx.objectStore('videos').delete(oldSet.id);
      }
    }
    for (const set of workout.sets) {
      const pending = pendingVideos.get(set.id);
      if (pending && set.video) tx.objectStore('videos').put({setId:set.id, blob:pending.file, mimeType:pending.file.type});
    }
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not save workout'));
  });
  const previous = state.workouts.find(w => w.id === workout.id);
  for (const oldSet of previous?.sets || []) {
    if (oldSet.video && !workout.sets.some(set => set.id === oldSet.id && set.video) && videoBlobURLs[oldSet.id]) {
      URL.revokeObjectURL(videoBlobURLs[oldSet.id]); delete videoBlobURLs[oldSet.id];
    }
  }
  for (const set of workout.sets) {
    if (pendingVideos.has(set.id) && videoBlobURLs[set.id]) {
      URL.revokeObjectURL(videoBlobURLs[set.id]); delete videoBlobURLs[set.id];
    }
  }
  const idx = state.workouts.findIndex(w => w.id === workout.id);
  if (idx >= 0) state.workouts[idx] = workout; else state.workouts.push(workout);
}
function openWorkoutEditor(workout) {
  discardEditorMedia();
  state.editingWorkout = workout ? structuredClone(workout) : {
    id: crypto.randomUUID(),
    name: 'New Workout',
    image: null,
    initialCountdown: 7,
    warmupDuration: 0,
    sets: [{
      id: crypto.randomUUID(),
      name: 'Exercise 1',
      exerciseDuration: 20,
      restDuration: 10,
      color: '#E86C3A',
      image: null,
      video: null,
      sound: 'default'
    }],
    numberOfCycles: 1,
    recoveryDuration: 60,
    cooldownDuration: 0
  };
  state.editingSets = state.editingWorkout.sets;

  document.getElementById('editor-title').textContent = workout ? 'Edit Workout' : 'New Workout';
  document.getElementById('edit-name').value = state.editingWorkout.name;
  document.getElementById('edit-countdown').value = state.editingWorkout.initialCountdown;
  document.getElementById('edit-warmup').value = state.editingWorkout.warmupDuration;
  document.getElementById('edit-cycles').value = state.editingWorkout.numberOfCycles;
  document.getElementById('edit-recovery').value = state.editingWorkout.recoveryDuration;
  document.getElementById('edit-cooldown').value = state.editingWorkout.cooldownDuration;

  // Workout image preview
  const imgPreview = document.getElementById('edit-workout-image-preview');
  const imgClear = document.getElementById('btn-workout-image-clear');
  if (state.editingWorkout.image) {
    imgPreview.src = state.editingWorkout.image;
    imgPreview.classList.remove('hidden');
    imgClear.classList.remove('hidden');
  } else {
    imgPreview.classList.add('hidden');
    imgClear.classList.add('hidden');
  }

  renderSetsList();
  showScreen('screen-editor');
}

function renderSetsList() {
  const list = document.getElementById('sets-list');
  list.innerHTML = '';
  state.editingSets.forEach((set, idx) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'set-card';
    card.innerHTML = `
      <div class="set-card-color" style="background:${set.color}"></div>
      <div class="set-card-thumb">
        ${set.image ? `<img src="${set.image}" alt="">` : `<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`}
      </div>
      <div class="set-card-info">
        <div class="set-card-name">${escapeHtml(set.name)}</div>
        <div class="set-card-detail">${set.exerciseDuration}s work / ${set.restDuration}s rest</div>
      </div><span class="set-edit-label">Edit</span>
    `;
    card.addEventListener('click', () => openSetEditor(idx));
    list.appendChild(card);
  });
}

function saveWorkoutFromEditor() {
  if (!validateNumbers(document.getElementById('screen-editor'))) return;
  const w = state.editingWorkout;
  w.name = document.getElementById('edit-name').value.trim() || 'Unnamed Workout';
  w.initialCountdown = parseInt(document.getElementById('edit-countdown').value) || 0;
  w.warmupDuration = parseInt(document.getElementById('edit-warmup').value) || 0;
  w.numberOfCycles = parseInt(document.getElementById('edit-cycles').value) || 1;
  w.recoveryDuration = parseInt(document.getElementById('edit-recovery').value) || 0;
  w.cooldownDuration = parseInt(document.getElementById('edit-cooldown').value) || 0;
  w.sets = state.editingSets;

  // Save workout image
  const imgPreview = document.getElementById('edit-workout-image-preview');
  if (!imgPreview.classList.contains('hidden') && imgPreview.src) {
    w.image = imgPreview.src;
  } else {
    w.image = null;
  }

  commitEditedWorkout(w).then(() => {
    state.activeWorkoutId = w.id;
    saveSettings();
    renderHomeWorkoutList();
    showScreen('screen-home');
    pushToGist(); // Sync to cloud
  }).catch(() => alert("Could not save workout. Your edits are still open; please try again."));
}

// ─── Set Editor Modal ───────────────────────────────────────
let modalReturnFocus = null;
function openSetEditor(idx) {
  modalReturnFocus = document.activeElement;
  state.editingSetIndex = idx;
  const set = idx >= 0 ? state.editingSets[idx] : {
    id: crypto.randomUUID(),
    name: `Exercise ${state.editingSets.length + 1}`,
    exerciseDuration: 20,
    restDuration: 10,
    color: '#E86C3A',
    image: null,
    video: null,
    sound: 'default'
  };

  releaseSetDraft();
  setDraft = {id:set.id, image:set.image, video:set.video, ...(pendingVideos.get(set.id) || {})};
  const draft = setDraft;
  document.getElementById('modal-set-title').textContent = idx >= 0 ? `Edit Set ${idx + 1}` : 'New Set';
  document.getElementById('set-name').value = set.name;
  document.getElementById('set-exercise-dur').value = set.exerciseDuration;
  document.getElementById('set-rest-dur').value = set.restDuration;
  document.getElementById('set-color').value = set.color;
  document.getElementById('set-sound').value = set.sound;

  // Image preview
  const imgPreview = document.getElementById('set-image-preview');
  const imgClear = document.getElementById('btn-set-image-clear');
  if (set.image) {
    imgPreview.src = set.image;
    imgPreview.classList.remove('hidden');
    imgClear.classList.remove('hidden');
  } else {
    imgPreview.classList.add('hidden');
    imgClear.classList.add('hidden');
  }

  // Clear the previous exercise immediately; ignore stale asynchronous loads.
  const vidPreview = document.getElementById('set-video-preview');
  const vidClear = document.getElementById('btn-set-video-clear');
  vidPreview.pause();
  vidPreview.removeAttribute('src');
  vidPreview.classList.add('hidden');
  vidClear.classList.toggle('hidden', !draft.video);
  if (draft.video) {
    Promise.resolve(draft.url || getVideoBlobURL(set.id)).then(blobURL => {
      if (setDraft !== draft || !draft.video || !blobURL || (draft.url && draft.url !== blobURL)) return;
      vidPreview.src = blobURL;
      vidPreview.load();
      vidPreview.classList.remove('hidden');
    });
  }

  document.getElementById('btn-set-delete').classList.toggle('hidden', idx < 0);
  document.getElementById('modal-set').classList.remove('hidden');
  document.getElementById('screen-editor').inert = true;
  document.querySelector('.app-header').inert = true;
  document.getElementById('set-name').focus();
}

function closeSetModal() {
  releaseSetDraft();
  document.getElementById('screen-editor').inert = false;
  document.querySelector('.app-header').inert = false;
  document.getElementById('set-video-preview').pause();
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  else document.getElementById('btn-add-set').focus();
  document.getElementById('modal-set').classList.add('hidden');
  document.getElementById('set-image-input').value = '';
  document.getElementById('set-video-input').value = '';
}

async function saveSetFromModal() {
  if (!validateNumbers(document.getElementById('modal-set'))) return;
  const set = {
    id: setDraft.id,
    name: document.getElementById('set-name').value.trim() || 'Unnamed',
    exerciseDuration: parseInt(document.getElementById('set-exercise-dur').value) || 20,
    restDuration: parseInt(document.getElementById('set-rest-dur').value) || 0,
    color: document.getElementById('set-color').value,
    sound: document.getElementById('set-sound').value,
    image: null,
    video: null
  };

  set.image = setDraft.image || null;
  set.video = setDraft.video || null;
  const previous = pendingVideos.get(set.id);
  if (previous && previous.url !== setDraft.url) URL.revokeObjectURL(previous.url);
  pendingVideos.delete(set.id);
  if (setDraft.file && set.video) pendingVideos.set(set.id, {file:setDraft.file, url:setDraft.url});

  if (state.editingSetIndex >= 0) {
    state.editingSets[state.editingSetIndex] = set;
  } else {
    state.editingSets.push(set);
  }

  renderSetsList();
  closeSetModal();
}

function deleteSet() {
  if (state.editingSets.length <= 1) {
    alert('You need at least one set.');
    return;
  }
  state.editingSets.splice(state.editingSetIndex, 1);
  renderSetsList();
  closeSetModal();
}

// ─── Export / Import ────────────────────────────────────────
function portableSettings(settings) {
  const { syncToken, syncGistId, ...preferences } = settings;
  return preferences;
}
function exportWorkouts() {
  const data = {
    version: 1,
    exportDate: new Date().toISOString(),
    workouts: state.workouts,
    settings: portableSettings(state.settings)
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tabata-timer-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function validateWorkoutData(workouts) {
  if (!Array.isArray(workouts) || !workouts.length || workouts.length > 1000) throw new Error('Backup must contain workouts.');
  const ids = new Set();
  const integer = (n,min,max) => Number.isInteger(n) && n >= min && n <= max;
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1000;
  const image = value => value == null || (typeof value === 'string' && /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(value));
  for (const w of workouts) {
    if (!w || !text(w.id) || ids.has(w.id) || !text(w.name) || !image(w.image)
      || !integer(w.initialCountdown,0,30) || !integer(w.warmupDuration,0,600)
      || !integer(w.numberOfCycles,1,50) || !integer(w.recoveryDuration,0,600)
      || !integer(w.cooldownDuration,0,600) || !Array.isArray(w.sets) || !w.sets.length || w.sets.length > 1000) {
      throw new Error('Invalid workout data. No workouts were imported.');
    }
    ids.add(w.id);
    const setIds = new Set();
    for (const set of w.sets) {
      if (!set || !text(set.id) || setIds.has(set.id) || !text(set.name)
        || !integer(set.exerciseDuration,1,600) || !integer(set.restDuration,0,600)
        || !image(set.image) || (set.color != null && !/^#[0-9a-f]{6}$/i.test(set.color))
        || (set.video != null && set.video !== 'blob:' + set.id)) throw new Error('Invalid exercise data. No workouts were imported.');
      setIds.add(set.id);
    }
  }
}

async function importWorkouts(file) { return withProfileOperation(() => importWorkoutsInternal(file)); }
async function importWorkoutsInternal(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.workouts || !Array.isArray(data.workouts)) {
      alert('Invalid backup file.');
      return;
    }
    validateWorkoutData(data.workouts);
    for (const w of data.workouts) {
      await saveWorkout(w);
    }
    if (data.settings) {
      Object.assign(state.settings, portableSettings(data.settings));
      await saveSettings();
      document.documentElement.setAttribute('data-theme', state.settings.theme);
      loadSettingsUI();
    }
    alert(`Imported ${data.workouts.length} workout(s) successfully.`);
    renderHomeWorkoutList();
  } catch (e) {
    alert('Error importing file: ' + e.message);
  }
}

// ─── Cloud Sync (GitHub Gist) ───────────────────────────────
let GIST_FILENAME = 'als-exercise-timer-sync.json';

function getSyncToken() {
  return state.settings.syncToken || '';
}

function updateSyncUI(status, text) {
  const dot = document.getElementById('sync-dot');
  const label = document.getElementById('sync-status-text');
  if (!dot || !label) return;
  dot.className = 'sync-dot ' + status;
  label.textContent = text;
}

async function gistApiCall(method, url, body = null) {
  const token = getSyncToken();
  if (!token) throw new Error('No sync token');
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${err}`);
  }
  return resp.json();
}

async function findSyncGist() {
  // Check if we have a stored gist ID that works
  if (state.settings.syncGistId) {
    try {
      const gist = await gistApiCall('GET', `https://api.github.com/gists/${state.settings.syncGistId}`);
      if (gist.files && gist.files[GIST_FILENAME]) return gist;
    } catch (e) { /* gist may have been deleted, search for it */ }
  }
  // Search user's gists for one with our filename
  const gists = await gistApiCall('GET', 'https://api.github.com/gists?per_page=100');
  for (const g of gists) {
    if (g.files && g.files[GIST_FILENAME]) {
      state.settings.syncGistId = g.id;
      await saveSettings();
      return await gistApiCall('GET', `https://api.github.com/gists/${g.id}`);
    }
  }
  return null;
}

async function createSyncGist() {
  const data = buildSyncPayload();
  const gist = await gistApiCall('POST', 'https://api.github.com/gists', {
    description: "Tabata Timer - Workout Sync",
    public: false,
    files: {
      [GIST_FILENAME]: { content: JSON.stringify(data, null, 2) }
    }
  });
  state.settings.syncGistId = gist.id;
  await saveSettings();
  return gist;
}

function buildSyncPayload() {
  return {
    version: 1,
    lastModified: new Date().toISOString(),
    workouts: state.workouts
  };
}

async function pushToGist() { return withProfileOperation(() => pushToGistInternal()); }
async function pushToGistInternal() {
  if (!getSyncToken()) return;
  try {
    updateSyncUI('syncing', 'Syncing...');
    let gist = await findSyncGist();
    const data = buildSyncPayload();
    if (gist) {
      await gistApiCall('PATCH', `https://api.github.com/gists/${gist.id}`, {
        files: {
          [GIST_FILENAME]: { content: JSON.stringify(data, null, 2) }
        }
      });
    } else {
      await createSyncGist();
    }
    updateSyncUI('connected', 'Synced ' + new Date().toLocaleTimeString());
  } catch (e) {
    console.error('Sync push error:', e);
    updateSyncUI('disconnected', 'Sync error');
  }
}

async function pullFromGist() { return withProfileOperation(() => pullFromGistInternal()); }
async function pullFromGistInternal() {
  if (!getSyncToken()) return;
  try {
    updateSyncUI('syncing', 'Syncing...');
    const gist = await findSyncGist();
    if (!gist) {
      // No gist yet — create one with our current data
      await createSyncGist();
      updateSyncUI('connected', 'Synced ' + new Date().toLocaleTimeString());
      return;
    }
    const content = gist.files[GIST_FILENAME]?.content;
    if (!content) return;
    const remote = JSON.parse(content);
    validateWorkoutData(remote.workouts);

    // Merge: remote workouts override local by ID, add new ones
    const localMap = new Map(state.workouts.map(w => [w.id, w]));
    const remoteMap = new Map(remote.workouts.map(w => [w.id, w]));

    // Add/update all remote workouts locally
    for (const [id, rw] of remoteMap) {
      localMap.set(id, rw);
    }

    // Also push any local-only workouts to remote on next push
    state.workouts = Array.from(localMap.values());

    // Save all to IndexedDB
    for (const w of state.workouts) {
      await dbPut('workouts', w);
    }

    if (state.activeWorkoutId && !localMap.has(state.activeWorkoutId)) {
      state.activeWorkoutId = state.workouts[0]?.id || null;
      await saveSettings();
    }

    renderHomeWorkoutList();
    updateSyncUI('connected', 'Synced ' + new Date().toLocaleTimeString());

    // Push back to include any local-only workouts
    if (state.workouts.length !== remote.workouts.length) {
      await pushToGist();
    }
  } catch (e) {
    console.error('Sync pull error:', e);
    updateSyncUI('disconnected', 'Sync error');
  }
}

// No auto-sync — manual only via "Sync Now" button

function loadSyncUI() {
  const tokenInput = document.getElementById('sync-token');
  if (tokenInput) tokenInput.value = state.settings.syncToken || '';
  if (getSyncToken()) {
    updateSyncUI('connected', 'Connected');
  } else {
    updateSyncUI('disconnected', 'Not connected');
  }
}

async function connectSync() { return withProfileOperation(() => connectSyncInternal()); }
async function connectSyncInternal() {
  const token = document.getElementById('sync-token').value.trim();
  if (!token) {
    alert('Please enter a GitHub Personal Access Token');
    return;
  }
  // Validate token
  try {
    updateSyncUI('syncing', 'Connecting...');
    const resp = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json'
      }
    });
    if (!resp.ok) throw new Error('Invalid token');
    state.settings.syncToken = token;
    await saveSettings();
    await pullFromGist();
  } catch (e) {
    updateSyncUI('disconnected', 'Invalid token');
    alert('Could not connect. Check your token and try again.');
  }
}

async function disconnectSync() { return withProfileOperation(() => disconnectSyncInternal()); }
async function disconnectSyncInternal() {
  state.settings.syncToken = '';
  state.settings.syncGistId = '';
  await saveSettings();
  document.getElementById('sync-token').value = '';
  updateSyncUI('disconnected', 'Not connected');
}

// ─── Event Binding ──────────────────────────────────────────
function validateNumbers(container) {
  for (const input of container.querySelectorAll('input[type=number]')) {
    input.required = true;
    if (!input.reportValidity()) return false;
  }
  return true;
}

function bindEvents() {
  document.getElementById('profile-dialog').addEventListener('cancel', event => { if (switchingProfile) event.preventDefault(); });
  document.getElementById('profile-button').addEventListener('click', showProfiles);
  document.getElementById('profile-close').addEventListener('click', () => document.getElementById('profile-dialog').close());
  document.getElementById('profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    if (switchingProfile) return;
    button.disabled = true;
    try { await addProfile(document.getElementById('profile-name').value); document.getElementById('profile-name').value = ''; }
    catch (error) { document.getElementById('profile-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.getElementById('empty-add-workout').addEventListener('click', () => openWorkoutEditor(null));
  document.getElementById('delete-cancel').addEventListener('click', () => document.getElementById('delete-dialog').close());
  document.getElementById('delete-confirm').addEventListener('click', async () => {
    const button = document.getElementById('delete-confirm');
    button.disabled = true;
    try {
      if (state.workouts.some(w => w.id === workoutPendingDeletion)) await deleteWorkout(workoutPendingDeletion);
      document.getElementById('delete-dialog').close();
      renderHomeWorkoutList();
      document.getElementById('btn-add-workout-home').focus();
      pushToGist();
    } catch (error) { document.getElementById('delete-message').textContent = 'Could not delete this workout. Please try again.'; }
    finally { button.disabled = false; }
  });
  const goHome = () => { if (!state.timer.isRunning) { showScreen('screen-home'); renderHomeWorkoutList(); } };
  document.getElementById('brand-home').addEventListener('click', goHome);
  document.getElementById('nav-workouts').addEventListener('click', goHome);
  document.getElementById('preview-start').addEventListener('click', startWorkout);
  document.getElementById('preview-edit').addEventListener('click', () => openWorkoutEditor(getActiveWorkout()));
  document.getElementById('timer-mute').addEventListener('click', () => {
    state.settings.mute = !state.settings.mute;
    if (state.settings.mute) window.speechSynthesis?.cancel();
    updateMuteButton(); saveSettings();
  });
  document.querySelectorAll('.editor-row, .editor-section').forEach(row => {
    const label = row.querySelector(':scope > label');
    const input = row.querySelector('input:not([type=file]),select');
    if (label && input) label.htmlFor = input.id;
  });
  document.querySelectorAll('.num-btn').forEach(button => {
    const input = document.getElementById(button.dataset.target);
    const label = document.querySelector(`label[for="${input.id}"]`);
    button.setAttribute('aria-label', `${button.classList.contains('plus') ? 'Increase' : 'Decrease'} ${label?.textContent || input.id}`);
  });

  // Home
  document.getElementById('btn-add-workout-home').addEventListener('click', () => {
    openWorkoutEditor(null);
  });
  document.getElementById('btn-settings').addEventListener('click', () => {
    loadSettingsUI();
    loadSyncUI();
    showScreen('screen-settings');
  });

  // Workout Start screen
  document.getElementById('btn-start-back').addEventListener('click', () => {
    showScreen('screen-home');
    renderHomeWorkoutList();
  });
  document.getElementById('btn-start-play').addEventListener('click', startWorkout);
  document.getElementById('btn-start-settings').addEventListener('click', () => {
    loadSettingsUI();
    loadSyncUI();
    showScreen('screen-settings');
  });
  document.getElementById('btn-return-home').addEventListener('click', () => {
    showScreen('screen-home');
    renderHomeWorkoutList();
  });

  // Timer controls
  document.getElementById('btn-timer-back').addEventListener('click', () => {
    if (state.timer.isRunning) {
      if (confirm('End this workout?')) resetTimer();
    } else {
      resetTimer();
    }
  });
  document.getElementById('btn-pause').addEventListener('click', pauseTimer);
  document.getElementById('btn-prev').addEventListener('click', prevPhase);
  document.getElementById('btn-next').addEventListener('click', skipToNext);
  document.getElementById('btn-timer-reset').addEventListener('click', () => {
    if (confirm('End this workout?')) resetTimer();
  });

  // Complete
  document.getElementById('btn-complete-home').addEventListener('click', () => {
    showScreen('screen-home');
    renderHomeWorkoutList();
  });

  // Settings
  document.getElementById('btn-settings-back').addEventListener('click', () => {
    saveSettingsFromUI();
    // Go back to wherever we came from
    showScreen('screen-home');
    renderHomeWorkoutList();
  });

  // Settings change handlers
  ['snd-mute', 'snd-vibration', 'snd-interval', 'snd-continuous', 'snd-three-second',
   'snd-halfway', 'voice-enabled', 'voice-announce', 'theme-toggle'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettingsFromUI);
  });

  // Export/Import
  document.getElementById('btn-export').addEventListener('click', exportWorkouts);
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', e => {
    if (e.target.files[0]) importWorkouts(e.target.files[0]);
    e.target.value = '';
  });

  // Cloud Sync
  document.getElementById('btn-sync-save').addEventListener('click', connectSync);
  document.getElementById('btn-sync-now').addEventListener('click', () => {
    if (!getSyncToken()) {
      alert('Connect first by entering a token and clicking Connect.');
      return;
    }
    pullFromGist();
  });
  document.getElementById('btn-sync-disconnect').addEventListener('click', disconnectSync);

  // Editor
  document.getElementById('btn-editor-back').addEventListener('click', () => {
    showScreen('screen-home');
    renderHomeWorkoutList();
  });
  document.getElementById('btn-editor-save').addEventListener('click', saveWorkoutFromEditor);
  document.getElementById('btn-add-set').addEventListener('click', () => {
    openSetEditor(-1);
  });

  // Workout image upload
  document.getElementById('btn-workout-image').addEventListener('click', () => {
    document.getElementById('workout-image-input').click();
  });
  document.getElementById('workout-image-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const workout = state.editingWorkout;
    const dataUrl = await resizeImage(file, 600);
    if (state.editingWorkout !== workout || !document.getElementById('screen-editor').classList.contains('active')) return;
    const preview = document.getElementById('edit-workout-image-preview');
    preview.src = dataUrl;
    preview.classList.remove('hidden');
    document.getElementById('btn-workout-image-clear').classList.remove('hidden');
    state.editingWorkout.image = dataUrl;
  });
  document.getElementById('btn-workout-image-clear').addEventListener('click', () => {
    document.getElementById('edit-workout-image-preview').src = '';
    document.getElementById('edit-workout-image-preview').classList.add('hidden');
    document.getElementById('btn-workout-image-clear').classList.add('hidden');
    state.editingWorkout.image = null;
  });

  // Number input +/- buttons
  document.querySelectorAll('.num-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      const min = parseInt(target.min) || 0;
      const max = parseInt(target.max) || 9999;
      let val = parseInt(target.value) || 0;
      if (btn.classList.contains('plus')) val = Math.min(max, val + 1);
      else val = Math.max(min, val - 1);
      target.value = val;
    });
  });

  // Set editor modal
  document.getElementById('btn-modal-close').addEventListener('click', closeSetModal);
  document.getElementById('btn-set-save').addEventListener('click', saveSetFromModal);
  document.getElementById('btn-set-delete').addEventListener('click', deleteSet);

  // Image upload for sets
  document.getElementById('btn-set-image').addEventListener('click', () => {
    document.getElementById('set-image-input').click();
  });
  document.getElementById('set-image-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const draft = setDraft;
    const dataUrl = await resizeImage(file);
    if (setDraft !== draft) return;
    draft.image = dataUrl;
    const preview = document.getElementById('set-image-preview');
    preview.src = dataUrl;
    preview.classList.remove('hidden');
    document.getElementById('btn-set-image-clear').classList.remove('hidden');

  });
  document.getElementById('btn-set-image-clear').addEventListener('click', () => {
    document.getElementById('set-image-preview').src = '';
    document.getElementById('set-image-preview').classList.add('hidden');
    document.getElementById('btn-set-image-clear').classList.add('hidden');
    setDraft.image = null;
  });

  // Video upload — store as Blob in IndexedDB, use Blob URL for playback
  document.getElementById('btn-set-video').addEventListener('click', () => {
    document.getElementById('set-video-input').click();
  });
  document.getElementById('set-video-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      alert('Video must be under 50MB.');
      return;
    }
    // Validate format
    const validTypes = ['video/mp4', 'video/quicktime', 'video/x-m4v'];
    if (!validTypes.includes(file.type) && !file.name.match(/\.(mp4|mov|m4v)$/i)) {
      alert('Please use MP4 or MOV format. Other formats may not play on iOS.');
      return;
    }
    if (!setDraft) return;
    if (setDraft.url && pendingVideos.get(setDraft.id)?.url !== setDraft.url) URL.revokeObjectURL(setDraft.url);
    setDraft.file = file;
    setDraft.url = URL.createObjectURL(file);
    setDraft.video = 'blob:' + setDraft.id;
    const preview = document.getElementById('set-video-preview');
    preview.src = setDraft.url;
    preview.load();
    preview.classList.remove('hidden');
    document.getElementById('btn-set-video-clear').classList.remove('hidden');
  });
  document.getElementById('btn-set-video-clear').addEventListener('click', () => {
    const preview = document.getElementById('set-video-preview');
    preview.pause();
    preview.removeAttribute('src');
    preview.load();
    preview.classList.add('hidden');
    document.getElementById('btn-set-video-clear').classList.add('hidden');
    if (setDraft.url && pendingVideos.get(setDraft.id)?.url !== setDraft.url) URL.revokeObjectURL(setDraft.url);
    setDraft.video = null;
    setDraft.file = null;
    setDraft.url = null;
  });

  // Close modal on backdrop click
  document.getElementById('modal-set').addEventListener('click', e => {
    if (e.target.id === 'modal-set') closeSetModal();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const modal = document.getElementById('modal-set');
    if (!modal.classList.contains('hidden')) {
      if (e.code === 'Escape') closeSetModal();
      if (e.code === 'Tab') {
        const focusable = [...modal.querySelectorAll('button,input,select')].filter(el => el.getClientRects().length && !el.disabled);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      return;
    }
    if (!state.timer.isRunning || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space' && e.target.tagName === 'BUTTON') return;
    if (e.code === 'Space') { e.preventDefault(); pauseTimer(); }
    if (e.code === 'ArrowRight') skipToNext();
    if (e.code === 'ArrowLeft') prevPhase();
    if (e.code === 'Escape') { if (!state.timer.isPaused) pauseTimer(); }
  });
}

// ─── PWA Registration ───────────────────────────────────────
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js?v=20260913').catch(() => {});
  }
}

// ─── Icon Generation ────────────────────────────────────────
function generateIcons() {
  [180, 192, 512].forEach(size => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    // Background
    ctx.fillStyle = '#1B2138';
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, size * 0.2);
    ctx.fill();
    // Circle
    const cx = size / 2, cy = size / 2, r = size * 0.35;
    ctx.strokeStyle = '#E86C3A';
    ctx.lineWidth = size * 0.04;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    // Play triangle
    ctx.fillStyle = '#E86C3A';
    ctx.beginPath();
    const ts = size * 0.18;
    ctx.moveTo(cx - ts * 0.3, cy - ts);
    ctx.lineTo(cx - ts * 0.3, cy + ts);
    ctx.lineTo(cx + ts * 0.8, cy);
    ctx.closePath();
    ctx.fill();
    // Timer tick marks
    ctx.strokeStyle = '#E86C3A';
    ctx.lineWidth = size * 0.02;
    for (let i = 0; i < 12; i++) {
      const angle = (i * 30 - 90) * Math.PI / 180;
      const inner = r - size * 0.06;
      const outer = r - size * 0.02;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.stroke();
    }
    // Save
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      if (size === 180) {
        let link = document.querySelector('link[rel="apple-touch-icon"]');
        if (link) link.href = url;
      }
    }, 'image/png');
  });
}

// ─── Init ───────────────────────────────────────────────────
async function init() {
  loadProfiles();
  await openDB(profileDatabase(activeProfileId));
  await loadData(activeProfileId === 'default');
  GIST_FILENAME = activeProfileId === 'default' ? 'als-exercise-timer-sync.json' : `tabata-timer-${activeProfileId}.json`;
  renderProfileName();

  document.documentElement.setAttribute('data-theme', state.settings.theme);
  renderHomeWorkoutList();
  bindEvents();
  registerSW();
  generateIcons();

  // Load sync UI state
  if (getSyncToken()) {
    updateSyncUI('connected', 'Connected');
  }
}

init();

})();
