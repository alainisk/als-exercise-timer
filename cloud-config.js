// Railway serves /api on its own origin; Pages keeps access to existing device data.
window.TABATA_CLOUD_API = location.hostname === 'alainisk.github.io'
  ? 'https://als-exercise-timer-production.up.railway.app/api' : location.origin + '/api';
