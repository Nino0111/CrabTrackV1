/* CrabTrack Weight Monitoring add-on.
   Live status is sourced from the Pi node heartbeat (/api/data -> nodes).
   Scheduled captures are read-only from Firebase weight_history.
   This file never writes, synthesizes, or substitutes weight records. */
(function(){
  'use strict';
  const ids=Array.from({length:10},(_,i)=>`C${String(i+1).padStart(2,'0')}`);
  const $=id=>document.getElementById(id);
  const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const validWeight=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=10000;
  const localDate=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  const fmtTime=v=>{
    if(v==null||v==='')return 'Time not stored';
    const d=new Date(v);
    if(!Number.isNaN(d.getTime()))return new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}).format(d);
    return String(v);
  };
  const fmtDate=v=>{
    if(!v)return '—';
    const d=new Date(String(v).length===10?`${v}T12:00:00`:v);
    return Number.isNaN(d.getTime())?String(v):new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',day:'2-digit',month:'short',year:'numeric'}).format(d);
  };
  function renderLiveEmpty(message){
    $('wmLiveGrid').innerHTML=ids.map(c=>`<article class="wm-card"><div class="wm-card-top"><span class="wm-id">${c}</span><span class="wm-pill">UNKNOWN</span></div><div class="wm-weight">—</div><div class="wm-unit">g · no verified live reading</div><div class="wm-meta">${esc(message)}</div></article>`).join('');
  }
  function extractNodeWeight(node){
    const p=node&&node.lastPayload||{};
    let v=p.weight??p.weight_g??p.grams;
    if(!validWeight(v)&&Array.isArray(p.weights))v=p.weights[0];
    return validWeight(v)?Number(v):null;
  }
  function compartmentForNode(n){
    const p=n.lastPayload||{};
    if(/^C(0[1-9]|10)$/.test(p.compartment||''))return p.compartment;
    const m=String(n.nodeId||'').match(/^(?:weight|node)(10|[1-9])$/i);
    if(m)return `C${String(Number(m[1])).padStart(2,'0')}`;
    if(Number.isInteger(p.weight_offset)){
      const arr=Array.isArray(p.weights)?p.weights:[p.weight??p.weight_g];
      if(arr.length===1)return `C${String(p.weight_offset+1).padStart(2,'0')}`;
    }
    return null;
  }
  async function loadLive(){
    const base=(window.cfg&&cfg.piApi||localStorage.getItem('pi_api_url')||'http://crabtrackpi.local:3000').replace(/\/+$/,'');
    try{
      const res=await fetch(base+'/api/data',{cache:'no-store',signal:AbortSignal.timeout(5000)});
      if(!res.ok)throw Error(`Pi API HTTP ${res.status}`);
      const data=await res.json();
      const live={};
      (Array.isArray(data.nodes)?data.nodes:[]).forEach(n=>{
        const c=compartmentForNode(n);if(!c)return;
        const w=extractNodeWeight(n);
        live[c]={node:n,weight:w};
      });
      // The API's sparse weights array is only a value source; a recent
      // node heartbeat is still required before a value can be labelled live.
      ids.forEach((c,i)=>{
        if(!live[c]&&Array.isArray(data.weights)&&validWeight(data.weights[i])){
          const node=(data.nodes||[]).find(n=>compartmentForNode(n)===c);
          if(node)live[c]={node,weight:Number(data.weights[i])};
        }
      });
      $('wmLiveGrid').innerHTML=ids.map(c=>{
        const item=live[c], n=item&&item.node;
        const seenAt=n&&n.lastSeen?Date.parse(n.lastSeen):NaN;
        const fresh=!!(n&&n.online&&Number.isFinite(seenAt)&&Date.now()-seenAt>=-5000&&Date.now()-seenAt<=30000);
        const weight=fresh&&item.weight!==null?`${item.weight.toFixed(2)}`:'—';
        const status=fresh&&item.weight!==null?'ONLINE':(n?'OFFLINE':'NO HEARTBEAT');
        const seen=n&&n.lastSeen?`Last heartbeat: ${fmtDate(n.lastSeen)} ${fmtTime(n.lastSeen)}`:'No heartbeat available';
        const cls=status==='ONLINE'?'online':'offline';
        const hint=fresh&&item.weight===null?'Node is online, but its payload contains no valid weight.':seen;
        return `<article class="wm-card"><div class="wm-card-top"><span class="wm-id">${c}</span><span class="wm-pill ${cls}">${status}</span></div><div class="wm-weight">${weight}</div><div class="wm-unit">grams</div><div class="wm-meta">${esc(hint)}</div></article>`;
      }).join('');
      $('wmLiveUpdated').textContent='Checked '+new Date().toLocaleTimeString('en-PH');
    }catch(piError){
      try{
        const db=await firebaseReady();
        const snap=await db.ref('/crab_monitor/weights').once('value');
        const values=snap.val()||{};
        const now=Date.now();
        $('wmLiveGrid').innerHTML=ids.map(c=>{
          const v=values[c]||{}, raw=v.weight??v.weight_g??v.grams??v.value;
          let stamp=v.updated_at??v.updatedAt??v.timestamp??null;
          if(typeof stamp==='number'&&stamp<1000000000000)stamp*=1000;
          else if(typeof stamp==='string'&&!/^\d+$/.test(stamp)){const parsed=Date.parse(stamp);stamp=Number.isNaN(parsed)?null:parsed;}
          else if(typeof stamp==='string')stamp=Number(stamp)*(Number(stamp)<1000000000000?1000:1);
          const fresh=Number.isFinite(stamp)&&now-stamp>=-5000&&now-stamp<=30000&&v.online!==false;
          const weight=fresh&&validWeight(raw)?Number(raw).toFixed(2):'—';
          const status=fresh&&validWeight(raw)?'ONLINE':'OFFLINE';
          const meta=fresh?`Updated ${fmtDate(new Date(stamp).toISOString())} ${fmtTime(new Date(stamp).toISOString())}`:'No recent timestamped heartbeat. Existing Firebase value is not shown as live.';
          return `<article class="wm-card"><div class="wm-card-top"><span class="wm-id">${c}</span><span class="wm-pill ${fresh?'online':'offline'}">${status}</span></div><div class="wm-weight">${weight}</div><div class="wm-unit">grams</div><div class="wm-meta">${esc(meta)}</div></article>`;
        }).join('');
        $('wmLiveUpdated').textContent='Checked '+new Date().toLocaleTimeString('en-PH')+' · Firebase timestamp fallback';
      }catch(fbError){
        renderLiveEmpty('Neither Pi heartbeat nor timestamped Firebase live data is available. Cached values are intentionally not shown as live.');
        $('wmLiveUpdated').textContent='Live status unavailable · '+piError.message;
      }
    }
  }
  function captureFields(raw,date,comp,key,path){
    const item=raw&&typeof raw==='object'?raw:{weight_g:raw};
    const wr=item.weight_g??item.weight??item.grams??item.value??item.weightGrams??item.mass_g??item.mass;
    const dateValue=item.date||item.capture_date||item.captureDate||date;
    const captured=item.captured_at??item.capturedAt??item.timestamp??item.created_at??item.createdAt??item.time_captured??item.time??null;
    const status=item.status||(item.online===false||item.valid===false?'Offline/invalid':(validWeight(wr)?'Saved':'Weight missing'));
    return {comp:item.compartment||item.node||item.compartment_id||comp,weight:validWeight(wr)?Number(wr):null,date:String(dateValue),captured,status,key:String(key??''),path};
  }
  async function firebaseReady(){
    if(typeof initFirebaseSDK!=='function')throw Error('CrabTrack Firebase SDK is not initialized.');
    const ready=await initFirebaseSDK();
    if(!ready||typeof firebaseDb==='undefined'||!firebaseDb)throw Error('Firebase connection is not ready. Check the existing CrabTrack Firebase configuration and authentication.');
    return firebaseDb;
  }
  async function loadCaptured(){
    const start=$('wmFrom').value,end=$('wmTo').value,selected=$('wmComp').value;
    if(!start||!end||start>end){$('wmCapturedStatus').textContent='Choose a valid date range.';return;}
    const dayCount=(Date.parse(end+'T12:00:00')-Date.parse(start+'T12:00:00'))/86400000+1;
    if(dayCount>366){$('wmCapturedStatus').textContent='Choose a date range of 366 days or less.';return;}
    $('wmLoadCaptured').disabled=true;
    $('wmCapturedStatus').textContent='Reading saved scheduled captures from Firebase…';
    $('wmCapturedRows').innerHTML='<tr><td colspan="5">Loading saved records…</td></tr>';
    try{
      const db=await firebaseReady(), records=[], targets=selected==='ALL'?ids:[selected];
      const cursor=new Date(start+'T12:00:00'), last=new Date(end+'T12:00:00'), dates=[];
      while(cursor<=last){dates.push(`${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}-${String(cursor.getDate()).padStart(2,'0')}`);cursor.setDate(cursor.getDate()+1);}
      const requests=[];
      for(const c of targets)for(const d of dates)requests.push((async()=>{
        const snap=await db.ref(`/crab_monitor/weight_history/${c}/${d}`).once('value');
        let v=snap.val();
        if(v==null){
          const alt=await db.ref(`/crab_monitor/weight_history/${c}`).once('value');
          const all=alt.val();if(all&&typeof all==='object')v=all[d]??all[d.replaceAll('-','')]??null;
        }
        return {c,d,v};
      })());
      const results=await Promise.all(requests);
      const seen=new Set();
      results.forEach(({c,d,v})=>{
        if(v==null)return;
        const hasWeight=x=>x&&typeof x==='object'&&['weight_g','weight','grams','value','weightGrams','mass_g','mass'].some(k=>x[k]!==undefined);
        let entries=[];
        if(hasWeight(v)||typeof v==='number'||typeof v==='string')entries=[['',v]];
        else if(typeof v==='object')entries=Object.entries(v).filter(([,x])=>x!==null);
        entries.forEach(([key,raw])=>{
          const rec=captureFields(raw,d,c,key,`/crab_monitor/weight_history/${c}/${d}`);
          const identity=`${rec.path}/${key}`;
          if(seen.has(identity))return;seen.add(identity);
          records.push(rec);
        });
      });
      records.sort((a,b)=>String(b.date).localeCompare(String(a.date))||String(b.captured||'').localeCompare(String(a.captured||''))||a.comp.localeCompare(b.comp));
      renderCaptured(records,start,end);
      $('wmCapturedStatus').textContent=`${records.length} saved capture record(s) found · ${start} through ${end} · refreshed ${new Date().toLocaleTimeString('en-PH')}`;
    }catch(e){
      $('wmCapturedRows').innerHTML='<tr><td colspan="5">Unable to load saved captures.</td></tr>';
      $('wmCapturedLatest').innerHTML='';
      $('wmCapturedStatus').textContent='Captured history unavailable: '+e.message;
    }finally{$('wmLoadCaptured').disabled=false;}
  }
  function renderCaptured(records,start,end){
    const latest={};
    records.forEach(r=>{if(ids.includes(r.comp)&&!latest[r.comp])latest[r.comp]=r;});
    $('wmCapturedLatest').innerHTML=ids.map(c=>{
      const r=latest[c];
      return `<article class="wm-card"><div class="wm-card-top"><span class="wm-id">${c}</span><span class="wm-pill">${r?'SAVED':'NO RECORD'}</span></div><div class="wm-weight">${r&&r.weight!==null?r.weight.toFixed(2):'—'}</div><div class="wm-unit">grams · most recent in selected range</div><div class="wm-meta">${r?`${esc(fmtDate(r.date))} · ${esc(fmtTime(r.captured))}`:'No saved capture in this date range'}</div></article>`;
    }).join('');
    $('wmCapturedRows').innerHTML=records.length?records.map(r=>`<tr><td>${esc(r.comp)}</td><td>${r.weight===null?'—':r.weight.toFixed(2)}</td><td>${esc(fmtDate(r.date))}</td><td>${esc(fmtTime(r.captured))}</td><td>${esc(r.status)}</td></tr>`).join(''):'<tr><td colspan="5" class="wm-empty">No saved capture records for this selection.</td></tr>';
  }
  function init(){
    const today=localDate();$('wmFrom').value=today;$('wmTo').value=today;
    ids.forEach(c=>{const o=document.createElement('option');o.value=c;o.textContent=c;$('wmComp').appendChild(o);});
    renderLiveEmpty('Waiting for Raspberry Pi node heartbeat.');
    $('wmRefresh').addEventListener('click',loadLive);
    $('wmLoadCaptured').addEventListener('click',loadCaptured);
    // Live heartbeat polling runs independently from the existing dashboard source selector.
    loadLive();setInterval(()=>{if(document.visibilityState==='visible')loadLive();},5000);
    // Initial captured records: today only; no fabricated data is inserted.
    loadCaptured();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
