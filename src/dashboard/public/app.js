/**
 * AutoApply Dashboard — app.js v3
 * All features: stats, jobs (CSV import/export), learning list,
 * resume upload + AI auto-learn, keywords tag editor, live browser view,
 * settings, profile editor, selectors editor, blocklist, live log,
 * dark/light mode, bot controls, real-time socket.io
 */
'use strict';

/* ── Socket.io ────────────────────────────────────────────── */
const socket = io();

/* ── Theme ────────────────────────────────────────────────── */
const html    = document.documentElement;
const btnTheme = document.getElementById('themeToggle');
(function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  html.setAttribute('data-theme', saved);
  btnTheme.textContent = saved === 'dark' ? '🌙' : '☀️';
})();
btnTheme.addEventListener('click', () => {
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  btnTheme.textContent = next === 'dark' ? '🌙' : '☀️';
});

/* ── Toast ────────────────────────────────────────────────── */
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === 'ok' ? '✅' : type === 'err' ? '🔴' : 'ℹ️'}</span><span>${msg}</span>`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ── Tab navigation ───────────────────────────────────────── */
document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    const tab = el.dataset.tab;
    document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    const page = document.getElementById(`page-${tab}`);
    if (page) page.classList.add('active');
    // Lazy load on switch
    if (tab === 'jobs')      loadJobs();
    if (tab === 'learning')  { loadLearning(); loadResumeContent(); }
    if (tab === 'config')    loadConfig();
    if (tab === 'keywords')  loadKeywords();
    if (tab === 'profile')   loadProfile();
    if (tab === 'selectors') loadSelectors();
    if (tab === 'blocklist') loadBlocklist();
    if (tab === 'liveview')  startScreenshotRefresh();
  });
});

/* ── Connection badge ────────────────────────────────────── */
const connDot   = document.getElementById('connDot');
const connLabel = document.getElementById('connLabel');
socket.on('connect',    () => { connDot.className = 'conn-dot ok'; connLabel.textContent = 'Connected'; });
socket.on('disconnect', () => { connDot.className = 'conn-dot err'; connLabel.textContent = 'Disconnected'; });

/* ═══════════════ STATS / DASHBOARD ═════════════════════════ */
function updateKPI(s) {
  animNum('kTotal',    s.total   || 0);
  animNum('kApplied',  s.applied || 0);
  animNum('kSkipped',  s.skipped || 0);
  animNum('kFailed',   s.failed  || 0);
  document.getElementById('kRate').textContent  = (s.successRate || 0) + '%';
  document.getElementById('nc-total').textContent = s.total || 0;
  document.getElementById('nc-jobs').textContent  = s.total || 0;
}
function animNum(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const cur = parseInt(el.textContent) || 0;
  const step = Math.ceil(Math.abs(target - cur) / 18);
  let v = cur;
  const tid = setInterval(() => {
    if (v === target) { clearInterval(tid); return; }
    v = v < target ? Math.min(v + step, target) : Math.max(v - step, target);
    el.textContent = v;
  }, 25);
}

async function loadDashboard() {
  try {
    const [statsR, summR] = await Promise.all([
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/db/summary').then(r => r.json()),
    ]);
    updateKPI(statsR);
    document.getElementById('kLearning').textContent = summR.learning || 0;
    document.getElementById('nc-learning').textContent = summR.learning || 0;
    document.getElementById('lastRefresh').textContent = 'Last updated ' + new Date().toLocaleTimeString();

    await Promise.all([loadTrendChart(), loadDonutChart(), loadCompanyChart(), loadScoreChart()]);
    await loadRecent();
  } catch (e) { console.error('[Dashboard]', e); }
}

socket.on('init:stats',   updateKPI);
socket.on('stats:update', updateKPI);
socket.on('job:applied',  () => { loadDashboard(); updateLearningCount(); });
socket.on('job:analyzed', d => appendLog('info', `🔍 Analyzed: ${d.title} @ ${d.company} → ${d.decision} (${d.score})`));
socket.on('selflearn:done', r => { toast(`✨ Auto-learned ${r.answered} answers`, 'ok'); updateLearningCount(); });

async function updateLearningCount() {
  try { const s = await fetch('/api/db/summary').then(r=>r.json()); document.getElementById('nc-learning').textContent = s.learning||0; document.getElementById('kLearning').textContent = s.learning||0; } catch(_) {}
}

document.getElementById('btnRefreshDash').addEventListener('click', loadDashboard);

/* ── Charts ──────────────────────────────────────────────── */
const chartCol = { applied:'#10b981', skipped:'#f59e0b', failed:'#ef4444', pending:'#6366f1', total:'#3b82f6' };
const charts = {};

function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
function chartDefaults() { return { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ labels:{ color: getComputedStyle(html).getPropertyValue('--tx').trim()||'#eef0f7', font:{ size:11 } } } }, scales:{} }; }

async function loadTrendChart() {
  try {
    const rows = await fetch('/api/jobs/trend').then(r=>r.json());
    const labels  = rows.map(r => r.day);
    const applied = rows.map(r => r.applied);
    const skipped = rows.map(r => r.skipped);
    const failed  = rows.map(r => r.failed);
    destroyChart('trend');
    const ctx = document.getElementById('cTrend').getContext('2d');
    const fmk = (c,a) => { const g=ctx.createLinearGradient(0,0,0,180); g.addColorStop(0,c.replace(')',`,${a})`).replace('rgb','rgba')); g.addColorStop(1,'transparent'); return g; };
    const def = chartDefaults();
    charts.trend = new Chart(ctx, { type:'line', data:{ labels, datasets:[
      { label:'Applied', data:applied, borderColor:chartCol.applied, backgroundColor:'rgba(16,185,129,.12)', fill:true, tension:.4, pointRadius:3 },
      { label:'Skipped', data:skipped, borderColor:chartCol.skipped, backgroundColor:'rgba(245,158,11,.09)', fill:true, tension:.4, pointRadius:3 },
      { label:'Failed',  data:failed,  borderColor:chartCol.failed,  backgroundColor:'rgba(239,68,68,.09)',  fill:true, tension:.4, pointRadius:3 },
    ]}, options:{ ...def, scales:{ x:{ ticks:{ color:'#505872', font:{size:10} }, grid:{ color:'rgba(255,255,255,.04)' } }, y:{ ticks:{ color:'#505872' }, grid:{ color:'rgba(255,255,255,.04)' }, beginAtZero:true } } } });
  } catch(e) { console.warn('[TrendChart]', e); }
}

async function loadDonutChart() {
  try {
    const s = await fetch('/api/stats').then(r=>r.json());
    destroyChart('donut');
    charts.donut = new Chart(document.getElementById('cDonut').getContext('2d'), {
      type:'doughnut',
      data:{ labels:['Applied','Skipped','Failed','Pending'], datasets:[{ data:[s.applied,s.skipped,s.failed,s.pending], backgroundColor:['#10b981','#f59e0b','#ef4444','rgba(99,102,241,.5)'], borderWidth:0, hoverOffset:6 }] },
      options:{ ...chartDefaults(), cutout:'72%', plugins:{ legend:{ position:'bottom', labels:{ color: getComputedStyle(html).getPropertyValue('--tx').trim()||'#eef0f7', boxWidth:10, padding:12, font:{size:11} } } } }
    });
  } catch(e) { console.warn('[DonutChart]', e); }
}

async function loadCompanyChart() {
  try {
    const rows = await fetch('/api/jobs/top-companies').then(r=>r.json());
    destroyChart('co');
    const def = chartDefaults();
    charts.co = new Chart(document.getElementById('cCompanies').getContext('2d'), {
      type:'bar',
      data:{ labels:rows.map(r=>r.company.length>16?r.company.substring(0,16)+'…':r.company), datasets:[
        { label:'Total',   data:rows.map(r=>r.total),   backgroundColor:'rgba(99,102,241,.6)',  borderRadius:5 },
        { label:'Applied', data:rows.map(r=>r.applied), backgroundColor:'rgba(16,185,129,.7)', borderRadius:5 },
      ]},
      options:{ ...def, scales:{ x:{ ticks:{ color:'#505872', font:{size:10} }, grid:{color:'rgba(255,255,255,.04)'} }, y:{ beginAtZero:true, ticks:{ color:'#505872' }, grid:{color:'rgba(255,255,255,.04)'} } } }
    });
  } catch(e) { console.warn('[CompanyChart]', e); }
}

async function loadScoreChart() {
  try {
    const rows = await fetch('/api/jobs/score-dist').then(r=>r.json());
    destroyChart('sc');
    const scoreColors = { '90-100':'#10b981','75-89':'#3b82f6','60-74':'#a855f7','40-59':'#f59e0b','Below 40':'#ef4444' };
    const def = chartDefaults();
    charts.sc = new Chart(document.getElementById('cScores').getContext('2d'), {
      type:'bar',
      data:{ labels:rows.map(r=>r.range), datasets:[{ label:'Jobs', data:rows.map(r=>r.count), backgroundColor:rows.map(r=>scoreColors[r.range]||'#6366f1'), borderRadius:6 }]},
      options:{ ...def, scales:{ x:{ ticks:{ color:'#505872', font:{size:10} }, grid:{color:'rgba(255,255,255,.04)'} }, y:{ beginAtZero:true, ticks:{ color:'#505872' }, grid:{color:'rgba(255,255,255,.04)'} } } }
    });
  } catch(e) { console.warn('[ScoreChart]', e); }
}

async function loadRecent() {
  try {
    const rows = await fetch('/api/jobs/recent').then(r=>r.json());
    const el = document.getElementById('recentList');
    if (!rows.length) { el.innerHTML = '<div style="color:var(--tx3);text-align:center;padding:20px">No activity yet.</div>'; return; }
    el.innerHTML = rows.map(r => `
      <div class="recent-row">
        ${statusBadgeStr(r.apply_status)}
        <span class="rr-title">${esc(r.title)}</span>
        <span class="rr-co">${esc(r.company)}</span>
        ${scoreBarStr(r.score)}
        <span class="rr-date">${fmtDate(r.created_at)}</span>
      </div>`).join('');
  } catch(e) { console.warn('[Recent]', e); }
}

/* ═══════════════ JOBS TAB ═══════════════════════════════════ */
let allJobs = [];
async function loadJobs() {
  try {
    allJobs = await fetch('/api/jobs/all').then(r=>r.json());
    renderJobs();
    document.getElementById('nc-jobs').textContent = allJobs.length;
  } catch(e) { console.warn('[Jobs]', e); toast('Failed to load jobs', 'err'); }
}

function renderJobs() {
  const q     = (document.getElementById('jobSearch').value || '').toLowerCase();
  const status= document.getElementById('jobFilter').value;
  const sort  = document.getElementById('jobSort').value;
  let rows = allJobs.filter(j => {
    if (status && j.apply_status !== status) return false;
    if (q && !`${j.title} ${j.company} ${j.location||''} ${j.reason||''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const [field, dir] = sort.split('-');
  rows.sort((a,b) => {
    let av = a[field], bv = b[field];
    if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv||'') : (bv||'').localeCompare(av);
    return dir === 'asc' ? (av||0)-(bv||0) : (bv||0)-(av||0);
  });

  const tbody = document.getElementById('tblJobsBody');
  const empty = document.getElementById('jobsEmpty');
  if (!rows.length) { tbody.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display = 'none';
  tbody.innerHTML = rows.map(j => `
    <tr>
      <td title="${esc(j.title)}" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.title)}</td>
      <td>${esc(j.company||'')}</td>
      <td>${esc(j.location||'-')}</td>
      <td>${scoreBarStr(j.score)}</td>
      <td>${statusBadgeStr(j.apply_status)}</td>
      <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--tx2)" title="${esc(j.reason||'')}"><span>${esc((j.reason||'').substring(0,60))}</span></td>
      <td style="white-space:nowrap;font-size:12px">${fmtDate(j.created_at)}</td>
      <td>${jobLinkCell(j)}</td>
    </tr>`).join('');
}

