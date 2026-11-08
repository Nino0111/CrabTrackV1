// ══════════════════════════════════════════════════════════
// CONFIG  — loaded from localStorage
// ══════════════════════════════════════════════════════════
const N = 10;
const COLORS = ['#00D4AA','#3B82F6','#F59E0B','#A855F7','#EF4444','#06B6D4','#84CC16','#F97316','#EC4899','#8B5CF6'];

const storedFbPath = localStorage.getItem('fb_path') || '';
const cfg = {
  piApi:    localStorage.getItem('pi_api_url') || 'http://10.193.219.111:3000',
  esp:      localStorage.getItem('esp_url')  || '',
  fbUrl:    localStorage.getItem('fb_url')   || 'https://crabtrack-1e256-default-rtdb.asia-southeast1.firebasedatabase.app',
  fbPath:   (storedFbPath === '/crab_monitor/latest' || !storedFbPath) ? '/crab_monitor' : storedFbPath,
  apiKey:   localStorage.getItem('api_key')  || '',
  interval: parseInt(localStorage.getItem('esp_int') || '5'),
  calib:    parseFloat(localStorage.getItem('calib')  || '420'),
  target:   parseFloat(localStorage.getItem('target') || '300'),
};

const thresholds = {
  phMin:   parseFloat(localStorage.getItem('th_phMin')   || '7.0'),
  phMax:   parseFloat(localStorage.getItem('th_phMax')   || '8.5'),
  salMin:  parseFloat(localStorage.getItem('th_salMin')  || '10'),
  salMax:  parseFloat(localStorage.getItem('th_salMax')  || '25'),
  tmpMin:  parseFloat(localStorage.getItem('th_tmpMin')  || '24'),
  tmpMax:  parseFloat(localStorage.getItem('th_tmpMax')  || '30'),
  wtAlert: parseFloat(localStorage.getItem('th_wtAlert') || '100'),
  wtWarn:  parseFloat(localStorage.getItem('th_wtWarn')  || '130'),
  feedWarn:  parseFloat(localStorage.getItem('th_feedWarn')  || '24'),  // hours since fed → reminder
  feedAlert: parseFloat(localStorage.getItem('th_feedAlert') || '48'),  // hours since fed → urgent alert
};

// ══════════════════════════════════════════════════════════
// LIVE DATA  — only populated from real sources
// ══════════════════════════════════════════════════════════
let sensors = { ph: 0, salinity: 0, temperature: 0 };
let sensorHistory = JSON.parse(localStorage.getItem('sensorHistory') || '[]');
let alertLog      = JSON.parse(localStorage.getItem('alertLog')      || '[]');
let compartments  = loadCompartments();
let pollTimer     = null;
let selectedComp  = 0;
let detChart      = null;
let lastFbData    = null;     // timestamp of last successful Firebase read
let fbPollCount   = 0;
let fbFailCount   = 0;
const charts      = {};
const globalChatHistory = [];
const detChatHistory    = [];

// ── Load compartments — fresh if no real data yet ─────────
function loadCompartments() {
  const saved = localStorage.getItem('comps_v2');
  if (saved) {
    const parsed = JSON.parse(saved);
    // If the saved data has no source (pure demo) and we have no Firebase,
    // keep it. But reset initWeight = weight so gains show 0 not negative.
    return parsed;
  }
  // Brand-new: create with weight=0 and initWeight=0 so gains start at 0
  return Array.from({length: N}, (_, i) => ({
    id:         `C${String(i+1).padStart(2,'0')}`,
    name:       `Mud Crab #${i+1}`,
    weight:     0,
    initWeight: 0,       // ← 0 so gain = 0, not negative
    history:    [],
    obsLog:     [],
    feedLog:    [],
    status:     'ok',
  }));
}

function saveComps() { localStorage.setItem('comps_v2', JSON.stringify(compartments)); }

// ══════════════════════════════════════════════════════════
// CLOCK
// ══════════════════════════════════════════════════════════
function tick() {
  document.getElementById('topTime').textContent =
    new Date().toLocaleString('en-PH',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})+' PHT';
}
setInterval(tick, 1000); tick();

// ══════════════════════════════════════════════════════════
// SIDEBAR
// ══════════════════════════════════════════════════════════
function renderSidebar() {
  document.getElementById('sbSensors').innerHTML =
    `<div class="sb-sec-label">WATER PARAMETERS</div>` +
    sensorBlock('ph',  'pH LEVEL',    sensors.ph.toFixed(2),       'pH',  ((sensors.ph-6)/3*100).toFixed(0),          'var(--teal)',   '6.0','9.0',
      sensors.ph===0?'warn': sensors.ph>=thresholds.phMin&&sensors.ph<=thresholds.phMax?'ok':'err') +
    sensorBlock('sal', 'SALINITY',    sensors.salinity.toFixed(1),  'ppt', (sensors.salinity/35*100).toFixed(0),        'var(--blue)',   '0','35',
      sensors.salinity===0?'warn': sensors.salinity>=thresholds.salMin&&sensors.salinity<=thresholds.salMax?'ok':'err') +
    sensorBlock('tmp', 'TEMPERATURE', sensors.temperature.toFixed(1),'°C', ((sensors.temperature-20)/20*100).toFixed(0),'var(--amber)',  '20°','40°',
      sensors.temperature===0?'warn': sensors.temperature>=thresholds.tmpMin&&sensors.temperature<=thresholds.tmpMax?'ok':'err');

  document.getElementById('sbCompList').innerHTML =
    `<div class="sb-sec-label">COMPARTMENTS</div>` +
    compartments.map((c, i) => {
      const dc = c.status==='ok' ? 'var(--teal)' : c.status==='warn' ? 'var(--amber)' : 'var(--red)';
      const isDetail = document.getElementById('pageDetail').classList.contains('active');
      return `<div class="cl-item${isDetail&&i===selectedComp?' active':''}" onclick="showDetail(${i})">
        <span class="cl-dot" style="background:${dc}"></span>
        <span class="cl-name">${c.id}</span>
        <span class="cl-w">${c.weight.toFixed(1)}g</span>
      </div>`;
    }).join('');
}

