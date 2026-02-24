'use strict';
/* ═══════════════════════════════════════════════════════════════
   AutoApply Dashboard — app.js
   Chart.js + Socket.io  |  Real-time job tracking
   ═══════════════════════════════════════════════════════════════ */

// ── Chart.js global defaults ────────────────────────────────────
Chart.defaults.color = '#5a6a82';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.borderColor = '#1e2530';

const COLORS = {
  green:  '#39ff14',
  yellow: '#f0d000',
  red:    '#ff4444',
  blue:   '#00c8ff',
  purple: '#a855f7',
  orange: '#f97316',
};

// ── State ────────────────────────────────────────────────────────
let allJobs = [];
let trendChart, donutChart, companiesChart, scoreChart;

// ════════════════════════════════════════════════════════════════
//  VIEW SWITCHING
// ════════════════════════════════════════════════════════════════
function switchView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  document.getElementById(`view-${id}`).classList.add('active');
  const navItem = document.querySelector(`[data-view="${id}"]`);
  if (navItem) navItem.classList.add('active');

  const titles = { dashboard: 'JOB APPLICATION TRACKER', jobs: 'ALL JOBS', live: 'LIVE FEED', learning: '🧠 LEARNING LIST' };
  document.getElementById('page-title').textContent = titles[id] || '';

  if (id === 'jobs') loadJobsTable();
  if (id === 'learning') loadLearningList();

  addDebugLog(`View switched to: ${id}`, 'info');
}

// ════════════════════════════════════════════════════════════════
//  STATS CARDS
// ════════════════════════════════════════════════════════════════
async function loadStats() {
  try {
    const s = await fetchJSON('/api/stats');
    const total    = s.total_scanned || 0;
    const applied  = s.success_count || 0;
    const skipped  = s.total_skipped || 0;
    const errors   = s.fail_count    || 0;
    const rate     = total > 0 ? Math.round((applied / total) * 100) : 0;

    animateNumber('stat-scanned', total);
    animateNumber('stat-applied', applied);
    animateNumber('stat-skipped', skipped);
    animateNumber('stat-errors',  errors);
    document.getElementById('stat-applied-rate').textContent = `${rate}% success rate`;
    setLastUpdated();
  } catch (e) { console.warn('Stats load failed', e); }
}

function animateNumber(id, target) {
  const el = document.getElementById(id);
  const from = parseInt(el.textContent) || 0;
  const dur = 600, steps = 30, step = Math.ceil(dur / steps);
  let i = 0;
  const inc = (target - from) / steps;
  const timer = setInterval(() => {
    i++;
    el.textContent = Math.round(from + inc * i);
    if (i >= steps) { clearInterval(timer); el.textContent = target; }
  }, step);
}

// ════════════════════════════════════════════════════════════════
//  TREND CHART  (line)
// ════════════════════════════════════════════════════════════════
async function loadTrendChart() {
  try {
    let data = [];
    try { data = await fetchJSON('/api/jobs/trend'); } catch (_) {}

    // Fallback: build trend from /api/jobs/all when trend endpoint missing
    if (!data.length) {
      try {
        const all = await fetchJSON('/api/jobs/all');
        const byDay = {};
        all.forEach(j => {
          const day = (j.created_at || '').slice(0, 10);
          if (!day) return;
          if (!byDay[day]) byDay[day] = { day, applied: 0, skipped: 0, failed: 0 };
          if (j.apply_status === 'success') byDay[day].applied++;
          else if (j.apply_status === 'skipped') byDay[day].skipped++;
          else if (j.apply_status === 'failed') byDay[day].failed++;
        });
        data = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
      } catch (_) {}
    }

    if (!data.length) { showEmpty('trendChart', 'No trend data yet'); return; }

    const labels  = data.map(r => formatDay(r.day));
    const applied = data.map(r => r.applied);
    const skipped = data.map(r => r.skipped);
    const failed  = data.map(r => r.failed);

    const gGreen  = makeGradient('trendChart', 'rgba(57,255,20,.5)', 'rgba(57,255,20,0)');
    const gYellow = makeGradient('trendChart', 'rgba(240,208,0,.25)', 'rgba(240,208,0,0)');
    const gRed    = makeGradient('trendChart', 'rgba(255,68,68,.25)', 'rgba(255,68,68,0)');

    if (trendChart) trendChart.destroy();
    trendChart = new Chart(document.getElementById('trendChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Applied', data: applied,
            borderColor: COLORS.green, backgroundColor: gGreen,
            borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: COLORS.green,
            fill: true, tension: 0.4,
          },
          {
            label: 'Skipped', data: skipped,
            borderColor: COLORS.yellow, backgroundColor: gYellow,
            borderWidth: 2, pointRadius: 3, pointBackgroundColor: COLORS.yellow,
            fill: true, tension: 0.4, borderDash: [4,3],
          },
          {
            label: 'Failed', data: failed,
            borderColor: COLORS.red, backgroundColor: gRed,
            borderWidth: 2, pointRadius: 3, pointBackgroundColor: COLORS.red,
            fill: true, tension: 0.4,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: tooltipStyle() },
        scales: {
          x: { grid: { color: '#1e2530' }, ticks: { font: { size: 11 } } },
          y: {
            grid: { color: '#1e2530' }, beginAtZero: true,
            ticks: { stepSize: 1, font: { size: 11 } },
          },
        },
      },
    });
  } catch (e) { console.warn('Trend chart failed', e); }
}