['jobSearch','jobFilter','jobSort'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderJobs);
  document.getElementById(id).addEventListener('change', renderJobs);
});
document.getElementById('btnRefreshJobs').addEventListener('click', loadJobs);

// Jobs CSV Export
document.getElementById('btnJobExport').addEventListener('click', () => {
  window.location.href = '/api/jobs/export/csv';
});

// Jobs CSV Import
document.getElementById('jobImportFile').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const text = await file.text();
  try {
    const r = await fetch('/api/jobs/import/csv', { method:'POST', headers:{'Content-Type':'text/csv'}, body:text });
    const d = await r.json();
    if (d.success) { toast(`✅ Imported ${d.inserted} jobs`, 'ok'); loadJobs(); loadDashboard(); }
    else toast('Import failed: ' + d.error, 'err');
  } catch(err) { toast('Error: ' + err.message, 'err'); }
  e.target.value = '';
});

// Global CSV export button in sidebar
document.getElementById('btnExportCsv').addEventListener('click', () => {
  window.location.href = '/api/jobs/export/csv';
});

/* ═══════════════ LEARNING LIST TAB══════════════════════════ */
let allLearning = [];
async function loadLearning() {
  try {
    allLearning = await fetch('/api/learning').then(r=>r.json());
    renderLearning();
    document.getElementById('nc-learning').textContent = allLearning.length;
  } catch(e) { toast('Failed to load learning list','err'); }
}