function sensorBlock(cls, label, val, unit, pct, color, rMin, rMax, status) {
  const alrt = status === 'err';
  return `<div class="sensor-block ${cls}${alrt?' alert-sensor':''}">
    <div class="sb-label">${label}</div>
    <div class="sb-val">${val}<span class="sb-unit">${unit}</span></div>
    <div class="sb-bar"><div class="sb-bar-fill" style="width:${Math.min(100,Math.max(0,pct))}%;background:${color}"></div></div>
    <div class="sb-range"><span>${rMin}</span><span>${rMax}</span></div>
    <span class="sb-badge ${status}">${status==='ok'?'OPTIMAL':status==='warn'?'WAITING':'ALERT'}</span>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// PAGE NAVIGATION
// ══════════════════════════════════════════════════════════
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sb-nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page' + name[0].toUpperCase() + name.slice(1)).classList.add('active');
  const nav = document.getElementById('nav-' + name);
  if (nav) nav.classList.add('active');
  if (name === 'overview')  renderOverview();
  if (name === 'analytics') renderAnalytics();
  if (name === 'feeding')   renderFeedingPage();
  if (name === 'alerts')    renderAlertsPage();
  if (name === 'ai')        renderAIPage();
  if (name === 'reports')   renderReports();
}

// ══════════════════════════════════════════════════════════
// OVERVIEW
// ══════════════════════════════════════════════════════════
function renderOverview() {
  const weights   = compartments.map(c => c.weight);
  const gains     = compartments.map(c => c.weight - c.initWeight);
  const avg       = weights.reduce((a,b) => a+b, 0) / N;
  const avgGain   = gains.reduce((a,b) => a+b, 0) / N;
  const alerts    = compartments.filter(c => c.status === 'alert').length;
  const warns     = compartments.filter(c => c.status === 'warn').length;
  const growthRates = compartments.map(c => {
    if (c.history.length < 2) return 0;
    const days = (new Date(c.history[c.history.length-1].date) - new Date(c.history[0].date)) / (1000*86400) || 1;
    return (c.weight - c.initWeight) / days;
  });
  const avgRate = growthRates.reduce((a,b) => a+b, 0) / N;

  document.getElementById('statRow').innerHTML = [
    ['TOTAL WEIGHT','c-teal',   (weights.reduce((a,b)=>a+b,0)/1000).toFixed(2), 'kg',    'All 10 compartments'],
    ['AVG WEIGHT',  'c-blue',   avg.toFixed(1),                                 'g',     'Per compartment'],
    ['AVG GAIN',    'c-teal',   (avgGain>=0?'+':'')+avgGain.toFixed(1),         'g',     'From initial'],
    ['GROWTH RATE', 'c-purple', avgRate.toFixed(2),                             'g/day', 'Average'],
    ['ALERTS',      'c-red',    alerts+warns,                                   '',      `${alerts} alert, ${warns} warn`],
  ].map(([l,c,v,u,s]) =>
    `<div class="stat-card ${c}"><div class="stat-lbl">${l}</div><div class="stat-val">${v}<span class="stat-unit">${u}</span></div><div class="stat-sub">${s}</div></div>`
  ).join('');

  // Harvest row
  // Per-compartment harvest readiness cards removed from the overview.


  // Comp grid
  document.getElementById('compGrid').innerHTML = compartments.map((c, i) => {
    const fp   = c.weight > 0 ? Math.min(95, Math.max(5, (c.weight / cfg.target) * 100)) : 0;
    const gain = c.weight - c.initWeight;
    const wc   = c.status==='ok' ? 'tw-ok' : c.status==='warn' ? 'tw-warn' : 'tw-alert';
    const cc   = c.status==='warn' ? ' warn-card' : c.status==='alert' ? ' alert-card' : '';
    const dc   = c.status==='ok' ? 'var(--teal)' : c.status==='warn' ? 'var(--amber)' : 'var(--red)';
    return `<div class="comp-card${cc}${i===selectedComp?' sel-card':''}" onclick="showDetail(${i})">
      <div class="cc-hdr"><span class="cc-id">${c.id}</span><span class="cc-dot" style="background:${dc}"></span></div>
      <div class="tank">
        <div class="tank-water ${wc}" style="height:${fp.toFixed(0)}%"></div>
        <div class="tank-lbl">${c.weight > 0 ? c.weight.toFixed(1)+'g' : '--'}</div>
      </div>
      <div class="cc-name">${c.name}</div>
      <div class="cc-gain" style="color:${gain>=0?'var(--teal)':'var(--red)'}">
        ${c.initWeight===0&&c.weight===0 ? 'waiting for data' : (gain>=0?'+':'')+gain.toFixed(1)+'g total'}
      </div>
    </div>`;
  }).join('');

  renderSidebar();
}

// ══════════════════════════════════════════════════════════
// DETAIL
// ══════════════════════════════════════════════════════════
function showDetail(i) {
  selectedComp = i;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('pageDetail').classList.add('active');
  document.querySelectorAll('.sb-nav-item').forEach(n => n.classList.remove('active'));
  renderDetail();
  renderSidebar();
}

function renderDetail() {
  const c    = compartments[selectedComp];
  const gain = c.weight - c.initWeight;
  const rate = c.history.length > 2 ? (c.weight - c.history[Math.max(0,c.history.length-8)].weight) / Math.min(7,c.history.length-1) : 0;
  const daysToHarvest = rate > 0 ? Math.round((cfg.target - c.weight) / rate) : null;

  document.getElementById('detTitle').textContent = `${c.id} — ${c.name}`;
  document.getElementById('detSub').textContent   = `Compartment ${selectedComp+1} of ${N} · HX711 Load Cell`;

  document.getElementById('detMetrics').innerHTML = [
    ['CURRENT WEIGHT', c.weight > 0 ? c.weight.toFixed(1) : '--', 'g', c.weight >= cfg.target && c.weight > 0 ? '✓ Harvest ready' : rate.toFixed(2)+'g/day', 'var(--teal)'],
    ['INITIAL WEIGHT',  c.initWeight.toFixed(1), 'g', 'Baseline', 'var(--text)'],
    ['TOTAL GAIN', (gain>=0?'+':'')+gain.toFixed(1), 'g', ((c.initWeight>0?(gain/c.initWeight*100).toFixed(1):0))+'% growth', gain>=0?'var(--teal)':'var(--red)'],
    ['HARVEST ETA', daysToHarvest!==null?(c.weight>=cfg.target?'READY':daysToHarvest):'N/A', daysToHarvest&&c.weight<cfg.target?' days':'', 'Target: '+cfg.target+'g', 'var(--purple)'],
  ].map(([l,v,u,s,col]) =>
    `<div class="met-card"><div class="met-lbl">${l}</div><div class="met-val" style="color:${col}">${v}<span class="met-unit">${u}</span></div><div class="met-sub">${s}</div></div>`
  ).join('');

  renderDetailChart();
  renderWeightLog();
  renderObsLog();
  renderFeedLogDet();

  const now = new Date();
  ['inD','obsD','feedD'].forEach(id => { const el=document.getElementById(id); if(el) el.value=now.toISOString().split('T')[0]; });
  const ti = document.getElementById('inT'); if(ti) ti.value=now.toTimeString().slice(0,5);

  document.getElementById('detAiPrompts').innerHTML = [
    `Why is ${c.id} growing slowly?`,
    `Health check for ${c.id}`,
    `Feed recommendation for ${c.id}`,
    `Is ${c.id} ready to harvest?`,
  ].map(p => `<button class="qp" onclick="askDetAI('${p}')">${p}</button>`).join('');
}

function renderDetailChart() {
  const c   = compartments[selectedComp];
  const ctx = document.getElementById('detChart').getContext('2d');
  if (detChart) detChart.destroy();
  if (c.history.length === 0) {
    // No data yet — draw empty placeholder
    tft_no_data(ctx);
    return;
  }
  detChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: c.history.map(h => h.date.slice(5)),
      datasets: [
        { label:'Weight (g)', data:c.history.map(h=>h.weight), borderColor:'#00D4AA', backgroundColor:'rgba(0,212,170,.07)', fill:true, tension:.35, pointRadius:3, pointBackgroundColor:'#00D4AA', pointBorderColor:'#0A1628', pointBorderWidth:2, borderWidth:2 },
        { label:'Target', data:c.history.map(()=>cfg.target), borderColor:'rgba(168,85,247,.5)', borderDash:[5,5], borderWidth:1, pointRadius:0, fill:false },
      ]
    },
    options: chartOpts('g'),
  });
}

function tft_no_data(ctx) {
  // Draw "no data yet" placeholder
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = 'rgba(74,112,144,0.3)';
  ctx.font = '14px Courier New';
  ctx.textAlign = 'center';
  ctx.fillText('No weight data yet — waiting for ESP32 data', ctx.canvas.width/2, ctx.canvas.height/2);
}

function chartOpts(unit='') {
  return {
    responsive:true, maintainAspectRatio:false,
    plugins:{
      legend:{labels:{color:'#4A7090',font:{size:10,family:'Courier New'},boxWidth:12}},
      tooltip:{backgroundColor:'#0F1E38',borderColor:'rgba(0,212,170,.3)',borderWidth:1,titleColor:'#8BAFC4',bodyColor:'#E8F4F1'},
    },
    scales:{
      x:{ticks:{color:'#4A7090',font:{size:10,family:'Courier New'},maxRotation:30},grid:{color:'rgba(255,255,255,.04)'}},
      y:{ticks:{color:'#4A7090',font:{size:10,family:'Courier New'},callback:v=>v+unit},grid:{color:'rgba(255,255,255,.04)'}},
    },
  };
}

function renderWeightLog() {
  const c = compartments[selectedComp];
  const sorted = [...c.history].reverse();
  document.getElementById('weightLog').innerHTML = sorted.map((h,i)=>{
    const prev = sorted[i+1];
    const diff = prev ? h.weight - prev.weight : null;
    return `<tr>
      <td class="td-m">${h.date}</td><td class="td-m">${h.time||'—'}</td>
      <td class="td-m">${h.weight.toFixed(1)}g</td>
      <td>${diff!==null?`<span style="color:${diff>=0?'var(--teal)':'var(--red)'}">${diff>=0?'+':''}${diff.toFixed(1)}g</span>`:'—'}</td>
      <td style="color:var(--text3)">${h.note||''}</td>
      <td><button onclick="delWeight(${c.history.length-1-i})" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px">✕</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="color:var(--text3);text-align:center;padding:16px">No entries yet</td></tr>';
}

function renderObsLog() {
  const c = compartments[selectedComp];
  document.getElementById('obsLog').innerHTML = (c.obsLog||[]).slice().reverse().map((o,i) =>
    `<tr><td class="td-m">${o.date}</td><td style="color:var(--teal)">${o.type}</td><td style="color:var(--text2)">${o.note}</td>
    <td><button onclick="delObs(${c.obsLog.length-1-i})" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px">✕</button></td></tr>`
  ).join('') || '<tr><td colspan="4" style="color:var(--text3);text-align:center;padding:16px">No observations</td></tr>';
}