// ════════════════════════════════════════════════════════════════
//  DONUT CHART  (status breakdown)
// ════════════════════════════════════════════════════════════════
async function loadDonutChart() {
  try {
    const s = await fetchJSON('/api/stats');
    const applied = s.success_count || 0;
    const failed  = s.fail_count    || 0;
    const skipped = s.total_skipped || 0;

    if (!applied && !failed && !skipped) { showEmpty('donutChart', 'No jobs yet'); return; }

    if (donutChart) donutChart.destroy();
    donutChart = new Chart(document.getElementById('donutChart'), {
      type: 'doughnut',
      data: {
        labels: ['Applied', 'Failed', 'Skipped'],
        datasets: [{
          data: [applied, failed, skipped],
          backgroundColor: [COLORS.green, COLORS.red, COLORS.yellow],
          borderColor: '#111418',
          borderWidth: 3,
          hoverOffset: 8,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: { display: false },
          tooltip: tooltipStyle(),
        },
      },
    });

    // Render custom legend
    const legend = document.getElementById('donut-legend');
    const items = [
      { label: 'Applied', color: COLORS.green, val: applied },
      { label: 'Failed',  color: COLORS.red,   val: failed  },
      { label: 'Skipped', color: COLORS.yellow, val: skipped },
    ];
    legend.innerHTML = items.map(it =>
      `<div class="leg-item">
        <div class="swatch" style="background:${it.color}"></div>
        ${it.label} <strong style="color:${it.color};margin-left:4px">${it.val}</strong>
       </div>`
    ).join('');
  } catch (e) { console.warn('Donut chart failed', e); }
}

// ════════════════════════════════════════════════════════════════
//  COMPANIES CHART  (horizontal bar)
// ════════════════════════════════════════════════════════════════
async function loadCompaniesChart() {
  try {
    let data = [];
    try { data = await fetchJSON('/api/jobs/top-companies'); } catch (_) {}

    // Fallback: compute from /api/jobs/all
    if (!data.length) {
      try {
        const all = await fetchJSON('/api/jobs/all');
        const byCompany = {};
        all.forEach(j => {
          if (!j.company) return;
          if (!byCompany[j.company]) byCompany[j.company] = { company: j.company, total: 0, applied: 0 };
          byCompany[j.company].total++;
          if (j.apply_status === 'success') byCompany[j.company].applied++;
        });
        data = Object.values(byCompany).sort((a, b) => b.total - a.total).slice(0, 8);
      } catch (_) {}
    }

    if (!data.length) { showEmpty('companiesChart', 'No company data yet'); return; }

    if (companiesChart) companiesChart.destroy();
    companiesChart = new Chart(document.getElementById('companiesChart'), {
      type: 'bar',
      data: {
        labels: data.map(r => r.company || 'Unknown'),
        datasets: [
          {
            label: 'Total Seen',
            data: data.map(r => r.total),
            backgroundColor: 'rgba(0,200,255,0.15)',
            borderColor: COLORS.blue,
            borderWidth: 1.5,
            borderRadius: 5,
          },
          {
            label: 'Applied',
            data: data.map(r => r.applied),
            backgroundColor: 'rgba(57,255,20,0.25)',
            borderColor: COLORS.green,
            borderWidth: 1.5,
            borderRadius: 5,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: tooltipStyle() },
        scales: {
          x: { grid: { color: '#1e2530' }, beginAtZero: true, ticks: { font: { size: 10 } } },
          y: { grid: { color: 'transparent' }, ticks: { font: { size: 10 } } },
        },
      },
    });
  } catch (e) { console.warn('Companies chart failed', e); }
}

// ════════════════════════════════════════════════════════════════
//  SCORE DISTRIBUTION CHART  (bar)
// ════════════════════════════════════════════════════════════════
async function loadScoreChart() {
  try {
    let data = [];
    try { data = await fetchJSON('/api/jobs/score-dist'); } catch (_) {}

    // Fallback: compute from /api/jobs/all
    if (!data.length) {
      try {
        const all = await fetchJSON('/api/jobs/all');
        const buckets = { '90-100':0,'75-89':0,'60-74':0,'40-59':0,'Below 40':0,'Not scored':0 };
        all.forEach(j => {
          const s = j.score || 0;
          if (s === 0) buckets['Not scored']++;
          else if (s >= 90) buckets['90-100']++;
          else if (s >= 75) buckets['75-89']++;
          else if (s >= 60) buckets['60-74']++;
          else if (s >= 40) buckets['40-59']++;
          else buckets['Below 40']++;
        });
        data = Object.entries(buckets).map(([range, count]) => ({ range, count }));
      } catch (_) {}
    }

    data = data.filter(d => d.count > 0);
    if (!data.length) { showEmpty('scoreChart', 'No score data yet'); return; }

    const order = ['90-100','75-89','60-74','40-59','Below 40','Not scored'];
    const sorted = order.map(r => data.find(d => d.range === r) || { range: r, count: 0 }).filter(d => d.count > 0);

    const colorMap = { '90-100':'#39ff14','75-89':'#7fff00','60-74':'#f0d000','40-59':'#f97316','Below 40':'#ff4444','Not scored':'#5a6a82' };
    const barColors = sorted.map(d => colorMap[d.range] || '#5a6a82');

    if (scoreChart) scoreChart.destroy();
    scoreChart = new Chart(document.getElementById('scoreChart'), {
      type: 'bar',
      data: {
        labels: sorted.map(r => r.range),
        datasets: [{
          label: 'Jobs',
          data: sorted.map(r => r.count),
          backgroundColor: barColors.map(c => c + '44'),
          borderColor: barColors,
          borderWidth: 2,
          borderRadius: 5,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: tooltipStyle() },
        scales: {
          x: { grid: { color: 'transparent' }, ticks: { font: { size: 10 } } },
          y: { grid: { color: '#1e2530' }, beginAtZero: true, ticks: { stepSize: 1, font: { size: 10 } } },
        },
      },
    });
  } catch (e) { console.warn('Score chart failed', e); }
}

// ════════════════════════════════════════════════════════════════
//  JOBS TABLE
// ════════════════════════════════════════════════════════════════
async function loadJobsTable() {
  try {
    allJobs = await fetchJSON('/api/jobs/all');
    renderJobsTable(allJobs);
  } catch (e) { console.warn('Jobs table failed', e); }
}

function renderJobsTable(jobs) {
  const tbody = document.getElementById('jobs-tbody');
  if (!jobs.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#5a6a82;padding:40px">No jobs yet</td></tr>';
    return;
  }
  tbody.innerHTML = jobs.map(j => {
    const score = j.score || 0;
    const scoreColor = score >= 80 ? COLORS.green : score >= 60 ? COLORS.yellow : COLORS.red;
    const status = j.apply_status || 'pending';
    const chip = `<span class="status-chip ${status}">${statusEmoji(status)} ${status}</span>`;
    return `<tr>
      <td><strong>${esc(j.title)}</strong></td>
      <td>${esc(j.company)}</td>
      <td><span class="score-badge" style="background:${scoreColor}22;color:${scoreColor}">${score}</span></td>
      <td>${chip}</td>
      <td>${fmtDt(j.created_at)}</td>
      <td>${j.applied_at ? fmtDt(j.applied_at) : '<span style="color:#3a4a5c">—</span>'}</td>
    </tr>`;
  }).join('');
}

function filterJobs() {
  const q      = document.getElementById('jobs-search').value.toLowerCase();
  const status = document.getElementById('jobs-status-filter').value;
  const filtered = allJobs.filter(j => {
    const matchQ = !q || (j.title||'').toLowerCase().includes(q) || (j.company||'').toLowerCase().includes(q);
    const matchS = !status || j.apply_status === status;
    return matchQ && matchS;
  });
  renderJobsTable(filtered);
}

// ════════════════════════════════════════════════════════════════
//  LEARNING LIST
// ════════════════════════════════════════════════════════════════
async function loadLearningList() {
  try {
    const rows = await fetchJSON('/api/learning');
    const tbody = document.getElementById('learning-tbody');
    const pending = rows.filter(r => !r.answered).length;

    // Update subtitle
    const sub = document.getElementById('learning-subtitle');
    sub.textContent = `${rows.length} total question${rows.length !== 1 ? 's' : ''} · ${pending} pending`;

    // Update nav badge
    updateLearningBadge(pending);

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#5a6a82;padding:48px">
        <div style="font-size:32px;margin-bottom:10px">🧠</div>
        No questions yet. Run the bot to start collecting unanswered questions.
      </td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const answered = Number(r.answered) === 1;
      const statusPill = answered
        ? `<span class="learn-pill answered">✅ Answered</span>`
        : `<span class="learn-pill pending">⏳ Pending</span>`;

      let options = [];
      try { options = JSON.parse(r.options || '[]'); } catch (_) {}
      const optHint = options.length
        ? `<div class="learn-options">Options: ${options.map(o => `<code>${esc(o)}</code>`).join(', ')}</div>`
        : '';

      const actionCell = answered
        ? `<span class="learn-saved-answer">${esc(r.answer)}</span>
           <button class="learn-edit-btn" onclick="editLearningAnswer(${r.id}, '${esc(r.answer).replace(/'/g, '&#39;')}')">✏️ Edit</button>`
        : `<div class="learn-input-row">
             <input id="li-${r.id}" class="learn-input" type="text" placeholder="Type answer…" />
             <button class="learn-save-btn" onclick="saveLearningAnswer(${r.id})">Save</button>
           </div>`;

      return `<tr>
        <td>
          <div class="learn-question">${esc(r.question)}</div>
          ${optHint}
          <div class="learn-meta">Job: ${esc(r.source_job || '—')}</div>
        </td>
        <td><code class="field-type-badge">${esc(r.field_type || 'text')}</code></td>
        <td><span class="asked-badge">${r.asked_count}</span></td>
        <td>${statusPill}</td>
        <td>${actionCell}</td>
      </tr>`;
    }).join('');
  } catch (e) { console.warn('Learning list failed', e); }
}

function updateLearningBadge(count) {
  const badge = document.getElementById('learning-badge');
  if (!badge) return;
  if (count > 0) {
    badge.style.display = 'inline-block';
    badge.textContent = count;
  } else {
    badge.style.display = 'none';
  }
}

async function saveLearningAnswer(id) {
  const input = document.getElementById(`li-${id}`);
  if (!input) return;
  const answer = input.value.trim();
  if (!answer) { input.style.borderColor = '#ff4444'; return; }
  try {
    await fetch(`/api/learning/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
    loadLearningList(); // Refresh
  } catch (e) { console.warn('Save learning answer failed', e); }
}

function editLearningAnswer(id, current) {
  // Replace the saved-answer display with an editable input
  const cell = document.querySelector(`button[onclick="editLearningAnswer(${id}, '${current.replace(/'/g, '&#39;')}')"]`).parentElement;
  cell.innerHTML = `<div class="learn-input-row">
    <input id="li-${id}" class="learn-input" type="text" value="${esc(current)}" />
    <button class="learn-save-btn" onclick="saveLearningAnswer(${id})">Save</button>
  </div>`;
  document.getElementById(`li-${id}`).focus();
}

// Refresh just the pending count badge without full table reload
async function loadLearningBadge() {
  try {
    const rows = await fetchJSON('/api/learning');
    const pending = rows.filter(r => !r.answered).length;
    updateLearningBadge(pending);
  } catch (_) {}
}

async function triggerSelfLearn() {
  const btn = document.getElementById('selflearn-btn');
  const status = document.getElementById('selflearn-status');
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  btn.textContent = '🔄 Running…';
  status.textContent = '';

  try {
    const res = await fetch('/api/learning/self-learn', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'already_running') {
      status.textContent = '⏳ Already running in background…';
    } else {
      status.textContent = `✅ Auto-answered ${data.answered || 0} of ${data.processed || 0} question(s)`;
      await loadLearningList();
    }
  } catch (err) {
    status.textContent = '❌ Self-learn failed: ' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 Self-Learn';
    // Clear status message after 6 seconds
    setTimeout(() => { if (status) status.textContent = ''; }, 6000);
  }
}

// ════════════════════════════════════════════════════════════════
//  LIVE FEED  ( Socket.io )
// ════════════════════════════════════════════════════════════════
function setupSocket() {
  const socket = io();

  socket.on('connect', () => {
    setStatus('online', 'Online');
    showDot(true);
    showToast('Dashboard connected to worker', 'success');
    addDebugLog('Socket.io connection established', 'info');
  });
  socket.on('disconnect', () => {
    setStatus('offline', 'Offline');
    showDot(false);
    showToast('Dashboard disconnected', 'error');
    addDebugLog('Socket.io connection lost', 'error');
  });

  // Refresh stats + charts on any worker event
  const refresh = () => { loadStats(); loadDonutChart(); };

  socket.on('stats:update',  refresh);
  socket.on('init:stats',    s => updateStatsFromSocket(s));
  socket.on('worker:start',  () => {
    addLiveEvent('scanning', '🚀 Worker started', 'AutoApply');
    showToast('Worker process started', 'info');
    addDebugLog('Worker process initiated');
  });
  socket.on('worker:done',   d => {
    addLiveEvent('applied', `✅ Session done – ${d.appliedCount || 0} applied`, '');
    showToast(`Session completed: ${d.appliedCount || 0} jobs applied`, 'success');
    addDebugLog(`Worker session finished. Total applied: ${d.appliedCount}`);
  });
  socket.on('job:scanned',   d => {
    addLiveEvent('scanning', `🔍 Scanning: ${d.title}`, d.company);
    addDebugLog(`Job found: ${d.title} @ ${d.company}`);
  });
  socket.on('job:analyzing', d => {
    addLiveEvent('scanning', `🤖 Analyzing: ${d.title}`, d.company);
    addDebugLog(`AI Analyzing job: ${d.title}`);
  });
  socket.on('job:applying',  d => {
    addLiveEvent('scanning', `📋 Applying: ${d.title}`, d.company, 'blue');
    addDebugLog(`Attempting to apply: ${d.title}`);
  });
  socket.on('job:applied',   d => {
    addLiveEvent('applied', `✅ Applied [${d.appliedCount}]: ${d.title}`, d.company);
    showToast(`Successfully applied to ${d.company}`, 'success');
    addDebugLog(`Application SUCCESS: ${d.title}`, 'log');
    refresh();
  });
  socket.on('job:skipped',   d => {
    addLiveEvent('skipped', `⏭ Skipped: ${d.title} (score: ${d.score})`, d.company);
    addDebugLog(`Job SKIPPED (Score ${d.score}): ${d.title}`, 'warn');
  });
  socket.on('job:failed',    d => {
    addLiveEvent('failed',  `❌ Failed: ${d.title}`, d.company);
    showToast(`Failed to apply for ${d.title}`, 'error');
    addDebugLog(`Application FAILED: ${d.title}`, 'error');
  });
  socket.on('worker:error',  d => {
    addLiveEvent('failed', `💥 Error: ${d.message}`, '');
    showToast(`Worker Error: ${d.message}`, 'error');
    addDebugLog(`CRITICAL ERROR: ${d.message}`, 'error');
  });

  // Self-learn cycle completion event
  socket.on('selflearn:done', d => {
    if (d && d.answered > 0) {
      addLiveEvent('applied', `🤖 Self-Learn: auto-answered ${d.answered}/${d.processed} question(s)`, 'Learning System');
      // If user is on the learning list view, refresh it
      if (document.getElementById('view-learning').classList.contains('active')) {
        loadLearningList();
      }
      // Update badge count
      loadLearningBadge();
    }
  });
}

function addLiveEvent(type, title, company, forceType) {
  const feed = document.getElementById('live-feed');
  // Remove placeholder if present
  const placeholder = feed.querySelector('.live-placeholder');
  if (placeholder) placeholder.remove();

  const el = document.createElement('div');
  el.className = `live-event ${forceType || type}`;
  el.innerHTML = `
    <div class="event-main">
      <div class="event-title">${esc(title)}</div>
      ${company ? `<div class="event-company">${esc(company)}</div>` : ''}
    </div>
    <div class="event-time">${new Date().toLocaleTimeString('en-IN')}</div>
  `;
  feed.insertBefore(el, feed.firstChild);
  // Cap at 50 events
  while (feed.children.length > 50) feed.removeChild(feed.lastChild);
}

function updateStatsFromSocket(s) {
  if (!s) return;
  document.getElementById('stat-scanned').textContent = s.total_scanned || 0;
  document.getElementById('stat-applied').textContent = s.success_count || 0;
  document.getElementById('stat-skipped').textContent = s.total_skipped || 0;
  document.getElementById('stat-errors').textContent  = s.fail_count    || 0;
}

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}

function makeGradient(canvasId, top, bottom) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 300);
  g.addColorStop(0, top); g.addColorStop(1, bottom);
  return g;
}

function showEmpty(canvasId, message) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const wrap = canvas.parentElement;
  canvas.style.display = 'none';
  if (!wrap.querySelector('.empty-state')) {
    const el = document.createElement('div');
    el.className = 'empty-state';
    el.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#3a4a5c;font-size:13px;gap:8px';
    el.innerHTML = `<span style="font-size:28px">📭</span><span>${message}</span>`;
    wrap.appendChild(el);
  }
}

function tooltipStyle() {
  return {
    backgroundColor: 'rgba(10,12,15,.95)',
    borderColor: '#1e2530', borderWidth: 1,
    titleColor: '#d4dce8', bodyColor: '#5a6a82',
    padding: 10, cornerRadius: 8,
    callbacks: {},
  };
}

function setStatus(cls, text) {
  const dot  = document.getElementById('status-dot');
  const txt  = document.getElementById('status-text');
  dot.className = `status-dot ${cls}`;
  txt.textContent = text;
}
function showDot(on) {
  document.getElementById('live-dot').style.display = on ? '' : 'none';
}
function setLastUpdated() {
  document.getElementById('last-updated').textContent =
    'Updated: ' + new Date().toLocaleTimeString('en-IN');
}
function formatDay(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-IN', { day:'2-digit', month:'short' });
}
function fmtDt(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString('en-IN', { dateStyle:'medium', timeStyle:'short' });
}
function statusEmoji(s) {
  return { success:'✅', skipped:'⏭', failed:'❌', pending:'⏳', retrying:'🔁' }[s] || '';
}
function esc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function refreshAll() {
  await Promise.all([
    loadStats(), loadTrendChart(), loadDonutChart(),
    loadCompaniesChart(), loadScoreChart(),
  ]);
}

async function exportCsv() {
  window.open('/api/export/csv', '_blank');
}

// ════════════════════════════════════════════════════════════════
//  MANUAL ADD MODAL
// ════════════════════════════════════════════════════════════════
function openAddModal() {
  const modal = document.getElementById('add-modal');
  modal.classList.add('active');
  document.getElementById('add-question').focus();
}

function closeAddModal() {
  const modal = document.getElementById('add-modal');
  modal.classList.remove('active');
  // Clear inputs
  document.getElementById('add-question').value = '';
  document.getElementById('add-answer').value = '';
  document.getElementById('add-key').value = '';
}

async function submitManualQuestion() {
  const q = document.getElementById('add-question').value.trim();
  const a = document.getElementById('add-answer').value.trim();
  const k = document.getElementById('add-key').value.trim();
  const btn = document.querySelector('.modal-footer .save-btn');

  if (!q || !a) {
    alert('Please provide both a question and an answer.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const res = await fetch('/api/learning', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, answer: a, answerKey: k || null }),
    });
    if (!res.ok) throw new Error(await res.text());

    closeAddModal();
    loadLearningList(); // Refresh table
  } catch (err) {
    alert('Failed to save: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Answer';
  }
}

// Close modal on escape or background click
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAddModal();
});
document.getElementById('add-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('add-modal')) closeAddModal();
});

// ════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved theme
  const savedTheme = localStorage.getItem('dashboard-theme') || 'dark';
  setTheme(savedTheme);

  setupSocket();
  showDot(false);

  // Live feed placeholder until events arrive
  const feed = document.getElementById('live-feed');
  if (feed) {
    const ph = document.createElement('div');
    ph.className = 'live-placeholder';
    ph.style.cssText = 'text-align:center;padding:60px 0;color:var(--text-dim);font-size:14px';
    ph.innerHTML = '⚡ Waiting for live events…<br><small style="font-size:11px;margin-top:8px;display:block">Events appear here in real-time as the bot runs</small>';
    feed.appendChild(ph);
  }

  await refreshAll();
  addDebugLog('Dashboard initialized and data loaded', 'info');

  // Auto-refresh every 30 seconds
  setInterval(refreshAll, 30000);
});

// ════════════════════════════════════════════════════════════════
//  CYBERPUNK UI UTILS
// ════════════════════════════════════════════════════════════════

function setTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  const activeBtn = document.getElementById(`theme-${theme}`);
  if (activeBtn) activeBtn.classList.add('active');

  localStorage.setItem('dashboard-theme', theme);
  showToast(`UI Theme: ${theme.toUpperCase()}`, 'info');
  addDebugLog(`Theme changed to ${theme}`, 'info');
}

function showToast(message, type = 'success', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icon = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️'
  }[type] || '🔔';

  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-message">${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

let debugLogCount = 0;

function toggleDebugConsole() {
  const consoleEl = document.getElementById('debug-console');
  const icon = document.getElementById('debug-toggle-icon');
  const isCollapsed = consoleEl.classList.contains('collapsed');

  if (isCollapsed) {
    consoleEl.classList.remove('collapsed');
    consoleEl.classList.add('expanded');
    icon.textContent = '▼';
  } else {
    consoleEl.classList.remove('expanded');
    consoleEl.classList.add('collapsed');
    icon.textContent = '▲';
  }
}

function addDebugLog(message, type = 'log') {
  const logsContainer = document.getElementById('debug-logs');
  if (!logsContainer) return;

  debugLogCount++;
  const countEl = document.getElementById('debug-count');
  if (countEl) countEl.textContent = debugLogCount;

  const entry = document.createElement('div');
  entry.className = 'debug-log-entry';

  const time = new Date().toLocaleTimeString('en-IN', { hour12: false });

  entry.innerHTML = `
    <span class="debug-log-time">[${time}]</span>
    <span class="debug-log-msg ${type}">${esc(message)}</span>
  `;

  logsContainer.appendChild(entry);
  logsContainer.scrollTop = logsContainer.scrollHeight;

  while (logsContainer.children.length > 200) {
    logsContainer.removeChild(logsContainer.firstChild);
  }
}

function clearDebugConsole(event) {
  if (event) event.stopPropagation();
  const logsContainer = document.getElementById('debug-logs');
  if (logsContainer) logsContainer.innerHTML = '';
  debugLogCount = 0;
  const countEl = document.getElementById('debug-count');
  if (countEl) countEl.textContent = '0';
  showToast('Debug logs cleared', 'info');
}