function renderLearning() {
  const q      = (document.getElementById('lSearch').value || '').toLowerCase();
  const filter = document.getElementById('lFilter').value;
  let rows = allLearning.filter(r => {
    if (filter === 'answered' && !r.answered) return false;
    if (filter === 'unanswered' && r.answered) return false;
    if (q && !`${r.question} ${r.answer||''} ${r.answer_key||''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const tbody = document.getElementById('tblLBody');
  const empty = document.getElementById('lEmpty');
  const meta  = document.getElementById('lMeta');
  const answCnt = allLearning.filter(r=>r.answered).length;
  meta.innerHTML = `<span>Total: <b>${allLearning.length}</b></span><span>Answered: <b>${answCnt}</b></span><span>Unanswered: <b>${allLearning.length-answCnt}</b></span><span>Showing: <b>${rows.length}</b></span>`;
  if (!rows.length) { tbody.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display='none';
  tbody.innerHTML = rows.map((r,i) => `
    <tr id="lr-${r.id}">
      <td style="color:var(--tx3);font-size:11px;width:36px">${i+1}</td>
      <td style="color:var(--tx)">${esc(r.question)}</td>
      <td style="color:var(--tx3);font-size:12px">${esc(r.answer_key||'')}</td>
      <td>
        <span class="editable" contenteditable="true" data-id="${r.id}" title="Click to edit">${esc(r.answer||'')}</span>
      </td>
      <td>${r.answered ? '<span class="badge b-green">✓ Answered</span>' : '<span class="badge b-muted">Pending</span>'}</td>
      <td class="actions-col">
        <button class="btn-icon-edit" onclick="saveEditInline(${r.id})">💾</button>
        <button class="btn-icon-del"  onclick="deleteLearning(${r.id})">🗑</button>
      </td>
    </tr>`).join('');

  // Inline save on Enter
  document.querySelectorAll('.editable[data-id]').forEach(el => {
    el.addEventListener('keydown', e => { if (e.key==='Enter'&&!e.shiftKey) { e.preventDefault(); saveEditInline(Number(el.dataset.id)); } });
  });
}

window.saveEditInline = async function(id) {
  const el = document.querySelector(`.editable[data-id="${id}"]`);
  if (!el) return;
  const answer = el.textContent.trim();
  try {
    const r = await fetch(`/api/learning/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({answer}) });
    const d = await r.json();
    if (d.success) { toast('Saved!','ok'); const entry = allLearning.find(x=>x.id===id); if(entry) { entry.answer=answer; entry.answered=1; } }
    else toast('Save failed: '+d.error,'err');
  } catch(e) { toast('Error: '+e.message,'err'); }
};