function renderFeedLogDet() {
  const c = compartments[selectedComp];
  document.getElementById('feedLog').innerHTML = (c.feedLog||[]).slice().reverse().map((f,i) =>
    `<tr><td class="td-m">${f.date}</td><td style="color:var(--amber)">${f.type}</td><td class="td-m">${f.amount}g</td><td style="color:var(--text3)">${f.note||''}</td>
    <td><button onclick="delFeed(${c.feedLog.length-1-i})" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px">✕</button></td></tr>`
  ).join('') || '<tr><td colspan="5" style="color:var(--text3);text-align:center;padding:16px">No feeding records</td></tr>';
}

function prevComp() { selectedComp=(selectedComp-1+N)%N; renderDetail(); renderSidebar(); }
function nextComp() { selectedComp=(selectedComp+1)%N; renderDetail(); renderSidebar(); }

function switchTab(el, id) {
  el.closest('.tabs').querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById(id).classList.add('active');
}

function logWeight() {
  const w = parseFloat(document.getElementById('inW').value);
  if (!w || isNaN(w)) { showToast('Enter a valid weight','warn'); return; }
  const c = compartments[selectedComp];
  const entry = { date:document.getElementById('inD').value, time:document.getElementById('inT').value, weight:w, note:document.getElementById('inN').value, source:'manual' };
  // If no initWeight yet, set it now
  if (c.initWeight === 0) c.initWeight = w;
  c.history.push(entry);
  c.history.sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time));
  c.weight = w; updateStatus(c); saveComps();
  document.getElementById('inW').value=''; document.getElementById('inN').value='';
  renderDetail(); renderSidebar();
  queueSync('weight', {compId:c.id, weight:w, note:entry.note, date:entry.date+'T'+(entry.time||'00:00'), source:'manual'});
  showToast(`Logged ${w}g for ${c.id}`);
}

function logObs() {
  const note = document.getElementById('obsNote').value.trim();
  if (!note) { showToast('Enter a note','warn'); return; }
  const c = compartments[selectedComp];
  if (!c.obsLog) c.obsLog=[];
  const type = document.getElementById('obsType').value, date = document.getElementById('obsD').value;
  c.obsLog.push({date,type,note});
  saveComps(); document.getElementById('obsNote').value='';
  renderObsLog();
  queueSync('obs', {compId:c.id, type, note, date});
  showToast('Observation logged');
}

function logFeed() {
  const amt = parseFloat(document.getElementById('feedAmt').value);
  if (!amt || isNaN(amt)) { showToast('Enter amount','warn'); return; }
  const c = compartments[selectedComp];
  if (!c.feedLog) c.feedLog=[];
  const date=document.getElementById('feedD').value, type=document.getElementById('feedType').value, note=document.getElementById('feedNote').value;
  c.feedLog.push({date,type,amount:amt,note});
  saveComps(); document.getElementById('feedAmt').value=''; document.getElementById('feedNote').value='';
  renderFeedLogDet();
  queueSync('feed', {compId:c.id, type, amount:amt, note, date, source:'dashboard'});
  showToast(`Feed logged for ${c.id}`);
}

function delWeight(i) { compartments[selectedComp].history.splice(i,1); saveComps(); renderDetail(); }
function delObs(i)    { compartments[selectedComp].obsLog.splice(i,1);   saveComps(); renderObsLog(); }
function delFeed(i)   { compartments[selectedComp].feedLog.splice(i,1);  saveComps(); renderFeedLogDet(); }

function updateStatus(c) {
  if (c.weight === 0) { c.status='ok'; return; }
  c.status = c.weight < thresholds.wtAlert ? 'alert' : c.weight < thresholds.wtWarn ? 'warn' : 'ok';
}

