const DEFAULT_API = 'http://crabtrackpi.local:3000';

// ========== YOUR FIREBASE CONFIG ==========
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBBwmx81dJMxA8EBFDAGCiAwRbKjpebp5w",
  authDomain: "crabtrack-1e256.firebaseapp.com",
  databaseURL: "https://crabtrack-1e256-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "crabtrack-1e256",
  storageBucket: "crabtrack-1e256.firebasestorage.app",
  messagingSenderId: "702678864202",
  appId: "1:702678864202:web:51eb3f88e97ed54c75f1b3",
  measurementId: "G-XGPGTTHT4G"
};

// ✅ READS FROM BOTH PATHS — your existing crab_monitor + crab_track
const FIREBASE_CRAB_MONITOR_PATH = "/crab_monitor";
const FIREBASE_CRAB_TRACK_PATH = "/crab_track/nodes";
// ==========================================

const apiInput = document.getElementById('apiUrl');
apiInput.value = (localStorage.getItem('crabtrack_api_url') || DEFAULT_API).replace(/\/$/, '');
document.getElementById('browserInfo').textContent = navigator.userAgent;

let autoDiscovery = localStorage.getItem('crabtrack_auto_discovery') !== 'off';
let discoveryTimer = null;
let discoveredNodes = JSON.parse(localStorage.getItem('crabtrack_nodes') || '{}');
let firebaseDb = null;
let fbAuth = null, fbUser = null, fbConnected = false, serverOffset = 0;
const authReady = new Promise(res => { window.__authReady = res; });
let firebaseUnsubMonitor = null;
let firebaseUnsubTrack = null;

// --- Load/Save node status ---
function loadNodeStatus() {
  try { return JSON.parse(localStorage.getItem('crabtrack_node_status') || '{}'); }
  catch { return {}; }
}
function saveNodeStatus(status) {
  localStorage.setItem('crabtrack_node_status', JSON.stringify(status));
}
let nodeStatus = loadNodeStatus();

function apiBase(){ return (apiInput.value.trim() || DEFAULT_API).replace(/\/$/, ''); }
function setStatus(id, text, cls){
  const e = document.getElementById(id);
  if(e) { e.textContent = text; e.className = 'status ' + cls; }
}
function boolVal(v){
  return v === true || v === 1 || v === 'true' || v === 'online' || v === 'ONLINE';
}

// ══════════════════════════════════════════════════════════
// HEARTBEAT / STALENESS  — fixes "node shows ONLINE when unplugged"
// ══════════════════════════════════════════════════════════
// The old code did `data.node1.online ?? true`, so a node that never
// writes an "online" field was assumed ONLINE. Worse, Firebase keeps the
// last value forever and its listener only fires on CHANGE — so when a
// node dies, nothing ever fires again and the stale value sits there
// looking healthy.
//
// Fix: a node is only ONLINE if it wrote a RECENT timestamp. No
// timestamp = we genuinely don't know, so we say so instead of guessing.

const STALE_AFTER_MS = (parseInt(localStorage.getItem('crabtrack_stale_seconds'), 10) || 120) * 1000;

// Pull a real wall-clock heartbeat out of whatever the node wrote.
// Deliberately ignores millis()/uptime — that's time since the ESP32
// booted, not a date, so it can't tell us how old the reading is.
function heartbeatOf(obj){
  if(!obj || typeof obj !== 'object') return null;
  const cands = [obj.ts, obj.timestamp, obj.last_seen, obj.lastSeen, obj.updated_at, obj.time];
  for(const v of cands){
    if(typeof v === 'number' && v > 0) return v < 1e12 ? v * 1000 : v;  // secs vs ms
    if(typeof v === 'string'){ const t = Date.parse(v); if(!isNaN(t)) return t; }
  }
  return null;
}

// Returns: 'online' | 'offline' | 'stale' | 'no-heartbeat'
function evaluateNode(obj, explicitOnline){
  const hb = heartbeatOf(obj);
  if(hb === null){
    // Node never sends a timestamp. Honest answer: unknown.
    return { state:'no-heartbeat', online:false, lastSeen:null };
  }
  const age = Date.now() - hb;
  if(explicitOnline === false || boolVal(obj.offline)) return { state:'offline', online:false, lastSeen:hb };
  if(age > STALE_AFTER_MS)                             return { state:'stale',   online:false, lastSeen:hb };
  return { state:'online', online:true, lastSeen:hb };
}

const STATE_LABEL = { online:'ONLINE', offline:'OFFLINE', stale:'STALE — NO DATA', 'no-heartbeat':'NO HEARTBEAT' };
const STATE_CLASS = { online:'ok', offline:'bad', stale:'bad', 'no-heartbeat':'warn' };

// --- Update node display ---
function updateNodeStatus(nodeId, rawOrBool, source = "unknown"){
  // Accepts the node's raw object (preferred) or a plain boolean (legacy).
  const raw = (rawOrBool && typeof rawOrBool === 'object') ? rawOrBool : {};
  const explicit = (rawOrBool && typeof rawOrBool === 'object')
    ? (rawOrBool.online === undefined ? undefined : boolVal(rawOrBool.online))
    : boolVal(rawOrBool);

  const ev = evaluateNode(raw, explicit);
  nodeStatus[nodeId] = {
    online: ev.online,
    state: ev.state,
    lastSeen: ev.lastSeen,          // the NODE's timestamp, not the browser's
    receivedAt: Date.now(),
    source: source
  };
  saveNodeStatus(nodeStatus);
  setNodeDisplay(nodeId);
}

function setNodeDisplay(nodeId){
  const st = nodeStatus[nodeId];
  if(!st){ setStatus(nodeId, 'NO DATA', 'bad'); return; }

  // Re-check age on every render. Firebase won't push an update when a
  // node dies, so freshness has to be recomputed locally on a timer.
  let state = st.state;
  if(st.lastSeen && state === 'online' && (Date.now() - st.lastSeen) > STALE_AFTER_MS) state = 'stale';

  const age = st.lastSeen ? formatAge(Date.now() - st.lastSeen) : 'never';
  const label = STATE_LABEL[state] || 'UNKNOWN';
  setStatus(nodeId, state === 'online' ? label : `${label} (${age})`, STATE_CLASS[state] || 'bad');
}

// Dead nodes go quiet, so nothing pushes. Re-evaluate every 10s ourselves.
setInterval(() => {
  Object.keys(nodeStatus).forEach(setNodeDisplay);
  Object.values(discoveredNodes).forEach(n => {
    if(n.lastSeen && (Date.now() - n.lastSeen) > STALE_AFTER_MS) n.online = false;
  });
  renderNodes();
}, 10000);

// ========== FIREBASE CONNECTION — LISTEN TO BOTH PATHS ==========
async function initFirebase(){
  if(!window.firebase) {
    console.warn("❌ Firebase SDK NOT FOUND");
    document.getElementById('discoveryStatus').textContent = '⚠️ Firebase SDK missing → check script tags in HTML.';
    if(window.__authReady) window.__authReady();
    return;
  }
  try {
    const app = firebase.initializeApp(FIREBASE_CONFIG);
    firebaseDb = firebase.database();
    // Admin sign-in (email + password). Session-only, so closing the tab signs you out.
    if(firebase.auth){
      fbAuth = firebase.auth();
      try { await fbAuth.setPersistence(firebase.auth.Auth.Persistence.SESSION); } catch(e) {}
      fbAuth.onAuthStateChanged(u => {
        // The dashboard signs in anonymously with the same project - that is NOT an admin.
        fbUser = (u && !u.isAnonymous) ? u : null;
        if(window.__authReady) window.__authReady();
        if(fbUser) attachScaleListeners();
        renderLinkStatus();
      });
    } else if(window.__authReady) window.__authReady();
    firebaseDb.ref('.info/connected').on('value', s => { fbConnected = !!s.val(); renderLinkStatus(); });
    firebaseDb.ref('.info/serverTimeOffset').on('value', s => { serverOffset = s.val() || 0; });
    console.log("✅ Firebase CONNECTED — listening to crab_monitor + crab_track");
    listenToCrabMonitor();  // ✅ Your existing path
    listenToCrabTrack();    // ✅ Original path
  } catch(err) {
    console.error("❌ Firebase init failed:", err);
    document.getElementById('discoveryStatus').textContent = '❌ Firebase: ' + err.message;
  }
}