window.deleteLearning = async function(id) {
  if (!confirm('Delete this Q&A entry?')) return;
  try {
    const r = await fetch(`/api/learning/${id}`, { method:'DELETE' });
    const d = await r.json();
    if (d.success) { allLearning = allLearning.filter(x=>x.id!==id); renderLearning(); toast('Deleted','ok'); }
    else toast('Delete failed: '+d.error,'err');
  } catch(e) { toast('Error','err'); }
};

// Add Q&A
document.getElementById('btnAddQA').addEventListener('click', async () => {
  const q = document.getElementById('lNewQ').value.trim();
  const a = document.getElementById('lNewA').value.trim();
  const k = document.getElementById('lNewKey').value.trim();
  if (!q || !a) { toast('Question and Answer required','err'); return; }
  const r = await fetch('/api/learning', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ question:q, answer:a, answerKey:k||undefined }) });
  const d = await r.json();
  if (d.success) { toast('Added!','ok'); document.getElementById('lNewQ').value=''; document.getElementById('lNewA').value=''; document.getElementById('lNewKey').value=''; loadLearning(); }
  else toast('Error: '+d.error,'err');
});

// Search/filter
['lSearch','lFilter'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderLearning);
  document.getElementById(id).addEventListener('change', renderLearning);
});
document.getElementById('btnRefreshL').addEventListener('click', loadLearning);

// Self-learn
document.getElementById('btnSelfLearn').addEventListener('click', async () => {
  const btn = document.getElementById('btnSelfLearn');
  btn.disabled=true; btn.textContent='⏳ Running…';
  try {
    const r = await fetch('/api/learning/self-learn',{method:'POST'});
    const d = await r.json();
    if (d.success) { toast(`✨ Auto-learned ${d.answered} answers`,'ok'); loadLearning(); }
    else toast(d.status||'Finished','info');
  } catch(e) { toast('Error','err'); }
  btn.disabled=false; btn.textContent='✨ Auto-Learn';
});

// Learning CSV Export
document.getElementById('btnLearningExport').addEventListener('click', () => { window.location.href='/api/learning/export/csv'; });

// Learning CSV Import
document.getElementById('lImportFile').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const text = await file.text();
  try {
    const r = await fetch('/api/learning/import/csv',{method:'POST',headers:{'Content-Type':'text/csv'},body:text});
    const d = await r.json();
    if (d.success) { toast(`Imported ${d.inserted} entries`,'ok'); loadLearning(); }
    else toast('Import failed: '+d.error,'err');
  } catch(err) { toast('Error','err'); }
  e.target.value='';
});

/* ── Resume Upload + AI Auto-Learn ───────────────────────── */
async function loadResumeContent() {
  try {
    const d = await fetch('/api/resume/content').then(r=>r.json());
    if (d.text) {
      document.getElementById('resumeEditor').value = d.text;
      document.getElementById('btnAutoLearnResume').disabled = false;
    }
  } catch(_) {}
}

document.getElementById('resumeUpload').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('resume', file);
  toast('Uploading and extracting text…','info');
  try {
    const r = await fetch('/api/resume/upload',{method:'POST',body:fd});
    const d = await r.json();
    if (d.success) {
      document.getElementById('resumeEditor').value = d.text;
      document.getElementById('btnAutoLearnResume').disabled = false;
      toast(`Extracted ${d.length} characters from resume`,'ok');
    } else toast('Upload failed: '+d.error,'err');
  } catch(err) { toast('Error: '+err.message,'err'); }
  e.target.value='';
});