// ══════════════════════════════════════════════════════════
// ANALYTICS
// ══════════════════════════════════════════════════════════
function renderAnalytics() {
  const days  = parseInt(document.getElementById('analyticsDays').value);
  const today = new Date();
  const labels = Array.from({length:days},(_,i)=>{ const d=new Date(today); d.setDate(d.getDate()-(days-1-i)); return d.toISOString().split('T')[0].slice(5); });

  const wDs = compartments.map((c,i) => ({
    label:c.id,
    data:labels.map((_,j)=>{
      const d=new Date(today); d.setDate(d.getDate()-(days-1-j));
      const ds=d.toISOString().split('T')[0];
      const h=c.history.filter(x=>x.date<=ds);
      return h.length?h[h.length-1].weight:null;
    }),
    borderColor:COLORS[i],backgroundColor:'transparent',tension:.3,pointRadius:2,borderWidth:1.5,
  }));
  mkChart('chartAllWeight',{type:'line',data:{labels,datasets:wDs},options:chartOpts('g')});

  const rates = compartments.map(c=>{
    if(c.history.length<2) return 0;
    const recent=c.history.filter(h=>{const d=new Date(h.date);const cut=new Date(today);cut.setDate(cut.getDate()-days);return d>=cut;});
    if(recent.length<2) return 0;
    return parseFloat(((recent[recent.length-1].weight-recent[0].weight)/Math.max(1,recent.length-1)).toFixed(2));
  });
  mkChart('chartGrowth',{type:'bar',data:{labels:compartments.map(c=>c.id),datasets:[{label:'g/day',data:rates,backgroundColor:rates.map(r=>r>0?'rgba(0,212,170,0.7)':'rgba(239,68,68,0.7)'),borderRadius:4}]},options:chartOpts('g/d')});

  const phH = sensorHistory.slice(-days*4);
  if (phH.length > 1) {
    mkChart('chartPh',{type:'line',data:{
      labels:phH.map(h=>h.time.slice(5,-3)),
      datasets:[
        {label:'pH',data:phH.map(h=>h.ph),borderColor:'#00D4AA',backgroundColor:'rgba(0,212,170,.06)',fill:true,tension:.3,pointRadius:0,borderWidth:1.5},
        {label:'Min',data:phH.map(()=>thresholds.phMin),borderColor:'rgba(245,158,11,.4)',borderDash:[4,4],borderWidth:1,pointRadius:0,fill:false},
        {label:'Max',data:phH.map(()=>thresholds.phMax),borderColor:'rgba(239,68,68,.4)',borderDash:[4,4],borderWidth:1,pointRadius:0,fill:false},
      ]
    },options:chartOpts('')});

    mkChart('chartSalTemp',{type:'line',data:{
      labels:phH.map(h=>h.time.slice(5,-3)),
      datasets:[
        {label:'Salinity (ppt)',data:phH.map(h=>h.sal),borderColor:'#3B82F6',backgroundColor:'transparent',tension:.3,pointRadius:0,borderWidth:1.5,yAxisID:'y'},
        {label:'Temp (°C)',data:phH.map(h=>h.tmp),borderColor:'#F59E0B',backgroundColor:'transparent',tension:.3,pointRadius:0,borderWidth:1.5,yAxisID:'y1'},
      ]
    },options:{...chartOpts(),...{scales:{x:{ticks:{color:'#4A7090',font:{size:10,family:'Courier New'},maxRotation:30},grid:{color:'rgba(255,255,255,.04)'}},y:{ticks:{color:'#3B82F6',font:{size:10,family:'Courier New'}},grid:{color:'rgba(255,255,255,.04)'}},y1:{position:'right',ticks:{color:'#F59E0B',font:{size:10,family:'Courier New'}},grid:{drawOnChartArea:false}}}}}});
  }

  document.getElementById('harvestTable').innerHTML =
    `<table class="tbl"><thead><tr><th>ID</th><th>CURRENT</th><th>INITIAL</th><th>GAIN</th><th>RATE</th><th>DAYS</th><th>ETA</th></tr></thead><tbody>` +
    compartments.map(c=>{
      const gain=c.weight-c.initWeight;
      const recent=c.history.filter(h=>{const d=new Date(h.date);const cut=new Date();cut.setDate(cut.getDate()-7);return d>=cut;});
      const rate=recent.length>1?(recent[recent.length-1].weight-recent[0].weight)/Math.max(1,recent.length-1):0;
      const rem=rate>0?(cfg.target-c.weight)/rate:null;
      const eta=rem!=null&&rem>0?new Date(Date.now()+rem*86400000).toLocaleDateString('en-PH'):'—';
      const ready=c.weight>=cfg.target&&c.weight>0;
      return `<tr>
        <td class="td-m">${c.id}</td>
        <td class="td-m">${c.weight>0?c.weight.toFixed(1)+'g':'--'}</td>
        <td>${c.initWeight>0?c.initWeight.toFixed(1)+'g':'--'}</td>
        <td style="color:${gain>=0?'var(--teal)':'var(--red)'}">${c.weight>0?(gain>=0?'+':'')+gain.toFixed(1)+'g':'--'}</td>
        <td class="td-m">${rate.toFixed(2)}</td>
        <td style="color:${ready?'var(--teal)':'var(--purple)'}">${ready?'✓ READY':rem!=null&&rem>0?Math.ceil(rem):'—'}</td>
        <td style="color:var(--text3)">${ready?'Now':eta}</td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

function mkChart(id, cfg_) {
  if (charts[id]) charts[id].destroy();
  const el = document.getElementById(id);
  if (el) charts[id] = new Chart(el.getContext('2d'), cfg_);
}

// ══════════════════════════════════════════════════════════
// FEEDING PAGE
// ══════════════════════════════════════════════════════════
function renderFeedingPage() {
  const today = new Date();
  const DAYS  = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  document.getElementById('feedWeek').innerHTML = Array.from({length:7},(_,i)=>{
    const d=new Date(today); d.setDate(d.getDate()-(6-i));
    const ds=d.toISOString().split('T')[0];
    const n=compartments.filter(c=>(c.feedLog||[]).some(f=>f.date===ds)).length;
    const cls=n===N?'fed':n>0?'partial':i===6?'upcoming':'missed';
    return `<div class="feed-day"><div class="feed-day-lbl">${DAYS[d.getDay()]}</div>
      ${Array.from({length:Math.min(N,10)},(_,j)=>`<div class="feed-dot ${j<n?cls:'upcoming'}"></div>`).join('')}
      <div style="font-size:9px;color:var(--text3);margin-top:4px">${n}/${N}</div>
    </div>`;
  }).join('');
  document.getElementById('bFeedD').value = today.toISOString().split('T')[0];
  const all=[];
  compartments.forEach(c=>(c.feedLog||[]).forEach(f=>all.push({...f,cid:c.id})));
  all.sort((a,b)=>b.date.localeCompare(a.date));
  document.getElementById('allFeedLog').innerHTML = all.slice(0,30).map(f=>
    `<tr><td class="td-m">${f.date}</td><td style="color:var(--teal)">${f.cid}</td><td style="color:var(--amber)">${f.type}</td><td class="td-m">${f.amount}g</td><td style="color:var(--text3)">${f.note||''}</td></tr>`
  ).join('') || '<tr><td colspan="5" style="color:var(--text3);text-align:center;padding:16px">No feeding records yet</td></tr>';
}

function bulkFeed() {
  const amt = parseFloat(document.getElementById('bFeedAmt').value);
  if (!amt || isNaN(amt)) { showToast('Enter amount','warn'); return; }
  const date=document.getElementById('bFeedD').value, type=document.getElementById('bFeedType').value, note=document.getElementById('bFeedNote').value;
  compartments.forEach(c=>{
    if(!c.feedLog) c.feedLog=[];
    c.feedLog.push({date,type,amount:amt,note});
    queueSync('feed', {compId:c.id, type, amount:amt, note, date, source:'dashboard-bulk'});
  });
  saveComps(); renderFeedingPage(); showToast(`Logged for all ${N} compartments`);
}

// ══════════════════════════════════════════════════════════
// ALERTS
// ══════════════════════════════════════════════════════════
// Hours since a compartment's most recent feed log entry (null = never fed)
function hoursSinceFed(c){
  if(!c.feedLog || !c.feedLog.length) return null;
  const last = c.feedLog[c.feedLog.length-1];
  const t = new Date(last.date+'T12:00:00'); // feed entries only store a date, assume midday
  if(isNaN(t)) return null;
  return (Date.now()-t.getTime())/3600000;
}

// Example feeding-alert text, exactly what shows up in Active Alerts /
// alert history / browser notifications when a compartment is overdue:
//   "🍤 Feeding Reminder — C04 (Mud Crab #4) hasn't been fed in 26h. Recommended ration: 6g (5% body weight)."
//   "🚨 Feeding Alert — C07 (Mud Crab #7) hasn't been fed in 51h! Feed now to prevent weight loss or stress."
function feedingAlertText(c, hrs, level){
  if(hrs===null) return `🍤 Feeding Reminder — ${c.id} (${c.name}) has no feeding record yet. Log a feeding to start tracking.`;
  const ration = c.weight>0 ? (c.weight*0.05).toFixed(0)+'g (5% body weight)' : 'a normal ration';
  if(level==='alert') return `🚨 Feeding Alert — ${c.id} (${c.name}) hasn't been fed in ${Math.round(hrs)}h! Feed now to prevent weight loss or stress.`;
  return `🍤 Feeding Reminder — ${c.id} (${c.name}) hasn't been fed in ${Math.round(hrs)}h. Recommended ration: ${ration}.`;
}

function checkAlerts() {
  const triggered = [];
  const {ph,salinity:sal,temperature:tmp} = sensors;
  if (ph>0 && (ph<thresholds.phMin||ph>thresholds.phMax))   triggered.push({sensor:'pH',val:ph.toFixed(2),th:`${thresholds.phMin}–${thresholds.phMax}`,level:'alert'});
  if (sal>0 && (sal<thresholds.salMin||sal>thresholds.salMax)) triggered.push({sensor:'Salinity',val:sal.toFixed(1)+'ppt',th:`${thresholds.salMin}–${thresholds.salMax}ppt`,level:'alert'});
  if (tmp>0 && (tmp<thresholds.tmpMin||tmp>thresholds.tmpMax)) triggered.push({sensor:'Temp',val:tmp.toFixed(1)+'°C',th:`${thresholds.tmpMin}–${thresholds.tmpMax}°C`,level:'warn'});
  compartments.forEach(c=>{
    if(c.weight>0&&c.weight<thresholds.wtAlert) triggered.push({sensor:c.id+' Weight',val:c.weight.toFixed(1)+'g',th:'<'+thresholds.wtAlert+'g',level:'alert'});
    else if(c.weight>0&&c.weight<thresholds.wtWarn) triggered.push({sensor:c.id+' Weight',val:c.weight.toFixed(1)+'g',th:'<'+thresholds.wtWarn+'g',level:'warn'});
    // ── Feeding alert ──
    const hrs = hoursSinceFed(c);
    if(hrs!==null && hrs>=thresholds.feedAlert) triggered.push({sensor:c.id+' Feeding',val:Math.round(hrs)+'h since fed',th:'<'+thresholds.feedAlert+'h',level:'alert',msg:feedingAlertText(c,hrs,'alert')});
    else if(hrs!==null && hrs>=thresholds.feedWarn) triggered.push({sensor:c.id+' Feeding',val:Math.round(hrs)+'h since fed',th:'<'+thresholds.feedWarn+'h',level:'warn',msg:feedingAlertText(c,hrs,'warn')});
  });
  document.getElementById('bellDot').className='bell-dot'+(triggered.length?' show':'');
  if(triggered.length&&document.getElementById('soundAlerts')?.checked){
    try{const ac=new AudioContext();const o=ac.createOscillator();const g=ac.createGain();o.connect(g);g.connect(ac.destination);o.frequency.value=880;g.gain.setValueAtTime(.2,ac.currentTime);g.gain.exponentialRampToValueAtTime(.001,ac.currentTime+.3);o.start();o.stop(ac.currentTime+.3);}catch(e){}
  }
  notifyNewAlerts(triggered);
  const now=new Date().toLocaleString('en-PH');
  triggered.forEach(a=>{alertLog.unshift({...a,time:now});});
  alertLog=alertLog.slice(0,50);
  localStorage.setItem('alertLog',JSON.stringify(alertLog));
  return triggered;
}

// ── Browser notifications — fires once per newly-triggered alert (not every poll) ──
let notifiedKeys = new Set();
function notifyNewAlerts(triggered){
  const keys = new Set(triggered.map(a=>a.sensor+'|'+a.level));
  const isNew = k => !notifiedKeys.has(k);
  if('Notification' in window && localStorage.getItem('browser_notifs')==='on' && Notification.permission==='granted'){
    triggered.forEach(a=>{
      const k=a.sensor+'|'+a.level;
      if(isNew(k)){
        try{
          new Notification(a.level==='alert' ? '🚨 CrabTrack Alert' : '⏰ CrabTrack Reminder', {
            body: a.msg || `${a.sensor}: ${a.val} (limit ${a.th})`,
            tag: k, // replaces any previous notification for the same alert instead of stacking
          });
        }catch(e){}
      }
    });
  }
  notifiedKeys = keys; // reset so alerts that clear can re-notify if they trigger again later
}

async function enableBrowserNotifs(checkbox){
  if(!('Notification' in window)){ showToast('Browser notifications not supported here','warn'); checkbox.checked=false; return; }
  if(checkbox.checked){
    const perm = await Notification.requestPermission();
    if(perm!=='granted'){ showToast('Notifications blocked in browser settings','warn'); checkbox.checked=false; localStorage.setItem('browser_notifs','off'); return; }
    localStorage.setItem('browser_notifs','on');
    showToast('Browser notifications enabled');
    new Notification('🦀 CrabTrack', {body:'Notifications are on — you\'ll be alerted here for water, weight and feeding alerts.'});
  } else {
    localStorage.setItem('browser_notifs','off');
    showToast('Browser notifications disabled');
  }
}

function renderAlertsPage() {
  const active=checkAlerts();
  document.getElementById('activeAlerts').innerHTML=active.length?active.map(a=>`
    <div class="alert-item ${a.level}-alert">
      <div class="ai-icon" style="background:${a.level==='alert'?'var(--red-dim)':'var(--amber-dim)'}">${a.level==='alert'?'🚨':'⚠️'}</div>
      <div><div class="ai-title">${a.sensor}</div><div class="ai-sub">${a.msg ? a.msg : `Value: ${a.val} | Limit: ${a.th}`}</div></div>
      <div class="ai-time">${new Date().toLocaleTimeString()}</div>
    </div>`).join(''):'<div style="color:var(--teal);font-size:12px;padding:16px;text-align:center">✓ All parameters within thresholds</div>';
  ['thPhMin','thPhMax','thSalMin','thSalMax','thTmpMin','thTmpMax','thWtAlert','thWtWarn','thFeedWarn','thFeedAlert'].forEach((id,i)=>{
    const el=document.getElementById(id);
    if(el) el.value=[thresholds.phMin,thresholds.phMax,thresholds.salMin,thresholds.salMax,thresholds.tmpMin,thresholds.tmpMax,thresholds.wtAlert,thresholds.wtWarn,thresholds.feedWarn,thresholds.feedAlert][i];
  });
  const notifCb = document.getElementById('browserNotifs');
  if(notifCb) notifCb.checked = localStorage.getItem('browser_notifs')==='on' && Notification.permission==='granted';
  document.getElementById('alertHistory').innerHTML=alertLog.slice(0,20).map(a=>
    `<tr><td class="td-m" style="font-size:10px">${a.time}</td><td>${a.sensor}</td><td class="td-m">${a.val}</td><td style="color:var(--text3)">${a.th}</td>
    <td><span style="font-size:9px;padding:2px 6px;border-radius:8px;background:${a.level==='alert'?'var(--red-dim)':'var(--amber-dim)'};color:${a.level==='alert'?'var(--red)':'var(--amber)'}">${a.level.toUpperCase()}</span></td></tr>`
  ).join('')||'<tr><td colspan="5" style="color:var(--text3);text-align:center;padding:16px">No alerts yet</td></tr>';
}

function saveThresholds(){
  const map={phMin:'thPhMin',phMax:'thPhMax',salMin:'thSalMin',salMax:'thSalMax',tmpMin:'thTmpMin',tmpMax:'thTmpMax',wtAlert:'thWtAlert',wtWarn:'thWtWarn',feedWarn:'thFeedWarn',feedAlert:'thFeedAlert'};
  const next={};
  for(const [key,id] of Object.entries(map)){
    const el=document.getElementById(id);
    if(!el) continue;
    const value=Number(el.value);
    if(el.value.trim()==='' || !Number.isFinite(value)){
      el.focus(); showToast('Please enter a valid number for every threshold','warn'); return;
    }
    next[key]=value;
  }
  if(next.phMin>=next.phMax || next.salMin>=next.salMax || next.tmpMin>=next.tmpMax || next.wtAlert>=next.wtWarn || next.feedWarn>=next.feedAlert){
    showToast('Check limits: each minimum/alert value must be lower than its maximum/warning value','warn'); return;
  }
  Object.entries(next).forEach(([key,value])=>{
    thresholds[key]=value;
    localStorage.setItem('th_'+key,String(value));
  });
  // Persist the whole configuration as well, so reloads can restore one consistent set.
  localStorage.setItem('crabtrack_thresholds',JSON.stringify(next));
  compartments.forEach(c=>updateStatus(c));
  saveComps();
  // Refresh active alerts immediately using the newly saved limits.
  const active=checkAlerts();
  const activeEl=document.getElementById('activeAlerts');
  if(activeEl) activeEl.innerHTML=active.length?active.map(a=>`<div class="alert-item ${a.level}-alert"><div class="ai-icon">${a.level==='alert'?'🚨':'⚠️'}</div><div><div class="ai-title">${a.sensor}</div><div class="ai-sub">${a.msg || `Value: ${a.val} | Limit: ${a.th}`}</div></div><div class="ai-time">${new Date().toLocaleTimeString()}</div></div>`).join(''):'<div style="color:var(--teal);font-size:12px;padding:16px;text-align:center">✓ All parameters within thresholds</div>';
  showToast('Thresholds saved and applied');
}

// ══════════════════════════════════════════════════════════
// AI ASSISTANT
// ══════════════════════════════════════════════════════════
function renderAIPage(){
  document.getElementById('globalAiPrompts').innerHTML=[
    'Overall system health check','Which crab is growing fastest?',
    'Which crab needs attention?','Optimal feeding schedule',
    'Water quality analysis','Harvest readiness report',
  ].map(p=>`<button class="qp" onclick="askGlobalAI('${p}')">${p}</button>`).join('');
  if(!document.getElementById('globalAiChat').innerHTML)
    appendMsg('globalAiChat','ai',"Hello! I'm your AI crab health assistant. I have access to all your sensor readings. Ask me anything!");
}

function buildSystemContext(){
  const gains=compartments.map(c=>c.weight-c.initWeight);
  const rates=compartments.map(c=>{
    const r=c.history.filter(h=>{const d=new Date(h.date);const cut=new Date();cut.setDate(cut.getDate()-7);return d>=cut;});
    return r.length>1?((r[r.length-1].weight-r[0].weight)/Math.max(1,r.length-1)).toFixed(2):0;
  });
  return `You are an expert AI for a mud crab fattening system in the Philippines. Give practical advice.
SENSORS: pH=${sensors.ph.toFixed(2)} (opt 7.5–8.5), Salinity=${sensors.salinity.toFixed(1)}ppt (opt 10–25), Temp=${sensors.temperature.toFixed(1)}°C (opt 25–30)
COMPARTMENTS (target ${cfg.target}g):
${compartments.map((c,i)=>`${c.id}: ${c.weight.toFixed(1)}g current, ${c.initWeight.toFixed(1)}g initial, +${gains[i].toFixed(1)}g gain, ${rates[i]}g/day, ${c.status}`).join('\n')}
Note: if weights show 0.0g, the ESP32 has not yet connected or Firebase is not configured.`;
}

async function callClaude(system, messages){
  if(!cfg.apiKey) return '⚠️ No API key — go to ⚙ Config and enter your Anthropic API key.';
  try{
    const res=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':cfg.apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:800,system,messages}),
    });
    const data=await res.json();
    if(data.error) return '⚠️ '+data.error.message;
    return data.content[0].text;
  }catch(e){return '⚠️ Connection error: '+e.message;}
}

