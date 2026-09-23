const C = { oca:'#ff6b2b', awt:'#4ea1ff' };
const LBL = { oca:'OrchestratedCodingAgent', awt:'agent:work-ticket' };
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const MONO = 'ui-monospace,Menlo,monospace';
let WK = null;                        // normalized rows, set on load
const active = { oca:true, awt:true };  // which labels are shown
const KEYS = () => ['oca','awt'].filter(k => active[k]);

function wkLabel(iso){
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric', timeZone:'UTC' });
}
function fmtDur(ms){
  if (!ms) return '0h';
  const h = ms/3600000;
  if (h < 1) return Math.round(ms/60000)+'m';
  if (h < 48) return (h<10 ? h.toFixed(1) : Math.round(h))+'h';
  const d = Math.floor(h/24), rh = Math.round(h%24);
  return d+'d'+(rh ? ' '+rh+'h' : '');
}
function frame(g, title, sub){
  const W=960,H=300;
  return `<div class="chart"><h2>${esc(title)}</h2><div class="sub">${esc(sub)}</div><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg></div>`;
}
function grid(yMax, fmt, steps){
  const W=960,padL=42,padR=12,padT=26,padB=34,H=300,iw=W-padL-padR,ih=H-padT-padB;
  let g='';
  for (let i=0;i<=steps;i++){
    const v=yMax*i/steps, y=padT+ih-ih*v/yMax;
    g+=`<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#2a303a" stroke-width="1" stroke-dasharray="${i?'3,4':''}"/>`;
    g+=`<text x="${padL-8}" y="${y+4}" text-anchor="end" font-size="10" fill="#5a6270" font-family="${MONO}">${fmt(v)}</text>`;
  }
  return g;
}
// stacked bars of a per-label numeric field. valOf(row,k)->number; noteOf(row)->string above bar; hoverOf(row,k)->tooltip.
function stacked(title, sub, valFmt, valOf, noteOf, hoverOf){
  const W=960,padL=42,padR=12,padT=26,padB=34,H=300,iw=W-padL-padR,ih=H-padT-padB;
  const ks=KEYS();
  const tot=r=>ks.reduce((a,k)=>a+valOf(r,k),0);
  const max=Math.max(1e-9,...WK.map(tot));
  const yMax=valFmt.round(max*1.15);
  const n=WK.length, slot=iw/n, bw=Math.min(56, slot*0.62);
  let g=grid(yMax, valFmt.axis, valFmt.steps(yMax));
  WK.forEach((r,i)=>{
    const cx=padL+slot*i+slot/2, x=cx-bw/2;
    let y=padT+ih;
    ks.forEach(k=>{
      const v=valOf(r,k); if(!v) return;
      const h=ih*v/yMax; y-=h;
      g+=`<rect class="bar" x="${x}" y="${y}" width="${bw}" height="${h}" rx="3" fill="${C[k]}"><title>${esc(r.wk)} — ${LBL[k]}: ${esc(hoverOf(r,k))}</title></rect>`;
    });
    const note=noteOf(r);
    if (tot(r) && note!=null) g+=`<text x="${cx}" y="${y-6}" text-anchor="middle" font-size="11" fill="#e8e6df" font-family="${MONO}">${esc(note)}</text>`;
    g+=`<text x="${cx}" y="${padT+ih+16}" text-anchor="middle" font-size="10" fill="#8b93a1" font-family="${MONO}">${wkLabel(r.wk)}</text>`;
  });
  return frame(g,title,sub);
}
// grouped bars with fractional axis (touch-up rate) + overall dashed line.
function chartTouch(title, sub){
  const W=960,padL=42,padR=12,padT=26,padB=34,H=300,iw=W-padL-padR,ih=H-padT-padB;
  const ks=KEYS();
  const rate=(r,k)=>r[k].m ? r[k].tc/r[k].m : 0;
  const overall=r=>{const m=ks.reduce((a,k)=>a+r[k].m,0),tc=ks.reduce((a,k)=>a+r[k].tc,0);return {v:m?tc/m:0,n:m};};
  const max=Math.max(0.5,...WK.map(r=>Math.max(...ks.map(k=>rate(r,k)), overall(r).v)));
  const yMax=Math.ceil(max*1.15*2)/2;
  const n=WK.length, slot=iw/n, gw=Math.min(60, slot*0.7), bw=gw/(ks.length||1)-1;
  let g=grid(yMax, v=>Math.round(v*10)/10, 5);
  WK.forEach((r,i)=>{
    const cx=padL+slot*i+slot/2;
    ks.forEach((k,idx)=>{
      const cnt=r[k].m; if(!cnt) return;
      const val=rate(r,k), h=ih*val/yMax, x=cx-gw/2+idx*(gw/ks.length), y=padT+ih-h;
      g+=`<rect class="bar" x="${x}" y="${y}" width="${bw}" height="${Math.max(h,1.5)}" rx="3" fill="${C[k]}"><title>${esc(r.wk)} — ${LBL[k]}: ${val.toFixed(1)} c/MR (${cnt} merged MR${cnt===1?'':'s'})</title></rect>`;
      g+=`<text x="${x+bw/2}" y="${y-5}" text-anchor="middle" font-size="10" fill="#e8e6df" font-family="${MONO}">${val.toFixed(1)}</text>`;
    });
    g+=`<text x="${cx}" y="${padT+ih+16}" text-anchor="middle" font-size="10" fill="#8b93a1" font-family="${MONO}">${wkLabel(r.wk)}</text>`;
  });
  const pts=WK.map((r,i)=>{const o=overall(r);return o.n?{x:padL+slot*i+slot/2,y:padT+ih-ih*o.v/yMax,o,r}:null;});
  let path='',pen=false;
  pts.forEach(pt=>{if(!pt){pen=false;return;}path+=(pen?'L':'M')+pt.x.toFixed(1)+','+pt.y.toFixed(1);pen=true;});
  if(path) g+=`<path d="${path}" fill="none" stroke="#e8e6df" stroke-width="1.6" stroke-dasharray="5,4" opacity="0.85" pointer-events="none"/>`;
  pts.forEach(pt=>{if(!pt)return;
    g+=`<circle cx="${pt.x}" cy="${pt.y}" r="3.2" fill="#e8e6df" stroke="#0b0d10" stroke-width="1"><title>${esc(pt.r.wk)} — overall: ${pt.o.v.toFixed(1)} c/MR (${pt.o.n} merged MRs)</title></circle>`;
    g+=`<text x="${pt.x}" y="${pt.y-8}" text-anchor="middle" font-size="10" fill="#e8e6df" font-family="${MONO}">${pt.o.v.toFixed(1)}</text>`;
  });
  return frame(g,title,sub);
}
// grouped bars: average run duration per run (dur/durN) by label + overall dashed line.
function chartAvgDur(title, sub){
  const W=960,padL=42,padR=12,padT=26,padB=34,H=300,iw=W-padL-padR,ih=H-padT-padB;
  const ks=KEYS();
  const avg=(r,k)=>r[k].durN ? r[k].dur/r[k].durN : 0;
  const overall=r=>{const d=ks.reduce((a,k)=>a+r[k].dur,0),n=ks.reduce((a,k)=>a+r[k].durN,0);return {v:n?d/n:0,n};};
  const max=Math.max(1e-9,...WK.map(r=>Math.max(...ks.map(k=>avg(r,k)), overall(r).v)));
  const yMax=HRS.round(max*1.15);
  const n=WK.length, slot=iw/n, gw=Math.min(60, slot*0.7), bw=gw/(ks.length||1)-1;
  let g=grid(yMax, HRS.axis, HRS.steps(yMax));
  WK.forEach((r,i)=>{
    const cx=padL+slot*i+slot/2;
    ks.forEach((k,idx)=>{
      const cnt=r[k].durN; if(!cnt) return;
      const val=avg(r,k), h=ih*val/yMax, x=cx-gw/2+idx*(gw/ks.length), y=padT+ih-h;
      g+=`<rect class="bar" x="${x}" y="${y}" width="${bw}" height="${Math.max(h,1.5)}" rx="3" fill="${C[k]}"><title>${esc(r.wk)} — ${LBL[k]}: ${fmtDur(val)}/run (${cnt} run${cnt===1?'':'s'})</title></rect>`;
      g+=`<text x="${x+bw/2}" y="${y-5}" text-anchor="middle" font-size="10" fill="#e8e6df" font-family="${MONO}">${fmtDur(val)}</text>`;
    });
    g+=`<text x="${cx}" y="${padT+ih+16}" text-anchor="middle" font-size="10" fill="#8b93a1" font-family="${MONO}">${wkLabel(r.wk)}</text>`;
  });
  const pts=WK.map((r,i)=>{const o=overall(r);return o.n?{x:padL+slot*i+slot/2,y:padT+ih-ih*o.v/yMax,o,r}:null;});
  let path='',pen=false;
  pts.forEach(pt=>{if(!pt){pen=false;return;}path+=(pen?'L':'M')+pt.x.toFixed(1)+','+pt.y.toFixed(1);pen=true;});
  if(path) g+=`<path d="${path}" fill="none" stroke="#e8e6df" stroke-width="1.6" stroke-dasharray="5,4" opacity="0.85" pointer-events="none"/>`;
  pts.forEach(pt=>{if(!pt)return;
    g+=`<circle cx="${pt.x}" cy="${pt.y}" r="3.2" fill="#e8e6df" stroke="#0b0d10" stroke-width="1"><title>${esc(pt.r.wk)} — overall: ${fmtDur(pt.o.v)}/run (${pt.o.n} runs)</title></circle>`;
  });
  return frame(g,title,sub);
}
const INT = { round:v=>Math.max(1,Math.ceil(v)), axis:v=>Math.round(v), steps:yMax=>yMax<=6?Math.max(1,yMax):5 };
const HRS = {
  round:v=>{ const h=v/3600000; const step=h<=12?2:h<=48?6:h<=168?24:48; return Math.max(step,Math.ceil(h/step)*step)*3600000; },
  axis:ms=>{ const h=ms/3600000; return h>=48 ? Math.round(h/24)+'d' : Math.round(h)+'h'; },
  steps:()=>5
};