// Save edited resume text
document.getElementById('resumeEditor').addEventListener('blur', async () => {
  const text = document.getElementById('resumeEditor').value;
  if (!text.trim()) return;
  await fetch('/api/resume/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
});

// AI Auto-Learn from resume
document.getElementById('btnAutoLearnResume').addEventListener('click', async () => {
  const text = document.getElementById('resumeEditor').value.trim();
  if (!text) { toast('Please upload or paste your resume first','err'); return; }
  const btn = document.getElementById('btnAutoLearnResume');
  btn.disabled=true; btn.textContent='🤖 AI Generating… (may take 30s)';
  try {
    const r = await fetch('/api/resume/auto-learn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    const d = await r.json();
    if (d.success) { toast(`🎉 Generated ${d.generated} Q&As, saved ${d.saved} to DB`,'ok'); loadLearning(); }
    else toast('Error: '+d.error,'err');
  } catch(err) { toast('Error: '+err.message,'err'); }
  btn.disabled=false; btn.textContent='🤖 AI Auto-Generate Q&A';
});

/* ═══════════════ LIVE LOG TAB ═══════════════════════════════ */
const logVP = document.getElementById('logVP');
function appendLog(level, msg) {
  const ts = new Date().toLocaleTimeString();
  const row = document.createElement('div');
  row.className = `log-row ${level}`;
  row.innerHTML = `<span class="log-ts">${ts}</span><span class="log-msg">${esc(msg)}</span>`;
  logVP.appendChild(row);
  logVP.scrollTop = logVP.scrollHeight;
  if (logVP.children.length > 500) logVP.removeChild(logVP.firstChild);
}
socket.on('bot:log', d => appendLog(d.level || detectLevel(d.msg), d.msg));

document.getElementById('btnClearLog').addEventListener('click', () => { logVP.innerHTML=''; });
document.getElementById('btnLoadLogs').addEventListener('click', async () => {
  try {
    const d = await fetch('/api/logs/tail').then(r=>r.json());
    (d.lines||[]).forEach(l => appendLog(detectLevel(l), l));
    toast(`Loaded ${d.lines.length} lines`,'ok');
  } catch(e) { toast('Failed','err'); }
});

/* ═══════════════ LIVE BROWSER VIEW ==════════════════════════ */
async function refreshScreenshot() {
  try {
    const d = await fetch('/api/screenshot/latest-path').then(r=>r.json());
    if (d.path) updateLiveScreenshot(d.path);
  } catch(_) {}
}

function updateLiveScreenshot(pathStr) {
  const img    = document.getElementById('lvImg');
  const holder = document.getElementById('lvPlaceholder');
  const meta   = document.getElementById('lvMeta');
  if (pathStr) {
    img.src = pathStr + '?t=' + Date.now();
    img.style.display = 'block';
    holder.style.display = 'none';
    meta.textContent = 'Live • ' + new Date().toLocaleTimeString();
  } else {
    img.style.display = 'none'; 
    holder.style.display = 'block';
  }
}

socket.on('screenshot:new', (data) => {
  if (data && data.path) updateLiveScreenshot(data.path);
});

function startScreenshotRefresh() {
  refreshScreenshot();
}

document.getElementById('btnRefreshScreenshot').addEventListener('click', refreshScreenshot);
const intEl = document.getElementById('screenshotInterval');
if (intEl) {
  intEl.addEventListener('change', startScreenshotRefresh);
  // Auto-hide the interval selector as it is now strictly real-time via WebSockets
  intEl.style.display = 'none';
}

/* ═══════════════ SETTINGS TAB ══════════════════════════════ */
async function loadConfig() {
  try {
    const c = await fetch('/api/config').then(r=>r.json());
    document.getElementById('cfgJobTitle').value  = c.jobTitle  || c.searchKeywords?.[0] || '';
    document.getElementById('cfgLocation').value  = c.searchLocation || '';
    document.getElementById('cfgMaxJobs').value   = c.maxAppsPerRun || '';
    document.getElementById('cfgMaxPages').value  = c.maxPagesPerSearch || '';
    document.getElementById('cfgThreshold').value = c.scoreThreshold || '';
    document.getElementById('cfgAiModel').value   = c.aiModel || '';
    document.getElementById('cfgOllama').value    = c.ollamaBaseUrl || '';
    document.getElementById('cfgTimeout').value   = c.ollamaTimeout || '';
    document.getElementById('cfgSlowMo').value    = c.slowMo || '';
    document.getElementById('cfgDelayMin').value  = c.delayMin || '';
    document.getElementById('cfgDelayMax').value  = c.delayMax || '';
    document.getElementById('cfgHeadless').value  = String(c.headless === true);
    document.getElementById('cfgSkipAI').value    = String(c.skipAI === true);
    document.getElementById('cfgSafety').value    = String(c.safetyMode === true);
    document.getElementById('aiModelName').textContent = c.aiModel || 'unknown';
  } catch(e) { toast('Config load failed','err'); }
}

document.getElementById('btnSaveConfig').addEventListener('click', async () => {
  const body = {
    searchLocation:     document.getElementById('cfgLocation').value,
    maxAppsPerRun:      parseInt(document.getElementById('cfgMaxJobs').value)||20,
    maxPagesPerSearch:  parseInt(document.getElementById('cfgMaxPages').value)||5,
    scoreThreshold:     parseInt(document.getElementById('cfgThreshold').value)||40,
    aiModel:            document.getElementById('cfgAiModel').value,
    ollamaBaseUrl:      document.getElementById('cfgOllama').value,
    ollamaTimeout:      parseInt(document.getElementById('cfgTimeout').value)||60000,
    slowMo:             parseInt(document.getElementById('cfgSlowMo').value)||20,
    delayMin:           parseInt(document.getElementById('cfgDelayMin').value)||1500,
    delayMax:           parseInt(document.getElementById('cfgDelayMax').value)||3000,
    headless:           document.getElementById('cfgHeadless').value === 'true',
    skipAI:             document.getElementById('cfgSkipAI').value === 'true',
    safetyMode:         document.getElementById('cfgSafety').value === 'true',
  };
  try {
    const r = await fetch('/api/config',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d = await r.json();
    if (d.success) toast('Settings saved!','ok'); else toast('Error: '+d.error,'err');
  } catch(e) { toast('Error','err'); }
});
document.getElementById('btnRefreshConfig').addEventListener('click', loadConfig);

/* ═══════════════ KEYWORDS TAB ══════════════════════════════ */
let keywords = { required:[], preferred:[], excluded:[] };

async function loadKeywords() {
  try {
    keywords = await fetch('/api/keywords').then(r=>r.json());
    renderTags('req',  keywords.required,  'reqTagArea');
    renderTags('pref', keywords.preferred, 'prefTagArea');
    renderTags('excl', keywords.excluded,  'exclTagArea');
  } catch(e) { toast('Failed to load keywords','err'); }
}

function renderTags(type, list, areaId) {
  const area = document.getElementById(areaId);
  area.innerHTML = (list||[]).map(kw =>
    `<span class="tag ${type}">${esc(kw)} <span class="tag-x" onclick="removeKeyword('${type}','${esc(kw)}')">×</span></span>`
  ).join('');
}

window.removeKeyword = function(type, kw) {
  const key = type==='req'?'required':type==='pref'?'preferred':'excluded';
  keywords[key] = keywords[key].filter(k=>k!==kw);
  const areaMap = {req:'reqTagArea',pref:'prefTagArea',excl:'exclTagArea'};
  renderTags(type, keywords[key], areaMap[type]);
};

function addKeyword(type, inputId, area) {
  const input = document.getElementById(inputId);
  const val   = input.value.trim(); if (!val) return;
  const key   = type==='req'?'required':type==='pref'?'preferred':'excluded';
  if (!keywords[key].includes(val)) { keywords[key].push(val); renderTags(type, keywords[key], area); }
  input.value='';
}

document.getElementById('btnAddReq').addEventListener('click',  () => addKeyword('req','reqInput','reqTagArea'));
document.getElementById('btnAddPref').addEventListener('click',  () => addKeyword('pref','prefInput','prefTagArea'));
document.getElementById('btnAddExcl').addEventListener('click',  () => addKeyword('excl','exclInput','exclTagArea'));
['reqInput','prefInput','exclInput'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key!=='Enter') return;
    if (id==='reqInput')  addKeyword('req','reqInput','reqTagArea');
    if (id==='prefInput') addKeyword('pref','prefInput','prefTagArea');
    if (id==='exclInput') addKeyword('excl','exclInput','exclTagArea');
  });
});