async function sendGlobalAI(){
  const inp=document.getElementById('globalAiInput');
  const text=inp.value.trim();if(!text)return;
  inp.value='';
  appendMsg('globalAiChat','user',text);
  globalChatHistory.push({role:'user',content:text});
  const t=appendMsg('globalAiChat','ai','Analyzing…',true);
  const reply=await callClaude(buildSystemContext(),globalChatHistory);
  t.remove();appendMsg('globalAiChat','ai',reply);
  globalChatHistory.push({role:'assistant',content:reply});
}
async function askGlobalAI(p){document.getElementById('globalAiInput').value=p;await sendGlobalAI();}

async function sendDetAI(){
  const inp=document.getElementById('detAiInput');
  const text=inp.value.trim();if(!text)return;
  inp.value='';
  const c=compartments[selectedComp];
  appendMsg('detAiChat','user',text);
  detChatHistory.push({role:'user',content:text});
  const t=appendMsg('detAiChat','ai','Analyzing '+c.id+'…',true);
  const ctx=buildSystemContext()+`\nFOCUS: ${c.id} - recent: ${c.history.slice(-7).map(h=>h.date.slice(5)+':'+h.weight+'g').join(', ')||'no data'}`;
  const reply=await callClaude(ctx,detChatHistory);
  t.remove();appendMsg('detAiChat','ai',reply);
  detChatHistory.push({role:'assistant',content:reply});
}
async function askDetAI(p){document.getElementById('detAiInput').value=p;await sendDetAI();}