function render(){
  if (!WK) return;
  const merged = stacked(
    'MRs merged per week',
    'factory MRs (by label) that reached merge, bucketed by merge week (Mon-start, UTC)',
    INT, (r,k)=>r[k].m,
    r=>{ const t=KEYS().reduce((a,k)=>a+r[k].m,0); return t||null; },
    (r,k)=>r[k].m+' merged');
  const touch = chartTouch(
    'MRs needing touch-up per week',
    'y-axis = avg touch-up commits per merged MR (c/MR) — commits pushed AFTER the factory handed off (Linear left \u201cIn Progress\u201d) \u00b7 by label \u00b7 dashed line = overall avg \u00b7 hover for merged-MR counts');
  const clean = stacked(
    'Clean MRs per week \u2014 no touch-up',
    'merged MRs with zero post-handoff commits \u00b7 label above bar = clean share of that week\u2019s merges',
    INT, (r,k)=>r[k].clean,
    r=>{ const ks=KEYS(); const m=ks.reduce((a,k)=>a+r[k].m,0),c=ks.reduce((a,k)=>a+r[k].clean,0); return m?Math.round(100*c/m)+'%':null; },
    (r,k)=>r[k].clean+' clean');
  const dur = chartAvgDur(
    'Average run time per MR (start \u2192 complete)',
    'y-axis = avg factory run duration per MR \u2014 from Linear \u201cIn Progress\u201d entry to departure (run complete) \u00b7 by label \u00b7 bucketed by merge week \u00b7 dashed line = overall avg \u00b7 hover for run counts');
  document.getElementById('charts').innerHTML = merged + touch + clean + dur;
}