// ✅ LISTEN TO YOUR EXISTING crab_monitor PATH
function listenToCrabMonitor(){
  if(!firebaseDb) return;
  firebaseUnsubMonitor = firebaseDb.ref(FIREBASE_CRAB_MONITOR_PATH).on('value', (snapshot) => {
    const data = snapshot.val();
    console.log("📡 [crab_monitor] Update received:", data);
    if(!data) return;

    // node1 from crab_monitor
    if(data.node1 !== undefined) {
      if(!apiBase()) updateNodeStatus('node1', data.node1, 'Firebase (monitor)');
      // Also grab pH value from crab_monitor
      if(data.node1.ph !== undefined) {
        document.getElementById('ph').textContent = typeof data.node1.ph === 'number' ? data.node1.ph.toFixed(2) : data.node1.ph;
      }
      registerNode('node1', { type: 'pH', ph: data.node1.ph, ...data.node1 }, nodeStatus.node1?.online);
    }
    // node2 from crab_monitor
    if(data.node2 !== undefined) {
      if(!apiBase()) updateNodeStatus('node2', data.node2, 'Firebase (monitor)');
      if(data.node2.ec !== undefined) {
        document.getElementById('ec').textContent = typeof data.node2.ec === 'number' ? data.node2.ec.toFixed(2) + ' mS/cm' : data.node2.ec;
      }
      if(data.node2.temperature !== undefined) {
        document.getElementById('temp').textContent = typeof data.node2.temperature === 'number' ? data.node2.temperature.toFixed(2) + ' °C' : data.node2.temperature;
      }
      registerNode('node2', { type: 'EC + Temperature', ...data.node2 }, nodeStatus.node2?.online);
    }
    // node3 from crab_monitor
    if(data.node3 !== undefined) {
      if(!apiBase()) updateNodeStatus('node3', data.node3, 'Firebase (monitor)');
      registerNode('node3', { type: 'TFT / Status', ...data.node3 }, nodeStatus.node3?.online);
    }
    renderNodes();
  }, (err) => {
    console.warn("❌ crab_monitor listener error:", err);
  });
}

// ✅ LISTEN TO crab_track/nodes PATH (backup/compatibility)
function listenToCrabTrack(){
  if(!firebaseDb) return;
  firebaseUnsubTrack = firebaseDb.ref(FIREBASE_CRAB_TRACK_PATH).on('value', (snapshot) => {
    const data = snapshot.val();
    console.log("📡 [crab_track] Update received:", data);
    if(!data) return;

    // Only update if crab_monitor hasn't already set it (crab_monitor = priority)
    if(data.node1 !== undefined && !nodeStatus.node1?.source?.includes('monitor'))
      updateNodeStatus('node1', data.node1, 'Firebase (track)');
    if(data.node2 !== undefined && !nodeStatus.node2?.source?.includes('monitor'))
      updateNodeStatus('node2', data.node2, 'Firebase (track)');
    if(data.node3 !== undefined && !nodeStatus.node3?.source?.includes('monitor'))
      updateNodeStatus('node3', data.node3, 'Firebase (track)');
    renderNodes();
  }, (err) => {
    console.warn("❌ crab_track listener error:", err);
  });
}

// ========== RASPBERRY PI API ==========
function saveApi(){
  const url = apiBase();
  localStorage.setItem('crabtrack_api_url', url);
  apiInput.value = url;
  setStatus('apiStatus', 'SAVED', 'ok');
  testApi();
}
function latestUrl(){ return apiBase() + '/api/data'; }
function openApi(){ window.open(latestUrl(), '_blank', 'noopener'); }