function appendMsg(cid,role,text,typing=false){
  const el=document.getElementById(cid);
  const div=document.createElement('div');
  div.className='msg '+role+(typing?' typing':'');
  if(role==='ai')div.innerHTML=`<div class="msg-lbl">CARL AI</div>${text.replace(/\n/g,'<br>')}`;
  else div.textContent=text;
  el.appendChild(div);el.scrollTop=el.scrollHeight;
  return div;
}

// ══════════════════════════════════════════════════════════
// REPORTS
// ══════════════════════════════════════════════════════════
function renderReports(){
  const today=new Date().toLocaleDateString('en-PH',{year:'numeric',month:'long',day:'numeric'});
  const weights=compartments.map(c=>c.weight);
  const gains=compartments.map(c=>c.weight-c.initWeight);
  const ready=compartments.filter(c=>c.weight>=cfg.target&&c.weight>0).length;
  document.getElementById('reportContent').innerHTML=`
  <div class="panel"><div class="panel-title">SYSTEM SUMMARY — ${today}</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">
      ${[['Total Compartments','10'],['Ready to Harvest',ready+' crabs'],['Avg Weight',(weights.reduce((a,b)=>a+b,0)/N).toFixed(1)+'g'],
         ['Total Biomass',(weights.reduce((a,b)=>a+b,0)/1000).toFixed(2)+'kg'],['Avg Gain',(gains.reduce((a,b)=>a+b,0)/N).toFixed(1)+'g'],
         ['pH / Sal / Temp',sensors.ph.toFixed(1)+' / '+sensors.salinity.toFixed(1)+'ppt / '+sensors.temperature.toFixed(1)+'°C']
      ].map(([l,v])=>`<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--rs);padding:10px"><div style="font-size:9px;color:var(--text3)">${l}</div><div style="font-size:16px;font-weight:bold;margin-top:4px">${v}</div></div>`).join('')}
    </div>
  </div>
  <div class="panel"><div class="panel-title">COMPARTMENT STATUS</div>
    <table class="tbl"><thead><tr><th>ID</th><th>NAME</th><th>CURRENT</th><th>INITIAL</th><th>GAIN</th><th>STATUS</th><th>HARVEST</th></tr></thead><tbody>
    ${compartments.map(c=>{
      const gain=c.weight-c.initWeight;
      const rate=c.history.length>2?(c.weight-c.history[Math.max(0,c.history.length-8)].weight)/Math.min(7,c.history.length-1):0;
      const rem=rate>0?Math.ceil((cfg.target-c.weight)/rate):null;
      return `<tr><td class="td-m">${c.id}</td><td>${c.name}</td>
        <td class="td-m">${c.weight>0?c.weight.toFixed(1)+'g':'--'}</td>
        <td>${c.initWeight>0?c.initWeight.toFixed(1)+'g':'--'}</td>
        <td style="color:${gain>=0?'var(--teal)':'var(--red)'}">${c.weight>0?(gain>=0?'+':'')+gain.toFixed(1)+'g':'--'}</td>
        <td><span style="font-size:9px;padding:2px 6px;border-radius:8px;background:${c.status==='ok'?'var(--teal-dim)':c.status==='warn'?'var(--amber-dim)':'var(--red-dim)'};color:${c.status==='ok'?'var(--teal)':c.status==='warn'?'var(--amber)':'var(--red)'}">${c.status.toUpperCase()}</span></td>
        <td style="color:var(--purple)">${c.weight>=cfg.target&&c.weight>0?'✓ READY':rem?rem+' days':'—'}</td></tr>`;
    }).join('')}
    </tbody></table>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// RASPBERRY PI API POLLING  — primary source, works fully offline
// (i.e. with no internet — only the local Wi-Fi network the Pi is on)
// ══════════════════════════════════════════════════════════
async function fetchPiAPI(){
  const base = (cfg.piApi || '').replace(/\/+$/, '');
  if(!base) { if(!cfg.fbUrl && !cfg.esp) setConnBadge('offline'); return; }
  try {
    const res = await fetch(base + '/api/data', {cache:'no-store', signal:AbortSignal.timeout(5000)});
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    if(!data || typeof data !== 'object') throw new Error('Invalid API response');
    ingestData(data, 'raspberry-pi');
    lastFbData = new Date();
    setConnBadge('online');
    updateFbStatus('✅ Connected to Raspberry Pi — data received', true);
    // Pi is reachable, so its /api endpoints almost certainly are too —
    // flush anything logged while we were offline.
    syncOfflineQueue();
  } catch(e) {
    // Pi unreachable: keep showing the last cached reading (already in
    // localStorage/compartments) instead of blanking the dashboard, and
    // let the sync queue keep collecting new entries until it's back.
    setConnBadge('offline');
    updateFbStatus('Pi API error: '+e.message, false);
    console.warn('[CrabTrack] Pi API unreachable — running offline on cached data:', e.message);
  }
}

// ══════════════════════════════════════════════════════════
// OFFLINE SYNC QUEUE
// ══════════════════════════════════════════════════════════
// The dashboard is offline-first: every log action already saves straight
// to localStorage (via saveComps) so nothing is ever lost or blocked by a
// missing connection. This queue is the extra step that pushes those same
// entries into the Raspberry Pi's SQLite database once it's reachable, so
// the Pi keeps a durable record even if this browser tab is later closed.
let syncQueue = JSON.parse(localStorage.getItem('syncQueue') || '[]');

function queueSync(type, payload){
  syncQueue.push({ id: Date.now()+'_'+Math.random().toString(36).slice(2), type, payload, queuedAt: new Date().toISOString() });
  localStorage.setItem('syncQueue', JSON.stringify(syncQueue));
  updateSyncBadge();
  // Try immediately — if the Pi is online this clears right away, if not
  // it just stays queued until the next successful poll or reconnect.
  syncOfflineQueue();
}

async function syncOfflineQueue(manual){
  if(!syncQueue.length){ if(manual) showToast('Nothing to sync'); updateSyncBadge(); return; }
  const base = (cfg.piApi || '').replace(/\/+$/, '');
  if(!base){ if(manual) showToast('Set a Raspberry Pi API URL in ⚙ Config first','warn'); return; }
  const endpoint = { feed:'/api/feed', weight:'/api/weight', obs:'/api/obs' };
  const remaining = [];
  for(const item of syncQueue){
    try{
      const res = await fetch(base + (endpoint[item.type]||'/api/feed'), {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(item.payload), signal: AbortSignal.timeout(5000)
      });
      if(!res.ok) throw new Error('HTTP '+res.status);
      // synced — drop it from the queue
    }catch(e){
      remaining.push(item); // Pi still unreachable (or rejected it) — keep for next try
    }
  }
  const synced = syncQueue.length - remaining.length;
  syncQueue = remaining;
  localStorage.setItem('syncQueue', JSON.stringify(syncQueue));
  updateSyncBadge();
  if(manual) showToast(synced ? `Synced ${synced} item(s) to Raspberry Pi` : 'Raspberry Pi unreachable — still queued', synced?'ok':'warn');
}

function updateSyncBadge(){
  const b = document.getElementById('syncBadge');
  if(!b) return;
  if(syncQueue.length){ b.style.display=''; b.textContent = `⇅ ${syncQueue.length} PENDING`; }
  else b.style.display='none';
}