async function load(){
  try{
    const s = await (await fetch('/api/state')).json();
    const wk = s.stages && s.stages.stats && s.stages.stats.weekly;
    const meta = document.getElementById('meta');
    if (!wk || !Object.keys(wk).length){
      document.getElementById('empty').style.display = 'block';
      meta.textContent = 'no data yet';
      return;
    }
    WK = Object.keys(wk).sort().map(w => {
      const d = wk[w];
      const norm = o => ({ m:(o&&o.m)||0, clean:((o&&o.m)||0)-((o&&o.t)||0), tc:(o&&o.tc)||0, dur:(o&&o.dur)||0, durN:(o&&o.durN)||0 });
      return { wk:w, oca:norm(d.oca), awt:norm(d.awt) };
    });
    render();
    const pend = s.stages.stats.weeklyPending;
    meta.textContent = 'updated ' + new Date(s.stages.updatedAt).toLocaleTimeString() + (pend ? ' \u00b7 backfilling ' + pend + ' MRs\u2026' : '');
  } catch(e){
    document.getElementById('meta').textContent = 'error loading stats';
  }
}
document.querySelectorAll('#legend .chip').forEach(btn => {
  btn.addEventListener('click', () => {
    const k = btn.dataset.k;
    if (active[k] && !['oca','awt'].some(x => x!==k && active[x])) return; // keep at least one on
    active[k] = !active[k];
    btn.classList.toggle('on', active[k]);
    btn.classList.toggle('off', !active[k]);
    render();
  });
});
load();
setInterval(load, 60000);