async function fetchJson(path, timeout = 5000){
  const res = await fetch(apiBase() + path, { cache: 'no-store', signal: AbortSignal.timeout(timeout) });
  if(!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

async function testApi(){
  const url = latestUrl();
  document.getElementById('apiEndpoint').textContent = url;
  setStatus('apiStatus', 'CHECKING', 'wait');

  try {
    const started = performance.now();
    const data = await fetchJson('/api/data');
    const ms = Math.round(performance.now() - started);
    document.getElementById('lastResponse').textContent = `HTTP 200 · ${ms} ms`;
    setStatus('apiStatus', 'ONLINE', 'ok');
    renderData(data);
    ['node1','node2','node3'].forEach(id => { const n = data.nodes?.[id] ?? data[id]; if(n && typeof n === 'object') updateNodeStatus(id, n, 'Raspberry Pi'); });
    discoverFromData(data);
    discoverNodes(false);
    document.getElementById('discoveryStatus').textContent = '✅ crab_monitor + Pi API connected';
  } catch(e) {
    document.getElementById('lastResponse').textContent = e.message;
    setStatus('apiStatus', 'OFFLINE', 'bad');
    document.getElementById('discoveryStatus').textContent = '✅ crab_monitor online · Pi unreachable';
  }
}

function setNode(id, v){
  // Pi only updates if Firebase (crab_monitor) hasn't spoken already
  if(!nodeStatus[id]?.source || nodeStatus[id]?.source === 'Raspberry Pi') {
    updateNodeStatus(id, v, 'Raspberry Pi');
  }
}

function renderData(d){
  // Only fill sensor values if Firebase didn't already provide them
  if(document.getElementById('ph').textContent === '—') {
    const ph = d.ph ?? d.node1?.ph ?? '—';
    document.getElementById('ph').textContent = typeof ph === 'number' ? ph.toFixed(2) : ph;
  }
  if(document.getElementById('ec').textContent === '—') {
    const ec = d.ec ?? d.node2?.ec ?? '—';
    document.getElementById('ec').textContent = typeof ec === 'number' ? ec.toFixed(2) + ' mS/cm' : ec;
  }
  if(document.getElementById('temp').textContent === '—') {
    const temp = d.temperature ?? d.temp ?? d.node2?.temperature ?? '—';
    document.getElementById('temp').textContent = typeof temp === 'number' ? temp.toFixed(2) + ' °C' : temp;
  }
  if(document.getElementById('salinity').textContent === '—') {
    const sal = d.salinity ?? d.node2?.salinity ?? '—';
    document.getElementById('salinity').textContent = typeof sal === 'number' ? sal.toFixed(1) + ' ppt' : sal;
  }
  const weights = d.weights ?? d.node1?.weights;
  document.getElementById('weights').textContent = Array.isArray(weights) ? weights.map((x,i) => `#${i+1} ${Number(x).toFixed(1)}g`).join(' · ') : '—';

  const ts = d.timestamp ?? d.updated_at ?? d.time ?? d.last_update;
  document.getElementById('dataAge').textContent = ts ? String(ts) : 'Latest response received';
}

function nodeType(id, raw = {}){
  const type = raw.type || raw.role || raw.sensor || raw.name;
  if(type) return String(type);
  const n = Number(String(id).replace(/\D/g, ''));
  if(n === 1) return 'pH';
  if(n === 2) return 'EC + Temperature';
  if(n === 3) return 'TFT / Status';
  return 'ESP32 Sensor Node';
}
function nodeId(raw, fallback){
  const v = raw?.node ?? raw?.node_id ?? raw?.id ?? raw?.nodeId ?? fallback;
  return v === undefined || v === null ? null : String(v).toLowerCase().startsWith('node') ? String(v) : 'node' + v;
}
function registerNode(id, raw = {}, online = true){
  if(!id) return;
  const now = Date.now();
  const old = discoveredNodes[id] || {};
  const hb = heartbeatOf(raw);
  const stillFresh = hb !== null && (now - hb) <= STALE_AFTER_MS;
  // lastSeen must come from the NODE. Using `now` here was why an unplugged
  // node kept looking recently-seen every time the page re-rendered.
  discoveredNodes[id] = {
    id, type: nodeType(id, raw),
    online: hb !== null ? (stillFresh && online !== false) : false,
    lastSeen: hb !== null ? hb : (old.lastSeen || null),
    meta: raw
  };
}
function discoverFromData(d){
  const nodes = d?.nodes;
  if(nodes && typeof nodes === 'object' && !Array.isArray(nodes)){
    Object.entries(nodes).forEach(([key, val]) => {
      if(/^node/i.test(key)) registerNode(key, typeof val === 'object' ? val : {}, boolVal(val?.ok ?? val));
    });
  }
  ['node1','node2','node3'].forEach(k => {
    if(d?.[k] !== undefined) registerNode(k, typeof d[k] === 'object' ? d[k] : {}, true);
    const okKey = k + '_ok';
    if(d?.[okKey] !== undefined) registerNode(k, { ok: d[okKey] }, boolVal(d[okKey]));
  });
  Object.keys(d||{}).forEach(k => { if(/^node\d+$/i.test(k)) registerNode(k, typeof d[k] === 'object' ? d[k] : {}, true); });
  if(d?.node !== undefined || d?.node_id !== undefined) registerNode(nodeId(d), d, true);
  saveNodes(); renderNodes();
}
async function discoverNodes(manual = false){
  if(manual) document.getElementById('discoveryStatus').textContent = 'Reading from crab_monitor + Pi…';
  let found = false;
  try {
    const data = await fetchJson('/api/data', 3500);
    const nodeStatuses = { node1: data.node1_ok, node2: data.node2_ok, node3: data.node3_ok };
    Object.entries(nodeStatuses).forEach(([id, online]) => {
      if(!nodeStatus[id]?.source || nodeStatus[id]?.source === 'Raspberry Pi')
        registerNode(id, { ok: boolVal(online) }, boolVal(online));
      found = true;
    });
    discoverFromData(data);
  } catch(error) { console.warn('Pi unreachable:', error); }
  if(manual) document.getElementById('discoveryStatus').textContent = found ? '✅ crab_monitor + Pi updated.' : '✅ crab_monitor online.';
  renderNodes();
}
function saveNodes(){ localStorage.setItem('crabtrack_nodes', JSON.stringify(discoveredNodes)); }
function renderNodes(){
  const list = document.getElementById('nodeList');
  const nodes = Object.values(discoveredNodes).sort((a,b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  document.getElementById('discoveryCount').textContent = `${nodes.length} node${nodes.length===1?'':'s'} discovered`;
  if(!nodes.length){ list.innerHTML = `<div class="empty-node">Waiting for crab_monitor or Pi…</div>`; return; }
  list.innerHTML = nodes.map(n => {
    const fresh = n.lastSeen && (Date.now() - n.lastSeen) <= STALE_AFTER_MS;
    const online = !!n.online && fresh;
    const age = n.lastSeen ? formatAge(Date.now() - n.lastSeen) : 'no heartbeat';
    const src = nodeStatus[n.id]?.source || 'unknown';
    return `<div class="discovered-node"><span class="node-id">${escapeHtml(n.id)}</span><span class="node-type">${escapeHtml(n.type)}</span><span class="status ${online?'ok':(n.lastSeen?'bad':'warn')}">${online?'ONLINE':(n.lastSeen?'STALE':'NO HEARTBEAT')}</span><span class="node-seen">${src} · last seen ${age}</span></div>`;
  }).join('');
}
function formatAge(ms){
  if(ms < 5000) return 'just now';
  const sec = Math.floor(ms/1000); if(sec<60) return sec+'s ago';
  const min = Math.floor(sec/60); if(min<60) return min+'m ago';
  return Math.floor(min/60)+'h ago';
}
function escapeHtml(v){ return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

function toggleAutoDiscovery(){
  autoDiscovery = !autoDiscovery;
  localStorage.setItem('crabtrack_auto_discovery', autoDiscovery ? 'on' : 'off');
  updateAutoDiscovery();
  autoDiscovery ? startDiscovery() : stopDiscovery();
}
function updateAutoDiscovery(){
  const btn = document.getElementById('autoDiscoverBtn');
  if(btn) btn.textContent = autoDiscovery ? '⏸ Auto Discovery: ON' : '▶ Auto Discovery: OFF';
}
function startDiscovery(){
  stopDiscovery();
  discoveryTimer = setInterval(() => { if(autoDiscovery) discoverNodes(false); }, 5000);
}
function stopDiscovery(){
  if(discoveryTimer){ clearInterval(discoveryTimer); discoveryTimer = null; }
  if(firebaseUnsubMonitor) { firebaseUnsubMonitor(); firebaseUnsubMonitor = null; }
  if(firebaseUnsubTrack) { firebaseUnsubTrack(); firebaseUnsubTrack = null; }
}

function clearSensorCache(){
  localStorage.removeItem('sensorHistory');
  localStorage.removeItem('alertLog');
  alert('Sensor history cleared from this browser.');
}
function clearAllLocalData(){
  if(!confirm('Clear all local data? This will NOT delete Firebase or Raspberry Pi data.')) return;
  localStorage.clear();
  alert('✅ Local data cleared.');
  location.reload();
}
function refreshAll(){ testApi(); discoverNodes(true); }

// ══════════════════════════════════════════════════════════
// SOLENOID AUTOMATION — time schedules + salinity/sensor rules
// ══════════════════════════════════════════════════════════

// ── Admin login ──────────────────────────────────────────
// The Pi issues a session token at login; every change (POST/PATCH/DELETE)
// sends it. The token lives in sessionStorage, so closing the tab signs you out.
const TOKEN_KEY = 'crabtrack_admin_token';
const getToken = () => sessionStorage.getItem(TOKEN_KEY) || '';
function authHeaders(extra = {}){
  const t = getToken();
  return t ? { ...extra, Authorization: 'Bearer ' + t } : extra;
}
function showLogin(msg){
  document.getElementById('adminApp').style.display = 'none';
  document.getElementById('loginOverlay').style.display = 'flex';
  document.getElementById('loginErr').textContent = msg || '';
  document.getElementById('loginApi').value = apiBase();
}
function showApp(){
  document.getElementById('loginOverlay').style.display = 'none';
  document.getElementById('adminApp').style.display = 'block';
  refreshAll(); refreshScales();
  attachScaleListeners(); renderLinkStatus();
}

// Who may open this page?
//   ONLINE  : the Firebase admin account (email + password)  -> works with no Raspberry Pi
//   OFFLINE : the same account on the Pi (created from this page) -> works with no internet
async function checkSession(){
  await Promise.race([authReady, new Promise(r => setTimeout(r, 4000))]);
  if(fbUser){ showApp(); return; }
  if(!getToken()){ await prepareLoginScreen(''); return; }
  try {
    const r = await fetch(apiBase() + '/api/admin/session', { headers: authHeaders(), cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if(d.loggedIn){ showApp(); return; }
    sessionStorage.removeItem(TOKEN_KEY);
    await prepareLoginScreen('Session expired - please sign in again.');
  } catch(e) { await prepareLoginScreen('Cannot reach the Pi at ' + apiBase()); }
}

function fbErrorText(e){
  const c = (e && e.code) || '';
  if(c.includes('wrong-password') || c.includes('user-not-found') || c.includes('invalid-credential') || c.includes('invalid-email')) return 'Wrong username or password';
  if(c.includes('too-many-requests')) return 'Too many attempts - wait a few minutes';
  if(c.includes('network')) return 'No internet connection';
  if(c.includes('email-already-in-use')) return 'An admin account already exists - sign in instead';
  if(c.includes('weak-password')) return 'Password must be at least 8 characters';
  return (e && e.message) || 'Sign-in failed';
}

// Firebase wants an email, so the username is turned into a private one behind the scenes.
const normUser  = u => String(u || '').trim().toLowerCase();
const userEmail = u => normUser(u) + '@crabtrack.admin';
const validUser = u => /^[a-z0-9._-]{3,32}$/.test(u);

let loginMode = 'login', acctState = { fb: 'unknown', pi: 'unknown' };
function setLoginMode(mode){
  loginMode = mode;
  const setup = mode === 'setup';
  document.getElementById('loginTitle').textContent = setup ? '🛠 CREATE ADMIN ACCOUNT' : '🛠 CRAB TRACK — ADMIN';
  document.getElementById('loginSub').textContent = setup
    ? 'First time here: choose the admin username and password. You can change the password later from this page.'
    : 'Sign in to change schedules, valves, the pump and the scales.';
  document.getElementById('loginPass2').style.display = setup ? '' : 'none';
  document.getElementById('loginBtn').textContent = setup ? 'Create account' : 'Sign in';
  document.getElementById('loginPass').autocomplete = setup ? 'new-password' : 'current-password';
}

// Is there already an admin account (online and/or on the Pi)?
async function detectAccountState(){
  const st = { fb: 'unknown', pi: 'unknown' };
  if(firebaseDb){
    try {
      const snap = await Promise.race([ firebaseDb.ref('/crab_scale/admin').once('value'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)) ]);
      st.fb = snap.exists() ? 'exists' : 'missing';
    } catch(e) {}
  }
  try {
    const r = await fetch(apiBase() + '/api/admin/session', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    const d = await r.json(); st.pi = d.configured ? 'configured' : 'unconfigured';
  } catch(e) {}
  return st;
}
async function prepareLoginScreen(msg){
  acctState = await detectAccountState();
  const needsSetup = acctState.fb === 'missing' || (acctState.fb !== 'exists' && acctState.pi === 'unconfigured');
  setLoginMode(needsSetup ? 'setup' : 'login');
  showLogin(msg);
}

async function piSetup(username, password){
  const r = await fetch(apiBase() + '/api/admin/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(6000),
  });
  const d = await r.json().catch(() => ({}));
  if(!r.ok || !d.token) throw new Error(d.error || ('HTTP ' + r.status));
  sessionStorage.setItem(TOKEN_KEY, d.token);
}

async function doLogin(){
  const api = document.getElementById('loginApi').value.trim().replace(/\/$/, '');
  if(api){ localStorage.setItem('crabtrack_api_url', api); apiInput.value = api; }
  if(loginMode === 'setup') return doSetup();

  const username = normUser(document.getElementById('loginUser').value);
  const password = document.getElementById('loginPass').value;
  const err = document.getElementById('loginErr');
  if(!username || !password){ err.textContent = 'Enter your username and password.'; return; }
  err.textContent = 'Signing in...';

  // Online (Firebase) and local (Pi) in parallel. Either one opens the page.
  const tryFirebase = async () => {
    if(!fbAuth) throw new Error('Firebase not available');
    await Promise.race([
      fbAuth.signInWithEmailAndPassword(userEmail(username), password),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Firebase timed out')), 9000)),
    ]);
  };
  const tryPi = async () => {
    const r = await fetch(apiBase() + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(6000),
    });
    const d = await r.json().catch(() => ({}));
    if(r.status === 503){ const e = new Error(d.error || 'Pi has no admin account yet'); e.piUnconfigured = true; throw e; }
    if(!r.ok || !d.token) throw new Error(d.error || ('HTTP ' + r.status));
    sessionStorage.setItem(TOKEN_KEY, d.token);
  };
  const [fb, pi] = await Promise.allSettled([tryFirebase(), tryPi()]);
  document.getElementById('loginPass').value = '';

  // Signed in online but the Pi has no account yet: give it the same one (identity already proven online).
  if(fb.status === 'fulfilled' && pi.status === 'rejected' && pi.reason && pi.reason.piUnconfigured){
    try { await piSetup(username, password); } catch(e) {}
  }
  if(fb.status === 'fulfilled' || pi.status === 'fulfilled' || getToken()){ showApp(); return; }
  err.textContent = (fb.reason && fb.reason.code) ? fbErrorText(fb.reason) : (pi.reason && pi.reason.message) || 'Sign-in failed';
}

async function doSetup(){
  const username = normUser(document.getElementById('loginUser').value);
  const password = document.getElementById('loginPass').value;
  const again = document.getElementById('loginPass2').value;
  const err = document.getElementById('loginErr');
  if(!validUser(username)){ err.textContent = 'Username: 3-32 characters, letters/numbers . _ - only'; return; }
  if(password.length < 8){ err.textContent = 'Password must be at least 8 characters.'; return; }
  if(password !== again){ err.textContent = 'The two passwords do not match.'; return; }
  err.textContent = 'Creating account...';

  let fbOk = false, piOk = false, problems = [];
  if(firebaseDb && fbAuth && acctState.fb === 'missing'){
    try {
      const cred = await fbAuth.createUserWithEmailAndPassword(userEmail(username), password);
      try {
        await firebaseDb.ref('/crab_scale/admin').set({ uid: cred.user.uid, username });
        fbOk = true;
      } catch(e) {
        problems.push('The account was created but Firebase refused to save it as admin. Add the database rules from docs/FIREBASE_ONLINE_SCALES.md, then sign in.');
      }
    } catch(e) { problems.push('Online: ' + fbErrorText(e)); }
  }
  if(acctState.pi === 'unconfigured'){
    try { await piSetup(username, password); piOk = true; } catch(e) { problems.push('Pi: ' + e.message); }
  }
  document.getElementById('loginPass').value = ''; document.getElementById('loginPass2').value = '';
  if(fbOk || piOk){ showApp(); return; }
  err.textContent = problems.join(' ') || 'Could not create the account (no internet and the Pi is not reachable).';
}

async function changePassword(){
  const oldP = prompt('Current password:'); if(!oldP) return;
  const newP = prompt('New password (at least 8 characters):'); if(!newP) return;
  if(newP.length < 8){ alert('Password must be at least 8 characters.'); return; }
  if(prompt('Type the new password again:') !== newP){ alert('The two passwords do not match. Nothing was changed.'); return; }
  const msgs = [];
  if(fbUser){
    try {
      await fbUser.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(fbUser.email, oldP));
      await fbUser.updatePassword(newP);
      msgs.push('Online password changed.');
    } catch(e) { msgs.push('Online: ' + fbErrorText(e)); }
  }
  if(getToken()){
    try { await postJson('/api/admin/password', { oldPassword: oldP, newPassword: newP }); msgs.push('Pi password changed.'); }
    catch(e) { msgs.push('Pi: ' + e.message); }
  }
  alert(msgs.join('\n') || 'Not signed in.');
}

async function doLogout(){
  try { await fetch(apiBase() + '/api/admin/logout', { method: 'POST', headers: authHeaders() }); } catch(e) {}
  sessionStorage.removeItem(TOKEN_KEY);
  try { if(fbAuth) await fbAuth.signOut(); } catch(e) {}
  fbUser = null;
  showLogin('Signed out.');
}

// Shared by every change request: attaches the token, turns errors into messages,
// and bounces back to the login screen if the session has expired.
async function sendJson(method, path, body){
  const res = await fetch(apiBase() + path, {
    method,
    headers: authHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if(res.status === 401){
    sessionStorage.removeItem(TOKEN_KEY);
    if(fbUser) throw new Error('The Raspberry Pi did not accept this login (its password may differ from the online one). Use "Change password" to set the same password in both places.');
    showLogin('Session expired - please sign in again.');
    throw new Error('Please sign in again');
  }
  if(!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
const postJson   = (path, body) => sendJson('POST', path, body);
const patchJson  = (path, body) => sendJson('PATCH', path, body);
const deleteJson = path => sendJson('DELETE', path);

async function refreshActuators(){
  try {
    const [state, schedules, rules] = await Promise.all([
      fetchJson('/api/actuators/state'),
      fetchJson('/api/actuators/schedule'),
      fetchJson('/api/actuators/rules'),
    ]);
    renderActuatorLive(state);
    renderScheduleList(schedules);
    renderRuleList(rules);
  } catch(e) {
    document.getElementById('actLive').innerHTML = `<span class="status bad">OFFLINE — ${e.message}</span>`;
  }
}

function renderActuatorLive(state){
  const el = document.getElementById('actLive');
  const chips = [1,2,3,4].map(ch => {
    const on = !!state.channels[ch];
    return `<span class="status ${on?'ok':'wait'}">CH${ch} ${on?'OPEN':'closed'}</span>`;
  }).join('');
  const sal = state.salinity != null ? state.salinity : '—';
  el.innerHTML = chips + `<span class="status wait">Salinity ${sal}</span>`;
}

let actSchedules = [], actRules = [];
let editingScheduleId = null, editingRuleId = null;

function renderScheduleList(items){
  actSchedules = items;
  const el = document.getElementById('actScheduleList');
  if(!items.length){ el.innerHTML = '<div class="empty-node">No time schedules yet.</div>'; return; }
  el.innerHTML = items.map(s => `
    <div class="discovered-node" style="grid-template-columns:70px 1fr 90px 190px">
      <span class="node-id">${s.time}</span>
      <span class="node-type">${s.label ? escapeHtml(s.label) + ' - ' : ''}valves ${s.channels.join(',')} open ${s.durationMinutes} min · ${s.pumpOffMinutes > 0 ? 'pump off ' + s.pumpOffMinutes + ' min' : 'pump stays on'} · ${s.days}</span>
      <span class="node-seen">${s.enabled ? 'enabled' : 'disabled'}</span>
      <span class="btn-row">
        <button class="admin-btn" onclick="editSchedule(${s.id})">Edit</button>
        <button class="admin-btn" onclick="toggleSchedule(${s.id}, ${!s.enabled})">${s.enabled?'Disable':'Enable'}</button>
        <button class="admin-btn danger" onclick="removeSchedule(${s.id})">Delete</button>
      </span>
    </div>`).join('');
}

function renderRuleList(items){
  actRules = items;
  const el = document.getElementById('actRuleList');
  if(!items.length){ el.innerHTML = '<div class="empty-node">No sensor rules yet.</div>'; return; }
  el.innerHTML = items.map(r => {
    const stop = (r.stopThreshold === null || r.stopThreshold === undefined) ? 'closes as soon as it is back past ' + r.threshold : 'closes at ' + r.stopThreshold;
    return `
    <div class="discovered-node" style="grid-template-columns:70px 1fr 90px 190px">
      <span class="node-id">VALVE ${r.channel}</span>
      <span class="node-type">${r.label ? escapeHtml(r.label) + ' - ' : ''}opens when ${r.source} ${r.condition} ${r.threshold} · ${stop} · safety cap ${r.durationMinutes} min · wait ${r.cooldownMinutes} min between runs</span>
      <span class="node-seen">${r.enabled ? 'enabled' : 'disabled'}</span>
      <span class="btn-row">
        <button class="admin-btn" onclick="editRule(${r.id})">Edit</button>
        <button class="admin-btn" onclick="toggleRule(${r.id}, ${!r.enabled})">${r.enabled?'Disable':'Enable'}</button>
        <button class="admin-btn danger" onclick="removeRule(${r.id})">Delete</button>
      </span>
    </div>`;
  }).join('');
}

// ── time schedules: add / edit ──
function resetScheduleForm(){
  editingScheduleId = null;
  ['asLabel','asChannels'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('asTime').value = '06:00';
  document.getElementById('asDuration').value = 5;
  document.getElementById('asPumpOff').value = 5;
  document.getElementById('asSaveBtn').textContent = '+ Add Schedule';
  document.getElementById('asCancelBtn').style.display = 'none';
}
function editSchedule(id){
  const s = actSchedules.find(x => x.id === id); if(!s) return;
  editingScheduleId = id;
  document.getElementById('asLabel').value = s.label;
  document.getElementById('asTime').value = s.time;
  document.getElementById('asChannels').value = s.channels.join(',');
  document.getElementById('asDuration').value = s.durationMinutes;
  document.getElementById('asPumpOff').value = s.pumpOffMinutes;
  document.getElementById('asSaveBtn').textContent = 'Save changes';
  document.getElementById('asCancelBtn').style.display = '';
  document.getElementById('asTime').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function saveSchedule(){
  const time = document.getElementById('asTime').value;
  const channels = document.getElementById('asChannels').value.trim();
  const duration = parseFloat(document.getElementById('asDuration').value);
  const pumpOffRaw = parseFloat(document.getElementById('asPumpOff').value);
  const pumpOff = Number.isNaN(pumpOffRaw) ? 0 : pumpOffRaw;
  if(!time || !channels){ alert('Start time and valves (e.g. 1,2) are required.'); return; }
  if(!(duration > 0)){ alert('"Valves open" must be more than 0 minutes.'); return; }
  if(pumpOff < 0){ alert('"Pump off" cannot be negative.'); return; }
  const body = { label: document.getElementById('asLabel').value, time, channels, durationMinutes: duration, pumpOffMinutes: pumpOff };
  try {
    if(editingScheduleId) await patchJson(`/api/actuators/schedule/${editingScheduleId}`, body);
    else await postJson('/api/actuators/schedule', body);
    resetScheduleForm();
    refreshActuators();
  } catch(e) { alert('Could not save schedule: ' + e.message); }
}
async function toggleSchedule(id, enabled){ try { await patchJson(`/api/actuators/schedule/${id}`, {enabled}); refreshActuators(); } catch(e){ alert(e.message); } }
async function removeSchedule(id){ if(!confirm('Delete this schedule?')) return; try { await deleteJson(`/api/actuators/schedule/${id}`); if(editingScheduleId === id) resetScheduleForm(); refreshActuators(); } catch(e){ alert(e.message); } }

// ── salinity rules: add / edit ──
function resetRuleForm(){
  editingRuleId = null;
  ['arLabel','arThreshold','arStop'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('arDuration').value = 10;
  document.getElementById('arChannel').value = '3';
  document.getElementById('arCondition').value = 'below';
  document.getElementById('arSaveBtn').textContent = '+ Add Rule';
  document.getElementById('arCancelBtn').style.display = 'none';
}
function editRule(id){
  const r = actRules.find(x => x.id === id); if(!r) return;
  editingRuleId = id;
  document.getElementById('arLabel').value = r.label;
  document.getElementById('arChannel').value = String(r.channel);
  document.getElementById('arCondition').value = r.condition;
  document.getElementById('arThreshold').value = r.threshold;
  document.getElementById('arStop').value = (r.stopThreshold === null || r.stopThreshold === undefined) ? '' : r.stopThreshold;
  document.getElementById('arDuration').value = r.durationMinutes;
  document.getElementById('arSaveBtn').textContent = 'Save changes';
  document.getElementById('arCancelBtn').style.display = '';
  document.getElementById('arThreshold').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function saveRule(){
  const threshold = parseFloat(document.getElementById('arThreshold').value);
  if(Number.isNaN(threshold)){ alert('The start level is required.'); return; }
  const stopRaw = document.getElementById('arStop').value.trim();
  const stop = stopRaw === '' ? null : parseFloat(stopRaw);
  const condition = document.getElementById('arCondition').value;
  if(stop !== null){
    if(Number.isNaN(stop)){ alert('"Stop at" must be a number.'); return; }
    if(condition === 'below' && stop < threshold){ alert('For "open when BELOW", the stop level must be the same or higher than the start level.'); return; }
    if(condition === 'above' && stop > threshold){ alert('For "open when ABOVE", the stop level must be the same or lower than the start level.'); return; }
  }
  const cap = parseFloat(document.getElementById('arDuration').value);
  if(!(cap > 0)){ alert('The safety cap must be more than 0 minutes.'); return; }
  const body = {
    label: document.getElementById('arLabel').value,
    channel: parseInt(document.getElementById('arChannel').value, 10),
    source: 'salinity', condition, threshold, durationMinutes: cap,
  };
  try {
    if(editingRuleId){ body.stopThreshold = stop; await patchJson(`/api/actuators/rules/${editingRuleId}`, body); }
    else { if(stop !== null) body.stopThreshold = stop; await postJson('/api/actuators/rules', body); }
    resetRuleForm();
    refreshActuators();
  } catch(e) { alert('Could not save rule: ' + e.message); }
}
async function toggleRule(id, enabled){ try { await patchJson(`/api/actuators/rules/${id}`, {enabled}); refreshActuators(); } catch(e){ alert(e.message); } }
async function removeRule(id){ if(!confirm('Delete this rule?')) return; try { await deleteJson(`/api/actuators/rules/${id}`); if(editingRuleId === id) resetRuleForm(); refreshActuators(); } catch(e){ alert(e.message); } }

// Solenoid controls removed from the main website UI.

// ══════════════════════════════════════════════════════════
// PUMP + AUTO DRAIN/WEIGH CYCLE
// ══════════════════════════════════════════════════════════

async function refreshPumpCycle(){
  try {
    const [pump, schedules, log] = await Promise.all([
      fetchJson('/api/pump'),
      fetchJson('/api/drain-cycle/schedule'),
      fetchJson('/api/drain-cycle/log?limit=20'),
    ]);
    renderPumpLive(pump);
    renderDrainScheduleList(schedules);
    renderCycleLog(log);
  } catch(e) {
    document.getElementById('pumpLive').innerHTML = `<span class="status bad">OFFLINE — ${e.message}</span>`;
  }
}

function renderPumpLive(pump){
  const el = document.getElementById('pumpLive');
  const modeLabel = {auto:'auto', forced_on:'forced ON', forced_off:'forced OFF'}[pump.mode] || pump.mode;
  el.innerHTML = `<span class="status ${pump.pumpOn?'ok':'bad'}">PUMP ${pump.pumpOn?'RUNNING':'OFF'}</span>`
    + `<span class="status wait">mode: ${modeLabel}</span>`
    + (pump.activeCycles && pump.activeCycles.length
        ? pump.activeCycles.map(c => `<span class="status wait">CH${c.channel} ${c.phase}</span>`).join('')
        : '');
}

function renderDrainScheduleList(items){
  window._drainSchedules = items;
  const el = document.getElementById('dcScheduleList');
  if(!items.length){ el.innerHTML = '<div class="empty-node">No drain/weigh cycles scheduled yet.</div>'; return; }
  el.innerHTML = items.map(s => `
    <div class="discovered-node" style="grid-template-columns:70px 1fr 100px 90px">
      <span class="node-id">${s.time}</span>
      <span class="node-type">${s.label ? s.label + ' — ' : ''}drain CH${(s.drainChannels||[s.drainChannel]).join('+')} · ${s.drainMinutes}min open · pump-off lead ${s.pumpLeadSeconds ?? 5}s · wait before weigh ${s.settleSeconds}s · weighs ${s.compId==='ALL'?'all compartments':s.compId} · ${s.days}</span>
      <span class="node-seen">${s.enabled ? 'enabled' : 'disabled'}</span>
      <span class="btn-row">
        <button class="admin-btn" onclick="editDrainSchedule(${s.id})">Edit</button>
        <button class="admin-btn" onclick="toggleDrainSchedule(${s.id}, ${!s.enabled})">${s.enabled?'Disable':'Enable'}</button>
        <button class="admin-btn danger" onclick="removeDrainSchedule(${s.id})">Delete</button>
      </span>
    </div>`).join('');
}

function renderCycleLog(items){
  const el = document.getElementById('dcLog');
  if(!items.length){ el.innerHTML = '<div class="empty-node">No cycle steps logged yet.</div>'; return; }
  el.innerHTML = items.map(r => `
    <div class="discovered-node" style="grid-template-columns:70px 1fr 120px">
      <span class="node-id">${r.step}</span>
      <span class="node-type">${r.run_type} #${r.run_id}${r.detail ? ' — ' + escapeHtml(String(r.detail)) : ''}</span>
      <span class="node-seen">${new Date(r.ts).toLocaleString()}</span>
    </div>`).join('');
}

async function setPumpMode(mode){
  try { await postJson('/api/pump', {mode}); refreshPumpCycle(); } catch(e){ alert('Could not set pump mode: ' + e.message); }
}

function resetDrainScheduleForm(){
  editingDrainScheduleId = null;
  document.getElementById('dcLabel').value = '';
  document.getElementById('dcTime').value = '06:00';
  document.getElementById('dcChannels').value = '1,2';
  document.getElementById('dcComp').value = 'ALL';
  document.getElementById('dcLead').value = '0';
  document.getElementById('dcDrain').value = '2';
  document.getElementById('dcSettle').value = '20';
  document.getElementById('dcSaveBtn').textContent = '+ Add Cycle Schedule';
  document.getElementById('dcCancelBtn').style.display = 'none';
}
function editDrainSchedule(id){
  const s = (window._drainSchedules || []).find(x => Number(x.id) === Number(id));
  if(!s) return;
  editingDrainScheduleId = Number(id);
  document.getElementById('dcLabel').value = s.label || '';
  document.getElementById('dcTime').value = s.time || '06:00';
  document.getElementById('dcChannels').value = (s.drainChannels || [s.drainChannel]).join(',');
  document.getElementById('dcComp').value = s.compId || 'ALL';
  document.getElementById('dcLead').value = s.pumpLeadSeconds ?? 0;
  document.getElementById('dcDrain').value = s.drainMinutes ?? 2;
  document.getElementById('dcSettle').value = s.settleSeconds ?? 20;
  document.getElementById('dcSaveBtn').textContent = 'Save Cycle Changes';
  document.getElementById('dcCancelBtn').style.display = 'inline-block';
  document.getElementById('dcLabel').scrollIntoView({behavior:'smooth',block:'center'});
}
async function saveDrainSchedule(){
  const time = document.getElementById('dcTime').value;
  if(!time){ alert('Time is required.'); return; }
  const channels = document.getElementById('dcChannels').value.split(',').map(v=>parseInt(v.trim(),10)).filter(v=>v>=1&&v<=4);
  if(!channels.length){ alert('Enter one or more drain channels from 1 to 4, e.g. 1,2.'); return; }
  const drainMinutes = Number(document.getElementById('dcDrain').value);
  const settleSeconds = Number(document.getElementById('dcSettle').value);
  const pumpLeadSeconds = Number(document.getElementById('dcLead').value);
  if(!Number.isFinite(drainMinutes) || drainMinutes <= 0 || !Number.isFinite(settleSeconds) || settleSeconds < 0 || !Number.isFinite(pumpLeadSeconds) || pumpLeadSeconds < 0){ alert('Enter a drain duration above zero and non-negative timing values.'); return; }
  const body = {
    label: document.getElementById('dcLabel').value, time,
    drainChannels: channels,
    compId: document.getElementById('dcComp').value.trim() || 'ALL',
    pumpLeadSeconds, drainMinutes, settleSeconds
  };
  try {
    if(editingDrainScheduleId) await patchJson(`/api/drain-cycle/schedule/${editingDrainScheduleId}`, body);
    else await postJson('/api/drain-cycle/schedule', body);
    resetDrainScheduleForm();
    refreshPumpCycle();
  } catch(e) { alert('Could not save cycle schedule: ' + e.message); }
}
async function addDrainSchedule(){ return saveDrainSchedule(); }
async function toggleDrainSchedule(id, enabled){ try { await patchJson(`/api/drain-cycle/schedule/${id}`, {enabled}); refreshPumpCycle(); } catch(e){ alert(e.message); } }
async function removeDrainSchedule(id){ if(!confirm('Delete this cycle schedule?')) return; try { await deleteJson(`/api/drain-cycle/schedule/${id}`); refreshPumpCycle(); } catch(e){ alert(e.message); } }

async function runCycleNow(){
  const channels = document.getElementById('rnChannels').value.split(',').map(v=>parseInt(v.trim(),10)).filter(v=>v>=1&&v<=4);
  if(!channels.length){ alert('Enter one or more drain channels from 1 to 4, e.g. 1,2.'); return; }
  try {
    await postJson('/api/drain-cycle/run-now', {
      drainChannels: document.getElementById('rnChannels').value.split(',').map(v=>parseInt(v.trim(),10)).filter(v=>v>=1&&v<=4),
      compId: document.getElementById('rnComp').value.trim() || 'C04',
      pumpLeadSeconds: Math.max(0, parseFloat(document.getElementById('rnLead').value) || 0),
      drainMinutes: parseFloat(document.getElementById('rnDrain').value) || 3,
      settleSeconds: Math.max(0, parseFloat(document.getElementById('rnSettle').value) || 0),
    });
    refreshPumpCycle();
  } catch(e) { alert('Could not start cycle: ' + e.message); }
}

// Pump and drain-cycle controls removed from the main website UI.


// ══════════════════════════════════════════════════════════
// SCALES — TARE / CALIBRATE FROM THE WEBSITE
// ══════════════════════════════════════════════════════════
let editingDrainScheduleId = null;
let scaleState = [], scaleCmds = [], liveWeights = [], piScaleOk = false;
let fbScale = { cmd: {}, res: {}, info: {}, weights: {} };
let fbScaleListening = false;

(function fillCompSelect(){
  const sel = document.getElementById('scComp');
  for(let i = 1; i <= 10; i++){ const id = 'C' + String(i).padStart(2, '0'); sel.insertAdjacentHTML('beforeend', `<option value="${id}">${id}</option>`); }
  sel.value = 'C04';
})();

// ── ONLINE path: requests, results and info live in Firebase under /crab_scale ──
function attachScaleListeners(){
  if(!firebaseDb || !fbUser || fbScaleListening) return;
  fbScaleListening = true;
  ['cmd', 'res', 'info'].forEach(k => {
    firebaseDb.ref('/crab_scale/' + k).on('value', snap => {
      fbScale[k] = snap.val() || {};
      renderScaleInfo(); renderScaleCmds();
    }, e => console.warn('crab_scale/' + k + ' read refused:', e.message));
  });
  firebaseDb.ref('/crab_monitor/weights').on('value', snap => { fbScale.weights = snap.val() || {}; renderScaleInfo(); }, () => {});
}

function renderLinkStatus(){
  const el = document.getElementById('scLink'); if(!el) return;
  const online = fbUser ? (fbConnected ? '<b class="cmd-ok">online (Firebase) ✓</b>' : '<b class="cmd-bad">Firebase offline</b>') : '<b class="cmd-wait">not signed in online</b>';
  const pi = getToken() ? (piScaleOk ? '<b class="cmd-ok">Pi backup ✓</b>' : '<b class="cmd-bad">Pi not reachable</b>') : '<b class="cmd-wait">Pi backup: not signed in</b>';
  el.innerHTML = 'Route: ' + online + ' · ' + pi;
}

function serverNowSec(){ return (Date.now() + serverOffset) / 1000; }

function fbCommandRows(){
  return Object.entries(fbScale.cmd).map(([comp, c]) => {
    const r = fbScale.res[comp];
    let status = 'pending', message = '';
    if(r && String(r.id) === String(c.id)){ status = r.ok ? 'done' : 'failed'; message = r.message || ''; }
    else if(serverNowSec() - (c.tsSec || 0) > 120){ status = 'expired'; message = 'Board did not pick this up in time - nothing was changed'; }
    return { compId: comp, action: c.action, knownWeight: c.knownWeight, status, message, ts: (c.tsSec || 0) * 1000, via: 'online' };
  });
}

async function refreshScales(){
  if(!getToken()){ piScaleOk = false; renderLinkStatus(); return; }
  try {
    const [st, cmds, data] = await Promise.all([ fetchJson('/api/scale/state'), fetchJson('/api/scale/commands?limit=10'), fetchJson('/api/data') ]);
    scaleState = st; scaleCmds = cmds; liveWeights = data.weights || []; piScaleOk = true;
  } catch(e) { piScaleOk = false; }
  renderScaleInfo(); renderScaleCmds(); renderLinkStatus();
}

function renderScaleInfo(){
  const comp = document.getElementById('scComp').value;
  const idx = parseInt(comp.slice(1), 10) - 1;
  const fbW = fbScale.weights[comp];
  const fbInfo = fbScale.info[comp] || {};
  const piSt = scaleState.find(x => x.compId === comp) || {};

  let w = (fbW && typeof fbW.weight === 'number') ? fbW.weight : liveWeights[idx];
  let cf = (typeof fbInfo.cal_factor === 'number') ? fbInfo.cal_factor : (fbW && typeof fbW.cal_factor === 'number') ? fbW.cal_factor : piSt.calFactor;
  const when = t => t ? new Date(t).toLocaleString() : 'never (from this page)';
  document.getElementById('scLive').textContent = (typeof w === 'number') ? w.toFixed(1) + ' g' : 'no reading yet';
  document.getElementById('scFactor').textContent = (typeof cf === 'number') ? cf.toFixed(4) : '-';
  document.getElementById('scLastTare').textContent = when(fbInfo.last_tare || piSt.lastTareTs);
  document.getElementById('scLastCal').textContent = when(fbInfo.last_cal || piSt.lastCalTs);
}

function renderScaleCmds(){
  const el = document.getElementById('scCmdList');
  const rows = [
    ...fbCommandRows(),
    ...scaleCmds.map(c => ({ compId: c.compId, action: c.action, knownWeight: c.knownWeight, status: c.status, message: c.message, ts: Date.parse(c.ts) || 0, via: 'Pi' })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 12);
  if(!rows.length){ el.innerHTML = '<div class="empty-node">No tare / calibrate requests yet.</div>'; return; }
  const cls = { pending:'cmd-wait', done:'cmd-ok', failed:'cmd-bad', expired:'cmd-bad' };
  const txt = { pending:'WAITING FOR BOARD...', done:'DONE', failed:'FAILED', expired:'CANCELLED' };
  el.innerHTML = rows.map(c => `
    <div class="discovered-node" style="grid-template-columns:60px 1fr 150px">
      <span class="node-id">${c.compId}</span>
      <span class="node-type"><b class="${cls[c.status] || ''}">${txt[c.status] || c.status}</b> - ${c.action === 'tare' ? 'Tare' : 'Calibrate with ' + c.knownWeight + ' g'}${c.message ? ' - ' + escapeHtml(c.message) : ''} <span class="small">(${c.via})</span></span>
      <span class="node-seen">${c.ts ? new Date(c.ts).toLocaleTimeString() : ''}</span>
    </div>`).join('');
}

async function sendScaleCommand(body){
  // ONLINE first (no Pi needed). The Pi is only used when Firebase isn't reachable.
  if(fbUser && firebaseDb && fbConnected){
    if(fbCommandRows().some(r => r.compId === body.compId && r.status === 'pending')){
      alert(`A request for ${body.compId} is already waiting for the board.`); return;
    }
    const rec = { id: Date.now() + '-' + Math.floor(Math.random() * 1000), action: body.action, tsSec: Math.floor(serverNowSec()) };
    if(body.action === 'calibrate') rec.knownWeight = body.knownWeight;
    try { await firebaseDb.ref('/crab_scale/cmd/' + body.compId).set(rec); }
    catch(e){ alert('Firebase refused the request: ' + e.message + '\n\nCheck the database rules (docs/FIREBASE_ONLINE_SCALES.md).'); }
    return;
  }
  if(getToken()){
    try { await postJson('/api/scale/command', body); } catch(e){ alert('Could not send request: ' + e.message); return; }
    refreshScales();
    let n = 0; const t = setInterval(async () => { await refreshScales(); if(++n > 40 || !scaleCmds.some(c => c.status === 'pending')) clearInterval(t); }, 1500);
    return;
  }
  alert('Not connected: sign in with your online admin account (internet) or the Pi login (local network).');
}
function scaleTare(){
  const comp = document.getElementById('scComp').value;
  if(!confirm(`Tare ${comp}?\n\nThe scale must be COMPLETELY EMPTY (no crabs, no container) - whatever is on it right now becomes zero.`)) return;
  sendScaleCommand({ compId: comp, action: 'tare' });
}
function scaleCalibrate(){
  const comp = document.getElementById('scComp').value;
  const g = parseFloat(document.getElementById('scKnown').value);
  if(!(g > 0)){ alert('Enter the known weight in grams first.'); return; }
  if(!confirm(`Calibrate ${comp} using ${g} g?\n\nOnly continue if the scale was tared EMPTY first and that ${g} g object is sitting on it right now.`)) return;
  sendScaleCommand({ compId: comp, action: 'calibrate', knownWeight: g });
}
setInterval(() => { refreshScales(); renderScaleCmds(); }, 5000);


// ========== FIREBASE SOLENOID CONTROLLER ==========
const SOLENOID_ROOT = '/solenoid_control';
let solenoidStatusListener = null;
let solenoidScheduleListener = null;
function solenoidMsg(message, kind='wait') {
  const el = document.getElementById('solenoidMessage');
  if (el) { el.textContent = message; el.className = 'small cmd-' + (kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : 'wait'); }
}
function solenoidSetStateText(ch, on) {
  const el = document.getElementById('s' + ch + 'State');
  if (el) { el.textContent = on ? 'ON' : 'OFF'; el.style.color = on ? 'var(--teal)' : 'var(--text3)'; }
}
async function solenoidSet(channel, on) {
  if (!fbUser || !firebaseDb) { solenoidMsg('Please sign in with the Firebase admin account first.', 'bad'); return; }
  if (![1,2,3,4].includes(channel)) return;
  if (channel === 3 && on && document.getElementById('s4State')?.textContent === 'ON') { solenoidMsg('Blocked: turn S4 OFF before opening S3.', 'bad'); return; }
  if (channel === 4 && on && document.getElementById('s3State')?.textContent === 'ON') { solenoidMsg('Blocked: turn S3 OFF before opening S4.', 'bad'); return; }
  try {
    const command = { id: String(Date.now()) + '-' + Math.random().toString(36).slice(2,8), action:'valve', channel, state:!!on, issuedAt:firebase.database.ServerValue.TIMESTAMP, issuedBy:fbUser.uid };
    await firebaseDb.ref(SOLENOID_ROOT + '/command').set(command);
    solenoidMsg(`Command sent: S${channel} ${on ? 'ON' : 'OFF'}. Waiting for ESP32 confirmation…`, 'ok');
  } catch(e) { solenoidMsg('Command failed: ' + e.message, 'bad'); }
}
async function solenoidAllOff() {
  if (!fbUser || !firebaseDb) { solenoidMsg('Please sign in with the Firebase admin account first.', 'bad'); return; }
  if (!confirm('Turn OFF all four solenoid valves?')) return;
  try {
    await firebaseDb.ref(SOLENOID_ROOT + '/command').set({id:String(Date.now())+'-'+Math.random().toString(36).slice(2,8), action:'all_off', issuedAt:firebase.database.ServerValue.TIMESTAMP, issuedBy:fbUser.uid});
    solenoidMsg('ALL VALVES OFF command sent. Waiting for ESP32 confirmation…', 'ok');
  } catch(e) { solenoidMsg('Command failed: ' + e.message, 'bad'); }
}
async function saveSolenoidSchedule() {
  if (!fbUser || !firebaseDb) { solenoidMsg('Please sign in with the Firebase admin account first.', 'bad'); return; }
  const time = document.getElementById('solDrainTime').value;
  const duration = Number(document.getElementById('solDrainDuration').value);
  if (!/^\d{2}:\d{2}$/.test(time) || !Number.isInteger(duration) || duration < 1 || duration > 86400) { solenoidMsg('Enter a valid time and duration between 1 and 86400 seconds.', 'bad'); return; }
  const [hour, minute] = time.split(':').map(Number);
  try {
    await firebaseDb.ref(SOLENOID_ROOT + '/schedule').set({enabled:document.getElementById('solDrainEnabled').checked, hour, minute, durationSeconds:duration, updatedAt:firebase.database.ServerValue.TIMESTAMP, updatedBy:fbUser.uid});
    solenoidMsg('Daily drain schedule saved to Firebase.', 'ok');
  } catch(e) { solenoidMsg('Could not save schedule: ' + e.message, 'bad'); }
}
function loadSolenoidStatus() {
  if (!firebaseDb || !fbUser) { solenoidMsg('Sign in with Firebase to view controller status.', 'bad'); return; }
  if (!solenoidStatusListener) {
    solenoidStatusListener = firebaseDb.ref(SOLENOID_ROOT + '/status').on('value', snap => {
      const d = snap.val();
      const online = !!(d && d.lastSeen && (Date.now() - Number(d.lastSeen) < 45000));
      const badge = document.getElementById('solenoidOnline');
      if (badge) badge.innerHTML = `<span class="status ${online?'ok':'bad'}">${online?'ONLINE':'OFFLINE'}</span>`;
      const seen = document.getElementById('solenoidLastSeen');
      if (seen) seen.textContent = d && d.lastSeen ? new Date(Number(d.lastSeen)).toLocaleString() : 'No heartbeat yet';
      [1,2,3,4].forEach(ch => solenoidSetStateText(ch, !!(d && d.valves && d.valves['s'+ch])));
      if (d && d.sensor && d.sensor.ec !== undefined) document.getElementById('solenoidEc').textContent = d.sensor.ec + (d.sensor.field ? ' ('+d.sensor.field+')' : '');
      if (d && d.lastCommandResult) solenoidMsg('ESP32: ' + d.lastCommandResult, d.lastCommandOk ? 'ok' : 'bad');
    }, err => solenoidMsg('Cannot read solenoid status: ' + err.message, 'bad'));
  }
  if (!solenoidScheduleListener) {
    solenoidScheduleListener = firebaseDb.ref(SOLENOID_ROOT + '/schedule').on('value', snap => {
      const d=snap.val(); if(!d) return;
      document.getElementById('solDrainTime').value=String(d.hour ?? 6).padStart(2,'0')+':'+String(d.minute ?? 0).padStart(2,'0');
      document.getElementById('solDrainDuration').value=d.durationSeconds ?? 120;
      document.getElementById('solDrainEnabled').checked=!!d.enabled;
    }, err => solenoidMsg('Cannot read schedule: '+err.message,'bad'));
  }
}

// ========== STARTUP ==========
// The page stays hidden behind the login screen until the Pi confirms a valid session.
['node1','node2','node3'].forEach(setNodeDisplay);
updateAutoDiscovery();
renderNodes();
initFirebase().then(checkSession); // Firebase first (online admin), then decide which login screen to show


// ══════════════════════════════════════════════════════════
// ADMIN PAGE TABS + FEEDING REMINDERS / NOTIFICATIONS
// ══════════════════════════════════════════════════════════
function showAdminPage(page){
  document.querySelectorAll('.admin-card[data-page]').forEach(el => el.classList.toggle('page-hidden', el.dataset.page !== page));
  document.querySelectorAll('[data-admin-page]').forEach(el => el.classList.toggle('active', el.dataset.adminPage === page));
  try { sessionStorage.setItem('crabtrack_admin_page', page); } catch(_) {}
  if(page === 'feeding') refreshFeedingPage();
  if(page === 'raspberry') testApi();
  if(page === 'calibration') { refreshScales(); renderLinkStatus(); }
  if(page === 'solenoids') loadSolenoidStatus();
  if(page === 'pump') loadPumpStatus();
  
}

function feedEscape(v){ return escapeHtml(String(v ?? '')); }
async function refreshFeedingPage(){
  await Promise.allSettled([refreshFeedSchedules(), refreshFeedDue(), loadFeedMessages()]);
}
async function refreshFeedSchedules(){
  const el = document.getElementById('feedScheduleList'); if(!el) return;
  try {
    const rows = await fetchJson('/api/schedule');
    if(!rows.length){ el.innerHTML = '<div class="empty-node">No feeding reminders yet. Add one above.</div>'; return; }
    el.innerHTML = rows.map(r => `<div class="discovered-node" style="grid-template-columns:1.2fr 100px 1.3fr 90px 150px">
      <span class="node-type"><b>${feedEscape(r.label || 'Feeding reminder')}</b></span><span>${feedEscape(r.time)}</span><span class="small">${feedEscape(r.compIds || 'all')} · grace ${Number(r.graceMinutes ?? 60)} min</span>
      <span class="status ${r.enabled ? 'ok':'bad'}">${r.enabled ? 'ENABLED':'PAUSED'}</span>
      <span class="btn-row"><button class="admin-btn" onclick="toggleFeedingSchedule(${Number(r.id)},${!r.enabled})">${r.enabled?'Pause':'Enable'}</button><button class="admin-btn danger" onclick="deleteFeedingSchedule(${Number(r.id)})">Delete</button></span>
    </div>`).join('');
  } catch(e){ el.innerHTML = `<div class="empty-node">Could not load schedules: ${feedEscape(e.message)}. Check that the Raspberry Pi API is online.</div>`; }
}
async function addFeedingSchedule(){
  const time = document.getElementById('feedTime').value;
  const label = document.getElementById('feedLabel').value.trim() || 'Feeding reminder';
  const compIds = document.getElementById('feedComps').value.trim() || 'all';
  const graceMinutes = Math.max(0, Number(document.getElementById('feedGrace').value || 60));
  if(!/^\d{2}:\d{2}$/.test(time)){ alert('Choose a feeding time first.'); return; }
  if(compIds !== 'all' && !/^C(?:0[1-9]|10)(?:\s*,\s*C(?:0[1-9]|10))*$/i.test(compIds)){ alert('Use "all" or compartment IDs like C01,C02,C03.'); return; }
  try { await postJson('/api/schedule', { label, time, days:'daily', compIds: compIds.toUpperCase() === 'ALL' ? 'all' : compIds.toUpperCase().replace(/\s+/g,''), graceMinutes });
    document.getElementById('feedNotifyStatus').textContent = 'Feeding reminder saved. The Pi checks reminders every 5 minutes.';
    await refreshFeedSchedules(); await refreshFeedDue();
  } catch(e){ alert('Could not save reminder: ' + e.message); }
}
async function toggleFeedingSchedule(id, enabled){
  try { await patchJson('/api/schedule/' + id, {enabled}); await refreshFeedSchedules(); }
  catch(e){ alert('Could not update reminder: ' + e.message); }
}
async function deleteFeedingSchedule(id){
  if(!confirm('Delete this feeding reminder?')) return;
  try { await deleteJson('/api/schedule/' + id); await refreshFeedSchedules(); }
  catch(e){ alert('Could not delete reminder: ' + e.message); }
}
async function refreshFeedDue(){
  const el = document.getElementById('feedDueList'); if(!el) return;
  try {
    const data = await fetchJson('/api/feeding-alerts');
    const rows = [...(data.scheduled || []), ...(data.interval || [])];
    if(!rows.length){ el.innerHTML = '<div class="empty-node">No overdue feeding reminders right now.</div>'; return; }
    el.innerHTML = rows.map(a => `<div class="discovered-node" style="grid-template-columns:90px 1fr 120px"><span class="node-id">${feedEscape(a.compId || 'All')}</span><span>${feedEscape(a.msg || 'Feeding due')}</span><span class="status ${a.level === 'alert' ? 'bad':'wait'}">${feedEscape(a.level || 'reminder')}</span></div>`).join('');
  } catch(e){ el.innerHTML = `<div class="empty-node">Unable to load due feedings: ${feedEscape(e.message)}</div>`; }
}
async function loadFeedMessages(){
  const status = document.getElementById('feedChannels'); if(!status) return;
  try {
    const data = await fetchJson('/api/messages?limit=12');
    const channels = data.channels || ['log'];
    status.textContent = channels.join(', ');
    const sel = document.getElementById('feedChannel');
    const old = sel.value;
    sel.innerHTML = channels.map(c => `<option value="${feedEscape(c)}">${feedEscape(c)}</option>`).join('');
    if(channels.includes(old)) sel.value = old;
    const out = document.getElementById('feedOutbox');
    const rows = data.outbox || [];
    if(!rows.length){ out.innerHTML = '<div class="empty-node">No messages in the outbox yet.</div>'; return; }
    out.innerHTML = rows.map(m => `<div class="discovered-node" style="grid-template-columns:100px 90px 1fr 110px"><span>${feedEscape(m.channel || 'log')}</span><span class="status ${m.status === 'sent' ? 'ok':'wait'}">${feedEscape(m.status || 'queued')}</span><span>${feedEscape(m.body || m.message || '')}</span><span class="node-seen">${feedEscape(m.created_at || m.created_ts || m.ts || '')}</span></div>`).join('');
  } catch(e){ status.textContent = 'Pi API unavailable'; document.getElementById('feedOutbox').innerHTML = `<div class="empty-node">${feedEscape(e.message)}</div>`; }
}
async function sendFeedingTest(){
  const body = document.getElementById('feedTestText').value.trim();
  const channel = document.getElementById('feedChannel').value || 'log';
  if(!body){ alert('Enter a test message.'); return; }
  const out = document.getElementById('feedNotifyStatus'); out.textContent = 'Queueing message…';
  try { const r = await postJson('/api/message', {body, channel}); out.textContent = `Queued message #${r.id} via ${r.channel}. Delivery can take a moment; refresh the outbox to check status.`; await loadFeedMessages(); }
  catch(e){ out.textContent = 'Message failed: ' + e.message; }
}

// Restore last page after the existing login flow reveals the admin app.
const originalShowAppForPages = showApp;
showApp = function(){ originalShowAppForPages(); let page='overview'; try { page=sessionStorage.getItem('crabtrack_admin_page') || 'overview'; } catch(_){} showAdminPage(page); };


// ========== FIREBASE PUMP CONTROLLER ==========
const PUMP_ROOT = '/pump_control';
let pumpStatusListener = null, pumpScheduleListener = null;
function pumpMsg(message, kind='wait') {
  const el=document.getElementById('pumpMessage');
  if(el){el.textContent=message;el.className='small cmd-'+(kind==='ok'?'ok':kind==='bad'?'bad':'wait');}
}
async function pumpSet(on){
  if(!fbUser||!firebaseDb){pumpMsg('Please sign in with the Firebase admin account first.','bad');return;}
  try{
    const cmd={id:String(Date.now())+'-'+Math.random().toString(36).slice(2,8),action:'pump',state:!!on,issuedAt:firebase.database.ServerValue.TIMESTAMP,issuedBy:fbUser.uid};
    await firebaseDb.ref(PUMP_ROOT+'/command').set(cmd);
    pumpMsg('Pump '+(on?'ON':'OFF')+' command sent. Waiting for ESP32 confirmation…','ok');
  }catch(e){pumpMsg('Command failed: '+e.message,'bad');}
}
async function savePumpSchedule(){
  if(!fbUser||!firebaseDb){pumpMsg('Please sign in with the Firebase admin account first.','bad');return;}
  const t=document.getElementById('pumpOffTime').value,dur=Number(document.getElementById('pumpOffDuration').value);
  if(!/^\d{2}:\d{2}$/.test(t)||!Number.isInteger(dur)||dur<1||dur>1440){pumpMsg('Enter a valid time and duration between 1 and 1440 minutes.','bad');return;}
  const [offHour,offMinute]=t.split(':').map(Number);
  try{await firebaseDb.ref(PUMP_ROOT+'/schedule').set({enabled:document.getElementById('pumpScheduleEnabled').checked,offHour,offMinute,durationMinutes:dur,updatedAt:firebase.database.ServerValue.TIMESTAMP,updatedBy:fbUser.uid});pumpMsg('Pump schedule saved to Firebase.','ok');}
  catch(e){pumpMsg('Could not save schedule: '+e.message,'bad');}
}
function loadPumpStatus(){
  if(!firebaseDb||!fbUser){pumpMsg('Sign in with Firebase to view controller status.','bad');return;}
  if(!pumpStatusListener){pumpStatusListener=firebaseDb.ref(PUMP_ROOT+'/status').on('value',snap=>{
    const d=snap.val(), online=!!(d&&d.lastSeen&&(Date.now()-Number(d.lastSeen)<45000));
    const badge=document.getElementById('pumpOnline');if(badge)badge.innerHTML=`<span class="status ${online?'ok':'bad'}">${online?'ONLINE':'OFFLINE'}</span>`;
    const seen=document.getElementById('pumpLastSeen');if(seen)seen.textContent=d&&d.lastSeen?new Date(Number(d.lastSeen)).toLocaleString():'No heartbeat yet';
    const state=document.getElementById('pumpState');if(state){state.textContent=d&&typeof d.pump==='boolean'?(d.pump?'ON':'OFF'):'UNKNOWN';state.style.color=d&&d.pump?'var(--teal)':'var(--text3)';}
    const clock=document.getElementById('pumpClock');if(clock)clock.textContent=d?(d.clockReady?'Ready (Philippine time)':'Waiting for network time'):'—';
    const rem=document.getElementById('pumpRemaining');if(rem)rem.textContent=d&&d.remaining?d.remaining:'—';
    if(d&&d.lastCommandResult)pumpMsg('ESP32: '+d.lastCommandResult,d.lastCommandOk?'ok':'bad');
  },e=>pumpMsg('Cannot read pump status: '+e.message,'bad'));}
  if(!pumpScheduleListener){pumpScheduleListener=firebaseDb.ref(PUMP_ROOT+'/schedule').on('value',snap=>{
    const d=snap.val();if(!d)return;
    document.getElementById('pumpOffTime').value=String(d.offHour??22).padStart(2,'0')+':'+String(d.offMinute??0).padStart(2,'0');
    document.getElementById('pumpOffDuration').value=d.durationMinutes??120;
    document.getElementById('pumpScheduleEnabled').checked=d.enabled!==false;
  },e=>pumpMsg('Cannot read pump schedule: '+e.message,'bad'));}
}