// ══════════════════════════════════════════════════════════
// FIREBASE POLLING  — THIS IS THE FIX
// ══════════════════════════════════════════════════════════
async function fetchFirebase(){
  if(!cfg.fbUrl) return;
  const base = cfg.fbUrl.replace(/\/+$/, '');
  // Read the whole crab_monitor tree so we can support:
  //   node1 = pH
  //   node2 = EC + temperature
  //   weights/C01 ... weights/C10 = individual weight nodes
  // and still support the older node3.weights[] format.
  const url = base + '/crab_monitor.json';

  try{
    const res = await fetch(url, {
      cache:'no-store',
      signal: AbortSignal.timeout(6000)
    });

    if(!res.ok)
      throw new Error('HTTP '+res.status+' — check Firebase read rules');

    const raw = await res.json();

    if(!raw || typeof raw !== 'object'){
      setConnBadge('empty');
      updateFbStatus('Waiting for /crab_monitor data...', false);
      return;
    }

    // ──────────────────────────────────────────────────────
    // NODE 1 — pH
    // ──────────────────────────────────────────────────────
    const node1 = raw.node1 || null;

    if(node1 && typeof node1.ph === 'number')
      sensors.ph = node1.ph;
    else if(node1 && typeof node1.pH === 'number')
      sensors.ph = node1.pH;

    // ──────────────────────────────────────────────────────
    // NODE 2 — EC / SALINITY + TEMPERATURE
    // ──────────────────────────────────────────────────────
    const node2 = raw.node2 || null;

    if(node2){
      if(typeof node2.ec === 'number')
        sensors.salinity = node2.ec;
      else if(typeof node2.EC === 'number')
        sensors.salinity = node2.EC;

      if(typeof node2.temperature === 'number')
        sensors.temperature = node2.temperature;
      else if(typeof node2.Temp === 'number')
        sensors.temperature = node2.Temp;
    }

    // ──────────────────────────────────────────────────────
    // WEIGHTS — NEW FORMAT
    //
    // /crab_monitor/weights/C01/weight
    // /crab_monitor/weights/C02/weight
    // ...
    // /crab_monitor/weights/C10/weight
    // ──────────────────────────────────────────────────────
    const weightNodes = raw.weights || null;

    if(weightNodes && typeof weightNodes === 'object'){
      const now = new Date();
      const ds = now.toISOString().split('T')[0];
      const ts = now.toTimeString().slice(0,5);

      for(let i=0; i<N; i++){
        const cid = `C${String(i+1).padStart(2,'0')}`;
        const node = weightNodes[cid];

        if(!node || typeof node !== 'object') continue;

        let w = null;

        // New weight-node Firebase format
        if(typeof node.weight === 'number')
          w = node.weight;
        else if(typeof node.value === 'number')
          w = node.value;

        if(typeof w !== 'number' || !Number.isFinite(w))
          continue;

        const c = compartments[i];

        c.weight = parseFloat(w.toFixed(1));

        if(c.initWeight === 0 && c.weight > 0)
          c.initWeight = c.weight;

        const last = c.history[c.history.length-1];

        if(!last || last.date !== ds){
          c.history.push({
            date: ds,
            time: ts,
            weight: c.weight,
            note: 'firebase auto',
            source: 'firebase'
          });
        }else{
          last.weight = c.weight;
        }

        updateStatus(c);
      }

      saveComps();
    }

    // ──────────────────────────────────────────────────────
    // OLD FORMAT FALLBACK
    // /crab_monitor/node3/weights = [C01,C02,...]
    // ──────────────────────────────────────────────────────
    const node3 = raw.node3 || null;

    if(node3 && Array.isArray(node3.weights)){
      const now = new Date();
      const ds = now.toISOString().split('T')[0];
      const ts = now.toTimeString().slice(0,5);

      node3.weights.forEach((w,i)=>{
        if(i>=N || typeof w !== 'number') return;

        const c = compartments[i];

        c.weight = parseFloat(w.toFixed(1));

        if(c.initWeight === 0 && c.weight > 0)
          c.initWeight = c.weight;

        const last = c.history[c.history.length-1];

        if(!last || last.date !== ds){
          c.history.push({
            date: ds,
            time: ts,
            weight: c.weight,
            note: 'firebase auto',
            source: 'firebase'
          });
        }else{
          last.weight = c.weight;
        }

        updateStatus(c);
      });

      saveComps();
    }

    // ──────────────────────────────────────────────────────
    // SENSOR HISTORY
    // ──────────────────────────────────────────────────────
    sensorHistory.push({
      time:new Date().toISOString(),
      ph:sensors.ph,
      sal:sensors.salinity,
      tmp:sensors.temperature
    });

    sensorHistory = sensorHistory.slice(-200);

    localStorage.setItem(
      'sensorHistory',
      JSON.stringify(sensorHistory)
    );

    lastFbData = new Date();

    setConnBadge('online');

    const fbBadge = document.getElementById('fbBadge');
    if(fbBadge) fbBadge.style.display='';

    // Show weight status too when available
    const c01 = compartments[0];
    const c01Text = c01 && c01.weight > 0
      ? ` C01:${c01.weight.toFixed(1)}g`
      : '';

    updateFbStatus(
      `✅ pH:${sensors.ph.toFixed(2)} Sal:${sensors.salinity.toFixed(1)} Temp:${sensors.temperature.toFixed(1)}${c01Text}`,
      true
    );

    // Refresh UI
    const active =
      document.querySelector('.page.active')?.id;

    if(active === 'pageOverview')
      renderOverview();

    if(active === 'pageAnalytics')
      renderAnalytics();

    renderSidebar();
    checkAlerts();

  }catch(e){
    // Do not replace a working Firebase LIVE state with a Pi error.
    setConnBadge('offline');
    updateFbStatus(
      'Error: '+e.message,
      false
    );

    console.error(
      'Firebase error:',
      e
    );
  }
}

async function fetchESP32(){
  if(!cfg.esp) return;
  try{
    const res=await fetch(cfg.esp,{signal:AbortSignal.timeout(4000)});
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data=await res.json();
    ingestData(data,'esp32');
    setConnBadge('online');
  }catch(e){
    if(!cfg.fbUrl) setConnBadge('offline');
  }
}

function ingestData(data, source){
  // Support BOTH formats — Pi format + standard format
     if(typeof data.ph          === 'number') sensors.ph          = data.ph;
        else if(typeof data.pH     === 'number') sensors.ph          = data.pH;

     if(typeof data.salinity    === 'number') sensors.salinity    = data.salinity;
        else if(typeof data.EC     === 'number') sensors.salinity    = data.EC;  // EC → Salinity

     if(typeof data.temperature === 'number') sensors.temperature = data.temperature;
        else if(typeof data.Temp   === 'number') sensors.temperature = data.Temp;
  if(Array.isArray(data.weights)){
    const now = new Date();
    const ds  = now.toISOString().split('T')[0];
    const ts  = now.toTimeString().slice(0,5);
    data.weights.forEach((w,i)=>{
      if(i>=N || typeof w !== 'number') return;
      const c = compartments[i];
      const prev = c.weight;
      c.weight = parseFloat(w.toFixed(1));

      // Set initWeight when first real data arrives
      if(c.initWeight === 0 && c.weight > 0) {
        c.initWeight = c.weight;
      }
      updateStatus(c);

      // Add history entry — one per day max for auto-source
      const last = c.history[c.history.length-1];
      if(!last || last.date !== ds){
        c.history.push({date:ds, time:ts, weight:c.weight, note:source+' auto', source});
      } else {
        last.weight = c.weight;  // update today's entry
      }
    });
    saveComps();
  }

  // Sensor history for charts
  sensorHistory.push({time:new Date().toISOString(), ph:sensors.ph, sal:sensors.salinity, tmp:sensors.temperature});
  sensorHistory = sensorHistory.slice(-200);
  localStorage.setItem('sensorHistory', JSON.stringify(sensorHistory));

  // Refresh current page
  const active = document.querySelector('.page.active')?.id;
  if(active === 'pageOverview')  renderOverview();
  if(active === 'pageAnalytics') renderAnalytics();
  renderSidebar();
  checkAlerts();
}

function updateFbStatus(msg, ok){
  const el = document.getElementById('fbStatusText');
  if(el){ el.textContent=msg; el.style.color=ok?'var(--teal)':'var(--amber)'; }
  const ld = document.getElementById('fbLastData');
  if(ld && ok) ld.textContent = new Date().toLocaleTimeString('en-PH');
}

function setConnBadge(state){
  const b = document.getElementById('connBadge');
  if(!cfg.piApi && !cfg.fbUrl && !cfg.esp){
    b.textContent='⬤ DEMO'; b.className='conn-badge demo'; return;
  }
  switch(state){
    case 'online':  b.textContent='⬤ LIVE';          b.className='conn-badge online'; break;
    case 'offline': b.textContent=cfg.piApi?'⬤ OFFLINE (cached data)':'⬤ RECONNECTING…'; b.className='conn-badge offline'; break;
    case 'empty':   b.textContent='⬤ WAITING DATA';  b.className='conn-badge demo'; break;
    default:        b.textContent='⬤ CONNECTING…';   b.className='conn-badge demo';
  }
}

function startPolling(){
  if(pollTimer) clearInterval(pollTimer);
  if(!cfg.piApi && !cfg.fbUrl && !cfg.esp) return;
  const poll = () => { if(cfg.piApi) fetchPiAPI(); if(cfg.fbUrl) fetchFirebase(); if(cfg.esp) fetchESP32(); };
  poll();
  pollTimer = setInterval(poll, cfg.interval * 1000);
}