document.getElementById('btnSaveKeywords').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/keywords',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(keywords)});
    const d = await r.json();
    if (d.success) toast('Keywords saved!','ok'); else toast('Error: '+d.error,'err');
  } catch(e) { toast('Error','err'); }
});
document.getElementById('btnRefreshKeywords').addEventListener('click', loadKeywords);

/* ═══════════════ PROFILE TAB ════════════════════════════════ */
async function loadProfile() {
  try {
    const [p, c] = await Promise.all([
      fetch('/api/profile').then(r=>r.json()),
      fetch('/api/config').then(r=>r.json()),
    ]);
    document.getElementById('pfName').value        = p.name         ||'';
    document.getElementById('pfEmail').value       = p.email        ||'';
    document.getElementById('pfPhone').value       = p.phone        ||'';
    document.getElementById('pfLocation').value    = p.currentLocation||'';
    document.getElementById('pfResumePath').value  = c.resumePath   ||'';
    document.getElementById('pfLinkedIn').value    = p.linkedIn     ||'';
    document.getElementById('pfGitHub').value      = p.github       ||'';
    document.getElementById('pfPortfolio').value   = p.portfolio    ||'';
    document.getElementById('pfCompany').value     = p.currentCompany||'';
    document.getElementById('pfRole').value        = p.currentRole  ||'';
    document.getElementById('pfYears').value       = p.yearsExperience||'';
    document.getElementById('pfSalary').value      = p.salary       ||'';
    document.getElementById('pfNotice').value      = p.noticePeriod ||'';
    document.getElementById('pfSummary').value     = p.summary      ||'';
    document.getElementById('pfCoverLetter').value = p.coverLetter  ||'';
  } catch(e) { toast('Profile load failed','err'); }
}

document.getElementById('btnSaveProfile').addEventListener('click', async () => {
  const profile = {
    name:            document.getElementById('pfName').value,
    email:           document.getElementById('pfEmail').value,
    phone:           document.getElementById('pfPhone').value,
    currentLocation: document.getElementById('pfLocation').value,
    linkedIn:        document.getElementById('pfLinkedIn').value,
    github:          document.getElementById('pfGitHub').value,
    portfolio:       document.getElementById('pfPortfolio').value,
    currentCompany:  document.getElementById('pfCompany').value,
    currentRole:     document.getElementById('pfRole').value,
    yearsExperience: document.getElementById('pfYears').value,
    salary:          document.getElementById('pfSalary').value,
    noticePeriod:    document.getElementById('pfNotice').value,
    summary:         document.getElementById('pfSummary').value,
    coverLetter:     document.getElementById('pfCoverLetter').value,
  };
  const resumePath = document.getElementById('pfResumePath').value.trim();
  try {
    const [r1, r2] = await Promise.all([
      fetch('/api/profile',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(profile)}),
      resumePath ? fetch('/api/config',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({resumePath})}) : Promise.resolve({json:()=>({})}),
    ]);
    const [d1] = await Promise.all([r1.json(), r2.json ? r2.json() : r2]);
    if (d1.success) toast('Profile saved! ✅','ok'); else toast('Error: '+d1.error,'err');
  } catch(e) { toast('Error','err'); }
});
document.getElementById('btnRefreshProfile').addEventListener('click', loadProfile);

/* ═══════════════ SELECTORS TAB ════════════════════════════ */
async function loadSelectors() {
  try {
    const s = await fetch('/api/selectors').then(r=>r.json());
    const grid = document.getElementById('selectorsGrid');
    const labels = {
      jobCard:'Job Card', jobTitle:'Job Title', companyName:'Company Name', applyButton:'Apply Button',
      nextPage:'Next Page', nameField:'Name Field', emailField:'Email Field', phoneField:'Phone Field',
      coverLetterField:'Cover Letter', resumeUpload:'Resume Upload', submitButton:'Submit Button',
      successIndicator:'Success Indicator', applyModal:'Apply Modal',
    };
    grid.innerHTML = Object.entries(s).map(([key,val]) =>
      `<div class="selector-row">
        <div class="selector-key">${labels[key]||key}</div>
        <input class="input" id="sel-${key}" value="${esc(val||'')}" placeholder="${key}"/>
      </div>`
    ).join('');
  } catch(e) { toast('Selectors load failed','err'); }
}