function manualRefresh(){
  if(cfg.piApi||cfg.fbUrl||cfg.esp){
    if(cfg.piApi) fetchPiAPI();
    if(cfg.fbUrl) fetchFirebase();
    if(cfg.esp) fetchESP32();
    showToast('Refreshing…');
  }
  else showToast('Enter a Raspberry Pi API URL in ⚙ Config first','warn');
}

// ══════════════════════════════════════════════════════════
// CONFIG MODAL
// ══════════════════════════════════════════════════════════
function openConfig(){
  const piField = document.getElementById('cfgPiApi');
  if(piField) piField.value = cfg.piApi;
  document.getElementById('cfgFbUrl').value  = cfg.fbUrl;
  document.getElementById('cfgFbPath').value = cfg.fbPath;
  document.getElementById('cfgEsp').value    = cfg.esp;
  document.getElementById('cfgApiKey').value = cfg.apiKey;
  document.getElementById('cfgInt').value    = cfg.interval;
  document.getElementById('cfgCalib').value  = cfg.calib;
  document.getElementById('cfgTarget').value = cfg.target;
  // Show current full URL
  const base = cfg.fbUrl.replace(/\/+$/,'');
  const path = cfg.fbPath.startsWith('/')?cfg.fbPath:'/'+cfg.fbPath;
  document.getElementById('fbFullUrl').textContent = cfg.fbUrl ? base+path+'.json' : 'Not configured';
  document.getElementById('cfgOverlay').classList.add('open');
}

function closeConfig(){ document.getElementById('cfgOverlay').classList.remove('open'); }

function saveConfig(){
  const piField = document.getElementById('cfgPiApi');
  if(piField) cfg.piApi = piField.value.trim().replace(/\/+$/,'');
  cfg.fbUrl    = document.getElementById('cfgFbUrl').value.trim().replace(/\/+$/,''); // strip trailing slash
  cfg.fbPath   = document.getElementById('cfgFbPath').value.trim() || '/crab_monitor';
  cfg.esp      = document.getElementById('cfgEsp').value.trim();
  cfg.apiKey   = document.getElementById('cfgApiKey').value.trim();
  cfg.interval = Math.max(1, parseInt(document.getElementById('cfgInt').value)||5);
  cfg.calib    = parseFloat(document.getElementById('cfgCalib').value)||420;
  cfg.target   = parseFloat(document.getElementById('cfgTarget').value)||300;

  localStorage.setItem('pi_api_url', cfg.piApi);
  localStorage.setItem('fb_url',  cfg.fbUrl);
  localStorage.setItem('fb_path', cfg.fbPath);
  localStorage.setItem('esp_url', cfg.esp);
  localStorage.setItem('api_key', cfg.apiKey);
  localStorage.setItem('esp_int', cfg.interval);
  localStorage.setItem('calib',   cfg.calib);
  localStorage.setItem('target',  cfg.target);

  closeConfig();
  setConnBadge('connecting');
  startPolling();
  showToast(cfg.fbUrl ? 'Connecting to Firebase…' : (cfg.piApi ? 'Connecting to Raspberry Pi…' : 'Config saved'));
}

async function testFirebase(){
  const url = document.getElementById('cfgFbUrl').value.trim().replace(/\/+$/,'');
  const path = document.getElementById('cfgFbPath').value.trim() || '/crab_monitor';
  const fullUrl = url + (path.startsWith('/')?path:'/'+path) + '.json';
  document.getElementById('fbFullUrl').textContent = fullUrl;
  if(!url){ showToast('Enter Firebase URL first','warn'); return; }
  showToast('Testing Firebase connection…');
  try{
    const res = await fetch(fullUrl, {signal:AbortSignal.timeout(6000)});
    if(!res.ok) throw new Error('HTTP '+res.status+' — check Firebase rules (read=true)');
    const data = await res.json();
    if(data===null){
      document.getElementById('fbStatusText').textContent='URL OK but no data yet — ESP32 not pushed yet';
      document.getElementById('fbStatusText').style.color='var(--amber)';
      showToast('Firebase URL is valid — no data yet','warn');
    } else {
      document.getElementById('fbStatusText').textContent='✓ Connected — data found!';
      document.getElementById('fbStatusText').style.color='var(--teal)';
      document.getElementById('fbLastData').textContent = new Date().toLocaleTimeString();
      showToast('✓ Firebase connected! Data found.','ok');
    }
  }catch(e){
    document.getElementById('fbStatusText').textContent='✗ Error: '+e.message;
    document.getElementById('fbStatusText').style.color='var(--red)';
    showToast('Firebase error: '+e.message,'err');
  }
}

// ══════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════
function exportCSV(){
  let csv='Compartment,Name,Date,Time,Weight(g),Change(g),Note,Source\n';
  compartments.forEach(c=>c.history.forEach((h,i,arr)=>{
    const prev=arr[i-1];
    csv+=`${c.id},"${c.name}",${h.date},${h.time||''},${h.weight},${prev?(h.weight-prev.weight).toFixed(1):''},"${h.note||''}",${h.source||''}\n`;
  }));
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download=`crab_track_${new Date().toISOString().split('T')[0]}.csv`; a.click();
  showToast('CSV exported');
}

function exportExcel(){
  try{
    const wb=XLSX.utils.book_new();
    const sum=[['CRAB TRACK v2 — REPORT','','','','',''],['Generated:',new Date().toLocaleString(),'','','',''],
      ['pH:',sensors.ph,'Salinity:',sensors.salinity+'ppt','Temp:',sensors.temperature+'°C'],['','','','','',''],
      ['ID','Name','Current(g)','Initial(g)','Gain(g)','Status'],
      ...compartments.map(c=>[c.id,c.name,c.weight,c.initWeight,(c.weight-c.initWeight).toFixed(1),c.status.toUpperCase()])];
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(sum),'Summary');
    const wr=[['Compartment','Name','Date','Time','Weight(g)','Change(g)','Note']];
    compartments.forEach(c=>c.history.forEach((h,i,a)=>{const p=a[i-1];wr.push([c.id,c.name,h.date,h.time||'',h.weight,p?parseFloat((h.weight-p.weight).toFixed(1)):'',h.note||'']);}));
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(wr),'Weight History');
    const fr=[['Compartment','Name','Date','Feed Type','Amount(g)','Note']];
    compartments.forEach(c=>(c.feedLog||[]).forEach(f=>fr.push([c.id,c.name,f.date,f.type,f.amount,f.note||''])));
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(fr),'Feeding Log');
    XLSX.writeFile(wb,`crab_track_${new Date().toISOString().split('T')[0]}.xlsx`);
    showToast('Excel exported');
  }catch(e){showToast('Export failed: '+e.message,'err');}
}

function resetAll(){
  if(!confirm('Reset ALL compartment data? This cannot be undone.')) return;
  ['comps_v2','sensorHistory','alertLog'].forEach(k=>localStorage.removeItem(k));
  compartments=loadCompartments(); sensorHistory=[]; alertLog=[];
  renderOverview(); showToast('Data reset','warn');
}

// ══════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════
let toastTimer;
function showToast(msg,type='ok'){
  const t=document.getElementById('toast');
  t.textContent=msg; t.className=`show t-${type}`;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.className='',2800);
}

// ══════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════
compartments.forEach(c=>updateStatus(c));
renderSidebar();
renderOverview();

// Seed demo sensor history only if no real data
if(!sensorHistory.length){
  const now=new Date();
  for(let i=40;i>=0;i--){
    const d=new Date(now); d.setMinutes(d.getMinutes()-i*30);
    sensorHistory.push({time:d.toISOString(),ph:0,sal:0,tmp:0});
  }
  localStorage.setItem('sensorHistory',JSON.stringify(sensorHistory));
}

if(cfg.piApi || cfg.fbUrl || cfg.esp){
  setConnBadge('connecting');
  startPolling();
} else {
  // No config — show helpful message
  showToast('⚙ Click Config to connect to your Raspberry Pi','warn');
}

updateSyncBadge();
window.addEventListener('online', ()=>{ showToast('Back online — syncing…'); syncOfflineQueue(); });

// Seed one example feeding alert so the format is visible even before any
// real hardware/feeding data exists — see feedingAlertText() for the format.
if(!alertLog.length){
  alertLog.unshift({
    sensor:'C03 Feeding', val:'26h since fed', th:'<24h', level:'warn', time:new Date().toLocaleString('en-PH'),
    msg:'🍤 Feeding Reminder — C03 (Mud Crab #3) hasn\'t been fed in 26h. Recommended ration: 6g (5% body weight). [example]',
  });
  localStorage.setItem('alertLog', JSON.stringify(alertLog));
}