document.getElementById('btnSaveSelectors').addEventListener('click', async () => {
  const inputs = document.querySelectorAll('[id^="sel-"]');
  const body = {};
  inputs.forEach(el => { body[el.id.replace('sel-','')] = el.value.trim(); });
  try {
    const r = await fetch('/api/selectors',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d = await r.json();
    if (d.success) toast('Selectors saved!','ok'); else toast('Error: '+d.error,'err');
  } catch(e) { toast('Error','err'); }
});
document.getElementById('btnRefreshSelectors').addEventListener('click', loadSelectors);

/* ═══════════════ BLOCKLIST TAB ════════════════════════════ */
async function loadBlocklist() {
  try {
    const list = await fetch('/api/blocklist').then(r=>r.json());
    const el = document.getElementById('blockList');
    const empty = document.getElementById('blockEmpty');
    document.getElementById('nc-block').textContent = list.length || '–';
    if (!list.length) { el.innerHTML=''; empty.style.display='block'; return; }
    empty.style.display='none';
    el.innerHTML = list.map(c =>
      `<li class="block-item"><span>🚫 ${esc(c)}</span><button class="btn-icon-del" onclick="removeBlock('${esc(c)}')">Remove</button></li>`
    ).join('');
  } catch(e) { toast('Blocklist load failed','err'); }
}

window.removeBlock = async function(company) {
  const r = await fetch(`/api/blocklist/${encodeURIComponent(company)}`,{method:'DELETE'});
  const d = await r.json();
  if (d.success) { loadBlocklist(); toast('Removed','ok'); } else toast('Error','err');
};

document.getElementById('btnAddBlock').addEventListener('click', async () => {
  const company = document.getElementById('blockInput').value.trim(); if(!company) return;
  const r = await fetch('/api/blocklist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company})});
  const d = await r.json();
  if (d.success) { document.getElementById('blockInput').value=''; loadBlocklist(); toast(`Blocked: ${company}`,'ok'); }
  else toast('Error: '+d.error,'err');
});
document.getElementById('blockInput').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('btnAddBlock').click(); });

/* ═══════════════ BOT CONTROLS ══════════════════════════════ */
const botDot    = document.getElementById('botDot');
const botLabel  = document.getElementById('botLabel');
const botUptime = document.getElementById('botUptime');
const btnStart   = document.getElementById('btnStart');
const btnStop    = document.getElementById('btnStop');
const btnRestart = document.getElementById('btnRestart');
let uptimeInterval = null;

function setBotUI(state) {
  const status = state.status;
  botDot.className = `bot-dot ${status}`;
  botLabel.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  const running = status === 'running' || status === 'stopping';
  btnStart.disabled   = running;
  btnStop.disabled    = !running;
  btnRestart.disabled = status === 'idle';
  if (status === 'running' && state.startedAt) {
    clearInterval(uptimeInterval);
    const start = new Date(state.startedAt);
    uptimeInterval = setInterval(() => {
      const d = Math.floor((Date.now()-start)/1000);
      botUptime.textContent = d<60 ? `${d}s` : d<3600 ? `${Math.floor(d/60)}m ${d%60}s` : `${Math.floor(d/3600)}h ${Math.floor((d%3600)/60)}m`;
    }, 1000);
  } else { clearInterval(uptimeInterval); botUptime.textContent=''; }
}

socket.on('bot:status', setBotUI);

async function botAction(action, payload = {}) {
  try {
    const r = await fetch(`/api/bot/${action}`,{
      method:'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await r.json();
    if (d.error) toast('Bot error: '+d.error,'err');
    else { appendLog('info',`Bot ${action}: ${d.message||'OK'}`); }
  } catch(e) { toast('Bot action failed','err'); }
}

btnStart.addEventListener('click',   () => { botAction('start');   toast('Starting bot…','info'); });
btnStop.addEventListener('click',    () => { botAction('stop');    toast('Stopping bot…','info'); });
btnRestart.addEventListener('click', () => { botAction('restart'); toast('Restarting…','info'); });

// ─── Quick Action Buttons ──────────────────────────────────────────────────

const portalBtns = [
  document.getElementById('btnApplyNaukri'),
  document.getElementById('btnApplyLinkedIn'),
  document.getElementById('btnApplyIndeed'),
];
const btnApplyCompany = document.getElementById('btnApplyCompany');
const companyUrlInput = document.getElementById('companyUrlInput');
const btnCompanyUrlClear = document.getElementById('btnCompanyUrlClear');
const companyBtnSub   = document.getElementById('companyBtnSub');
const btnRunAll   = document.getElementById('btnRunAll');
const btnSaveAuth = document.getElementById('btnSaveAuth');
const btnStopBot  = document.getElementById('btnStopBot');

/** Wire per-portal buttons (Naukri / LinkedIn / Indeed) */
portalBtns.forEach(btn => {
  if (!btn) return;
  btn.addEventListener('click', () => {
    const platform = btn.dataset.platform;
    botAction('start', { platform });
    toast(`Starting ${platform.charAt(0).toUpperCase() + platform.slice(1)}…`, 'info');
  });
});

/** Company Sites — reads URL input and passes it */
if (btnApplyCompany) {
  btnApplyCompany.addEventListener('click', () => {
    const url = companyUrlInput ? companyUrlInput.value.trim() : '';
    const payload = { platform: 'company' };
    if (url) payload.url = url;
    botAction('start', payload);
    toast(url ? `Starting Company apply on ${url}…` : 'Starting Company Sites worker…', 'info');
  });
}

/** Live URL preview in Company button subtitle */
if (companyUrlInput && companyBtnSub) {
  companyUrlInput.addEventListener('input', () => {
    const v = companyUrlInput.value.trim();
    try {
      const host = v ? new URL(v).hostname.replace(/^www\./, '') : '';
      companyBtnSub.textContent = host ? `→ ${host}` : 'Direct apply';
    } catch (_) {
      companyBtnSub.textContent = v ? v.substring(0, 24) + '…' : 'Direct apply';
    }
  });
}
if (btnCompanyUrlClear) {
  btnCompanyUrlClear.addEventListener('click', () => {
    if (companyUrlInput) companyUrlInput.value = '';
    if (companyBtnSub)   companyBtnSub.textContent = 'Direct apply';
  });
}

/** Run all portals */
if (btnRunAll) {
  btnRunAll.addEventListener('click', () => {
    botAction('start', {});
    toast('Running all portals sequentially…', 'info');
  });
}

/** Save Auth — spawns saveAuth.js */
if (btnSaveAuth) {
  btnSaveAuth.addEventListener('click', async () => {
    btnSaveAuth.disabled = true;
    const origLabel = btnSaveAuth.querySelector('.qa-label');
    if (origLabel) origLabel.textContent = '⏳ Launching…';
    toast('Launching save-auth browser — complete login in the opened window', 'info');
    try {
      const r = await fetch('/api/bot/save-auth', { method: 'POST' });
      const d = await r.json();
      if (d.success || d.status === 'launched') {
        toast('🔑 Auth browser opened — log in, then close it', 'ok');
        appendLog('info', '🔑 save-auth launched — complete login in the opened browser');
      } else {
        toast('save-auth: ' + (d.error || 'unknown error'), 'err');
      }
    } catch (e) {
      toast('Save Auth failed: ' + e.message, 'err');
    }
    if (origLabel) origLabel.textContent = 'Save Auth';
    btnSaveAuth.disabled = false;
  });
}

/** Stop from Quick Actions card */
if (btnStopBot) {
  btnStopBot.addEventListener('click', () => {
    botAction('stop');
    toast('Stopping bot…', 'info');
  });
}

/** Keep quick-action buttons in sync with bot state */
const _origSetBotUI = setBotUI;
setBotUI = function(state) {
  _origSetBotUI(state);
  const running = state.status === 'running' || state.status === 'stopping';
  portalBtns.forEach(b => { if (b) b.disabled = running; });
  if (btnApplyCompany) btnApplyCompany.disabled = running;
  if (btnRunAll)       btnRunAll.disabled        = running;
  if (btnStopBot)      btnStopBot.disabled       = !running;
  if (companyUrlInput) companyUrlInput.disabled  = running;
  // Save Auth is always enabled
};

/* ══════ UTILS ═════════════════════════════════════════════ */
function jobLinkCell(j) {
  const url = j.url || '';
  // If we have a real URL, parse and label it
  if (url) {
    try {
      const u = new URL(url);
      const isNaukri = u.hostname.includes('naukri.com');
      const label = isNaukri ? 'Naukri' : u.hostname.replace(/^www\./, '');
      const icon  = isNaukri ? '🏢' : '🔗';
      const color = isNaukri ? 'var(--acc2)' : '#f59e0b';
      return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}" style="color:${color};font-size:12px;white-space:nowrap">${icon} ${esc(label)}</a>`;
    } catch (_) {
      return `<a href="${esc(url)}" target="_blank" style="color:var(--acc2);font-size:12px;white-space:nowrap">🔗 Open</a>`;
    }
  }
  // Fallback: generate a Naukri search URL from the job title
  const title = (j.title || '').trim();
  if (title && title !== 'Unknown') {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const searchUrl = `https://www.naukri.com/${slug}-jobs`;
    return `<a href="${esc(searchUrl)}" target="_blank" rel="noopener noreferrer" title="Search Naukri for: ${esc(title)}" style="color:var(--tx3);font-size:12px;white-space:nowrap">🔍 Search</a>`;
  }
  return '–';
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function scoreBarStr(score) {
  const n = parseInt(score)||0;
  const c = n>=80?'#10b981':n>=60?'#3b82f6':n>=40?'#f59e0b':'#ef4444';
  return `<div class="sbar"><div class="sbar-bg"><div class="sbar-fill" style="width:${n}%;background:${c}"></div></div><span class="sbar-num">${n}</span></div>`;
}

function statusBadgeStr(s) {
  const map = { success:'b-green', applied:'b-green', skipped:'b-amber', failed:'b-red', pending:'b-muted', external:'b-blue' };
  const txt = { success:'✅ Applied',applied:'✅ Applied',skipped:'⏭ Skipped',failed:'❌ Failed',pending:'⏳ Pending',external:'🔗 External' };
  return `<span class="badge ${map[s]||'b-muted'}">${txt[s]||s}</span>`;
}

function fmtDate(d) {
  if (!d) return '–';
  const dt = new Date(d);
  return isNaN(dt) ? d : dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
}

function detectLevel(msg) {
  if (/error|fail|exception/i.test(msg)) return 'error';
  if (/warn|skip/i.test(msg))  return 'warn';
  if (/applied|success|✅/i.test(msg)) return 'success';
  return 'info';
}

/* ══════ INIT ══════════════════════════════════════════════ */
(async () => {
  await loadDashboard();
  // Fetch initial bot status
  try { const s = await fetch('/api/bot/status').then(r=>r.json()); setBotUI(s); } catch(_) {}
  // Auto-refresh stats every 30s
  setInterval(loadDashboard, 30000);
})();
