/**
 * OLYMPUS — Mythic Job Conquest Engine
 * mythos.js — the single client brain.
 *
 * Replaces the old app.js + inline glue. Talks to the unchanged dashboard
 * REST + Socket.io backend, but reframes every signal as a mythic deed:
 *   • bot          → Hermes, the divine messenger
 *   • AI provider  → The Oracle
 *   • applied jobs → Conquests, skipped → Spared, failed → Fallen
 *   • portals      → gods of the Pantheon (Zeus/Athena/Poseidon/Hephaestus)
 *
 * New mythic components layered on top of the original feature set:
 *   • Constellation sky   — animated starfield backdrop (#cosmos)
 *   • Ascension           — XP + rank that climbs Mortal → God with conquests
 *   • Feats of Legend     — achievement tiles derived from live stats
 */
'use strict';

/* ── Tiny helpers ─────────────────────────────────────────────────────────── */
const $  = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ── Socket.io ────────────────────────────────────────────────────────────── */
const socket = window._socket || (window._socket = io());

/* ── Realms (theme) ───────────────────────────────────────────────────────── */
const html = document.documentElement;
(function initRealm() {
  const saved = localStorage.getItem('olympus-realm') || 'nyx';
  html.setAttribute('data-theme', saved);
  const b = $('themeToggle');
  if (b) b.textContent = saved === 'nyx' ? '🌙' : '☀️';
})();
on('themeToggle', 'click', () => {
  const next = html.getAttribute('data-theme') === 'nyx' ? 'helios' : 'nyx';
  html.setAttribute('data-theme', next);
  localStorage.setItem('olympus-realm', next);
  const b = $('themeToggle');
  if (b) b.textContent = next === 'nyx' ? '🌙' : '☀️';
  // Re-tint charts & sky for the new realm
  Object.keys(charts).forEach((k) => charts[k] && charts[k].update());
  sky.recolor();
});

/* ── Omens (toasts) ───────────────────────────────────────────────────────── */
function toast(msg, type = 'info') {
  const wrap = $('toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const sigil = type === 'ok' ? '🏆' : type === 'err' ? '💀' : '🔮';
  el.innerHTML = `<span>${sigil}</span><span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

/* ── Constellation sky ────────────────────────────────────────────────────── */
const sky = (() => {
  const canvas = $('cosmos');
  if (!canvas) return { recolor() {} };
  const ctx = canvas.getContext('2d');
  let stars = [];
  let w = 0, h = 0, raf = null;
  let color = cssVar('--gold') || '#d4af37';

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    const count = Math.min(140, Math.floor((w * h) / 14000));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.4 + 0.3,
      tw: Math.random() * Math.PI * 2,
      sp: Math.random() * 0.015 + 0.004,
    }));
  }
  function draw() {
    ctx.clearRect(0, 0, w, h);
    // faint constellation links between near stars
    ctx.strokeStyle = color + '22';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx = stars[i].x - stars[j].x;
        const dy = stars[i].y - stars[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 11000) {
          ctx.globalAlpha = (1 - d2 / 11000) * 0.5;
          ctx.beginPath();
          ctx.moveTo(stars[i].x, stars[i].y);
          ctx.lineTo(stars[j].x, stars[j].y);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    for (const s of stars) {
      s.tw += s.sp;
      const a = 0.35 + Math.abs(Math.sin(s.tw)) * 0.6;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = a;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(draw);
  }
  resize();
  window.addEventListener('resize', resize);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { draw(); cancelAnimationFrame(raf); } else { draw(); }
  return { recolor() { color = cssVar('--gold') || '#d4af37'; } };
})();

/* ── Tab navigation ───────────────────────────────────────────────────────── */
document.querySelectorAll('.nav-item').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    const tab = el.dataset.tab;
    document.querySelectorAll('.nav-item').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.page').forEach((x) => x.classList.remove('active'));
    el.classList.add('active');
    const page = $(`page-${tab}`);
    if (page) page.classList.add('active');
    if (tab === 'jobs') loadJobs();
    if (tab === 'learning') { loadLearning(); loadResumeContent(); }
    if (tab === 'config') loadConfig();
    if (tab === 'keywords') loadKeywords();
    if (tab === 'blocklist') loadBlocklist();
    if (tab === 'liveview') refreshScreenshot();
    if (tab === 'coverletters') loadCoverJobs();
  });
});

/* ── Connection badge ─────────────────────────────────────────────────────── */
socket.on('connect', () => {
  const d = $('connDot'), l = $('connLabel');
  if (d) d.className = 'conn-dot ok';
  if (l) l.textContent = 'Bound to Olympus';
});
socket.on('disconnect', () => {
  const d = $('connDot'), l = $('connLabel');
  if (d) d.className = 'conn-dot err';
  if (l) l.textContent = 'Olympus unreachable';
});

/* ═══════════════ OLYMPUS (stats / dashboard) ════════════════════════════════ */
let lastStats = { total: 0, applied: 0, skipped: 0, failed: 0, pending: 0, successRate: 0 };
let lastLearning = 0;

function animNum(id, target) {
  const el = $(id);
  if (!el) return;
  const cur = parseInt(el.textContent) || 0;
  if (cur === target) { el.textContent = target; return; }
  const step = Math.max(1, Math.ceil(Math.abs(target - cur) / 18));
  let v = cur;
  const tid = setInterval(() => {
    v = v < target ? Math.min(v + step, target) : Math.max(v - step, target);
    el.textContent = v;
    if (v === target) clearInterval(tid);
  }, 25);
}

function updateKPI(s) {
  if (!s) return;
  lastStats = { ...lastStats, ...s };
  animNum('kTotal', s.total || 0);
  animNum('kApplied', s.applied || 0);
  animNum('kSkipped', s.skipped || 0);
  animNum('kFailed', s.failed || 0);
  const rate = $('kRate'); if (rate) rate.textContent = (s.successRate || 0) + '%';
  const ncT = $('nc-total'); if (ncT) ncT.textContent = s.total || 0;
  const ncJ = $('nc-jobs'); if (ncJ) ncJ.textContent = s.total || 0;
  renderAscension();
  renderFeats();
}

/* ── Ascension: XP + rank ─────────────────────────────────────────────────── */
const RANKS = [
  { name: 'Mortal',    icon: '🧍', min: 0 },
  { name: 'Initiate',  icon: '🕯️', min: 1 },
  { name: 'Hero',      icon: '🛡️', min: 5 },
  { name: 'Champion',  icon: '⚔️', min: 15 },
  { name: 'Demigod',   icon: '🌟', min: 30 },
  { name: 'Olympian',  icon: '🏛️', min: 60 },
  { name: 'Titan',     icon: '🗿', min: 100 },
  { name: 'God',       icon: '⚡', min: 175 },
];

function renderAscension() {
  // XP = 10 per conquest + 1 per scroll of wisdom learned
  const xp = (lastStats.applied || 0) * 10 + (lastLearning || 0);
  // Rank is measured purely in conquests so the title feels earned in battle.
  const conquests = lastStats.applied || 0;
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (conquests >= RANKS[i].min) idx = i;
  const cur = RANKS[idx];
  const next = RANKS[idx + 1] || null;

  const iconEl = $('ascRankIcon'); if (iconEl) iconEl.textContent = cur.icon;
  const nameEl = $('ascRankName'); if (nameEl) nameEl.textContent = cur.name;
  const xpEl = $('ascXp'); if (xpEl) xpEl.textContent = `${xp.toLocaleString()} XP`;

  const fill = $('ascBarFill');
  const nextEl = $('ascNext');
  if (next) {
    const span = next.min - cur.min;
    const into = conquests - cur.min;
    const pct = Math.max(4, Math.min(100, Math.round((into / span) * 100)));
    if (fill) fill.style.width = pct + '%';
    const remain = next.min - conquests;
    if (nextEl) nextEl.innerHTML =
      `<b>${remain}</b> more conquest${remain === 1 ? '' : 's'} to ascend to <b>${next.icon} ${next.name}</b>.`;
  } else {
    if (fill) fill.style.width = '100%';
    if (nextEl) nextEl.innerHTML = '⚡ You sit upon the throne of Olympus. There is no higher.';
  }
}

/* ── Feats of Legend (achievements) ───────────────────────────────────────── */
const FEATS = [
  { id: 'first',   icon: '🩸', name: 'First Blood',        desc: 'Win your first conquest.',            done: (s) => s.applied >= 1,                prog: (s) => `${Math.min(s.applied, 1)}/1` },
  { id: 'ten',     icon: '⚔️', name: 'Decathlon',          desc: 'Claim 10 conquests.',                 done: (s) => s.applied >= 10,               prog: (s) => `${Math.min(s.applied, 10)}/10` },
  { id: 'hydra',   icon: '🐉', name: 'Hydra Slayer',       desc: 'Claim 50 conquests.',                 done: (s) => s.applied >= 50,               prog: (s) => `${Math.min(s.applied, 50)}/50` },
  { id: 'century', icon: '🏺', name: 'Centurion',          desc: 'Behold 100 trials.',                  done: (s) => s.total >= 100,                prog: (s) => `${Math.min(s.total, 100)}/100` },
  { id: 'favor',   icon: '🌟', name: 'Favored by the Gods', desc: 'Reach 50% divine favor (10+ trials).', done: (s) => s.total >= 10 && s.successRate >= 50, prog: (s) => `${s.successRate}%` },
  { id: 'owl',     icon: '🦉', name: "Athena's Apprentice", desc: 'Gather 25 scrolls of wisdom.',        done: () => lastLearning >= 25,             prog: () => `${Math.min(lastLearning, 25)}/25` },
  { id: 'flawless', icon: '🛡️', name: 'Untouchable',        desc: '10+ conquests with none fallen.',     done: (s) => s.applied >= 10 && s.failed === 0, prog: (s) => `${s.failed} fallen` },
  { id: 'throne',  icon: '⚡', name: 'Throne of Olympus',   desc: 'Ascend to the rank of God.',          done: (s) => s.applied >= 175,              prog: (s) => `${Math.min(s.applied, 175)}/175` },
];

function renderFeats() {
  const grid = $('featsGrid');
  if (!grid) return;
  const s = lastStats;
  grid.innerHTML = FEATS.map((f) => {
    const done = !!f.done(s);
    return `
      <div class="feat ${done ? 'unlocked' : ''}">
        <span class="feat-icon">${f.icon}</span>
        <div>
          <div class="feat-name">${f.name}</div>
          <div class="feat-desc">${f.desc}</div>
          <div class="feat-progress">${done ? '✓ Immortalised' : esc(f.prog(s))}</div>
        </div>
      </div>`;
  }).join('');
}

async function loadDashboard() {
  try {
    const [statsR, summR] = await Promise.all([
      fetch('/api/stats').then((r) => r.json()),
      fetch('/api/db/summary').then((r) => r.json()),
    ]);
    lastLearning = summR.learning || 0;
    updateKPI(statsR);
    const kL = $('kLearning'); if (kL) kL.textContent = summR.learning || 0;
    const ncL = $('nc-learning'); if (ncL) ncL.textContent = summR.learning || 0;
    const lr = $('lastRefresh');
    if (lr) lr.textContent = 'The Fates last spoke at ' + new Date().toLocaleTimeString();
    await Promise.all([loadTrendChart(), loadDonutChart(), loadCompanyChart(), loadScoreChart()]);
    await loadRecent();
  } catch (e) { console.error('[Olympus]', e); }
}

socket.on('init:stats', updateKPI);
socket.on('stats:update', updateKPI);
socket.on('job:applied', () => { loadDashboard(); updateLearningCount(); });
socket.on('job:analyzed', (d) =>
  appendLog('info', `🔮 The Oracle weighs ${d.title} @ ${d.company} → ${d.decision} (${d.score})`));
socket.on('selflearn:done', (r) => {
  if (!r) return;
  toast(`🦉 Athena inscribed ${r.answered ?? 0} new scrolls`, 'ok');
  updateLearningCount();
});

async function updateLearningCount() {
  try {
    const s = await fetch('/api/db/summary').then((r) => r.json());
    lastLearning = s.learning || 0;
    const a = $('nc-learning'); if (a) a.textContent = s.learning || 0;
    const b = $('kLearning'); if (b) b.textContent = s.learning || 0;
    renderAscension();
    renderFeats();
  } catch (_) {}
}

on('btnRefreshDash', 'click', loadDashboard);

/* ── Charts ───────────────────────────────────────────────────────────────── */
const charts = {};
function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
function chartBase() {
  const tx = cssVar('--tx2') || '#b3ab92';
  const grid = cssVar('--grid-line') || 'rgba(236,229,208,.05)';
  const tick = cssVar('--tick') || '#6c6650';
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: tx, font: { family: 'Inter', size: 11 } } } },
    scales: {
      x: { ticks: { color: tick, font: { size: 10 } }, grid: { color: grid } },
      y: { beginAtZero: true, ticks: { color: tick }, grid: { color: grid } },
    },
  };
}
const COL = { applied: '#3ecf8e', skipped: '#e8b341', failed: '#e25c5c', pending: '#9d8cff' };

async function loadTrendChart() {
  try {
    const rows = await fetch('/api/jobs/trend').then((r) => r.json());
    destroyChart('trend');
    const ctx = $('cTrend').getContext('2d');
    charts.trend = new Chart(ctx, {
      type: 'line',
      data: {
        labels: rows.map((r) => r.day),
        datasets: [
          { label: 'Conquered', data: rows.map((r) => r.applied), borderColor: COL.applied, backgroundColor: 'rgba(62,207,142,.12)', fill: true, tension: 0.4, pointRadius: 3 },
          { label: 'Spared',    data: rows.map((r) => r.skipped), borderColor: COL.skipped, backgroundColor: 'rgba(232,179,65,.09)', fill: true, tension: 0.4, pointRadius: 3 },
          { label: 'Fallen',    data: rows.map((r) => r.failed),  borderColor: COL.failed,  backgroundColor: 'rgba(226,92,92,.09)',  fill: true, tension: 0.4, pointRadius: 3 },
        ],
      },
      options: chartBase(),
    });
  } catch (e) { console.warn('[TrendChart]', e); }
}

async function loadDonutChart() {
  try {
    const s = await fetch('/api/stats').then((r) => r.json());
    destroyChart('donut');
    const tx = cssVar('--tx2') || '#b3ab92';
    charts.donut = new Chart($('cDonut').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Conquered', 'Spared', 'Fallen', 'Fated'],
        datasets: [{ data: [s.applied, s.skipped, s.failed, s.pending], backgroundColor: [COL.applied, COL.skipped, COL.failed, 'rgba(157,140,255,.5)'], borderWidth: 0, hoverOffset: 7 }],
      },
      options: { ...chartBase(), cutout: '70%', scales: {}, plugins: { legend: { position: 'bottom', labels: { color: tx, boxWidth: 10, padding: 12, font: { size: 11 } } } } },
    });
  } catch (e) { console.warn('[DonutChart]', e); }
}

async function loadCompanyChart() {
  try {
    const rows = await fetch('/api/jobs/top-companies').then((r) => r.json());
    destroyChart('co');
    charts.co = new Chart($('cCompanies').getContext('2d'), {
      type: 'bar',
      data: {
        labels: rows.map((r) => (r.company.length > 16 ? r.company.slice(0, 16) + '…' : r.company)),
        datasets: [
          { label: 'Trials',    data: rows.map((r) => r.total),   backgroundColor: 'rgba(157,140,255,.6)', borderRadius: 5 },
          { label: 'Conquered', data: rows.map((r) => r.applied), backgroundColor: 'rgba(62,207,142,.75)', borderRadius: 5 },
        ],
      },
      options: chartBase(),
    });
  } catch (e) { console.warn('[CompanyChart]', e); }
}

async function loadScoreChart() {
  try {
    const rows = await fetch('/api/jobs/score-dist').then((r) => r.json());
    destroyChart('sc');
    const colors = { '90-100': '#3ecf8e', '75-89': '#5ea2e8', '60-74': '#9d8cff', '40-59': '#e8b341', 'Below 40': '#e25c5c' };
    charts.sc = new Chart($('cScores').getContext('2d'), {
      type: 'bar',
      data: { labels: rows.map((r) => r.range), datasets: [{ label: 'Trials', data: rows.map((r) => r.count), backgroundColor: rows.map((r) => colors[r.range] || '#9d8cff'), borderRadius: 6 }] },
      options: chartBase(),
    });
  } catch (e) { console.warn('[ScoreChart]', e); }
}

async function loadRecent() {
  try {
    const rows = await fetch('/api/jobs/recent').then((r) => r.json());
    const el = $('recentList');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div style="color:var(--tx3);text-align:center;padding:20px;font-style:italic">No deeds yet. Summon Hermes to begin the saga.</div>';
      return;
    }
    el.innerHTML = rows.map((r) => `
      <div class="recent-row">
        ${statusBadge(r.apply_status)}
        <span class="rr-title">${esc(r.title)}</span>
        <span class="rr-co">${esc(r.company)}</span>
        ${scoreBar(r.score)}
        <span class="rr-date">${fmtDate(r.created_at)}</span>
      </div>`).join('');
  } catch (e) { console.warn('[Recent]', e); }
}

/* ═══════════════ QUESTS (jobs) ══════════════════════════════════════════════ */
let allJobs = [];
async function loadJobs() {
  try {
    allJobs = await fetch('/api/jobs/all').then((r) => r.json());
    renderJobs();
    const nc = $('nc-jobs'); if (nc) nc.textContent = allJobs.length;
  } catch (e) { console.warn('[Quests]', e); toast('Failed to read the Book of Quests', 'err'); }
}

function renderJobs() {
  const q = ($('jobSearch')?.value || '').toLowerCase();
  const status = $('jobFilter')?.value || '';
  const sort = $('jobSort')?.value || 'created_at-desc';
  let rows = allJobs.filter((j) => {
    if (status && j.apply_status !== status) return false;
    if (q && !`${j.title} ${j.company} ${j.location || ''} ${j.reason || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const [field, dir] = sort.split('-');
  rows.sort((a, b) => {
    let av = a[field], bv = b[field];
    if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv || '') : (bv || '').localeCompare(av);
    return dir === 'asc' ? (av || 0) - (bv || 0) : (bv || 0) - (av || 0);
  });
  const tbody = $('tblJobsBody');
  const empty = $('jobsEmpty');
  if (!tbody) return;
  if (!rows.length) { tbody.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  tbody.innerHTML = rows.map((j) => `
    <tr>
      <td class="cell-clip" title="${esc(j.title)}">${esc(j.title)}</td>
      <td>${esc(j.company || '')}</td>
      <td>${esc(j.location || '–')}</td>
      <td>${scoreBar(j.score)}</td>
      <td>${statusBadge(j.apply_status)}</td>
      <td class="cell-clip cell-dim" title="${esc(j.reason || '')}">${esc((j.reason || '').slice(0, 60))}</td>
      <td class="cell-dim">${fmtDate(j.created_at)}</td>
      <td>${jobLinkCell(j)}</td>
    </tr>`).join('');
}

['jobSearch', 'jobFilter', 'jobSort'].forEach((id) => {
  on(id, 'input', renderJobs);
  on(id, 'change', renderJobs);
});
on('btnRefreshJobs', 'click', loadJobs);
on('btnJobExport', 'click', () => { window.location.href = '/api/jobs/export/csv'; });
on('btnExportCsv', 'click', () => { window.location.href = '/api/jobs/export/csv'; });
on('btnJobImport', 'click', () => $('jobImportFile')?.click());
on('jobImportFile', 'change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const text = await file.text();
  try {
    const d = await fetch('/api/jobs/import/csv', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text }).then((r) => r.json());
    if (d.success) { toast(`🏆 Imported ${d.inserted} quests`, 'ok'); loadJobs(); loadDashboard(); }
    else toast('Import failed: ' + d.error, 'err');
  } catch (err) { toast('Error: ' + err.message, 'err'); }
  e.target.value = '';
});

/* ═══════════════ ATHENA'S CODEX (learning) ══════════════════════════════════ */
let allLearning = [];
async function loadLearning() {
  try {
    allLearning = await fetch('/api/learning').then((r) => r.json());
    renderLearning();
    const nc = $('nc-learning'); if (nc) nc.textContent = allLearning.length;
  } catch (e) { toast("Failed to open Athena's Codex", 'err'); }
}

function renderLearning() {
  const q = ($('lSearch')?.value || '').toLowerCase();
  const filter = $('lFilter')?.value || '';
  let rows = allLearning.filter((r) => {
    if (filter === 'answered' && !r.answered) return false;
    if (filter === 'unanswered' && r.answered) return false;
    if (q && !`${r.question} ${r.answer || ''} ${r.answer_key || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const tbody = $('tblLBody');
  const empty = $('lEmpty');
  const meta = $('lMeta');
  const answCnt = allLearning.filter((r) => r.answered).length;
  if (meta) meta.innerHTML =
    `<span>Scrolls: <b>${allLearning.length}</b></span><span>Inscribed: <b>${answCnt}</b></span><span>Blank: <b>${allLearning.length - answCnt}</b></span><span>Shown: <b>${rows.length}</b></span>`;
  if (!tbody) return;
  if (!rows.length) { tbody.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  tbody.innerHTML = rows.map((r, i) => `
    <tr id="lr-${r.id}">
      <td style="color:var(--tx3);font-size:11px;width:36px">${i + 1}</td>
      <td style="color:var(--tx)">${esc(r.question)}</td>
      <td style="color:var(--tx3);font-size:12px">${esc(r.answer_key || '')}</td>
      <td><span class="editable" contenteditable="true" data-id="${r.id}" title="Click to inscribe">${esc(r.answer || '')}</span></td>
      <td>${r.answered ? '<span class="badge b-green">✓ Inscribed</span>' : '<span class="badge b-muted">Blank</span>'}</td>
      <td class="actions-col">
        <button class="btn-icon-edit" data-save="${r.id}" title="Inscribe">💾</button>
        <button class="btn-icon-del" data-del="${r.id}" title="Erase">🗑</button>
      </td>
    </tr>`).join('');
  tbody.querySelectorAll('.editable[data-id]').forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEditInline(Number(el.dataset.id)); }
    });
  });
  tbody.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => saveEditInline(Number(b.dataset.save))));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteLearning(Number(b.dataset.del))));
}

async function saveEditInline(id) {
  const el = document.querySelector(`.editable[data-id="${id}"]`);
  if (!el) return;
  const answer = el.textContent.trim();
  try {
    const d = await fetch(`/api/learning/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }) }).then((r) => r.json());
    if (d.success) {
      toast('Scroll inscribed', 'ok');
      const entry = allLearning.find((x) => x.id === id);
      if (entry) { entry.answer = answer; entry.answered = 1; }
      const row = $(`lr-${id}`);
      if (row && row.cells[4]) row.cells[4].innerHTML = '<span class="badge b-green">✓ Inscribed</span>';
    } else toast('Failed: ' + d.error, 'err');
  } catch (e) { toast('Error: ' + e.message, 'err'); }
}

async function deleteLearning(id) {
  if (!confirm('Erase this scroll from the Codex?')) return;
  try {
    const d = await fetch(`/api/learning/${id}`, { method: 'DELETE' }).then((r) => r.json());
    if (d.success) { allLearning = allLearning.filter((x) => x.id !== id); renderLearning(); toast('Scroll erased', 'ok'); }
    else toast('Failed: ' + d.error, 'err');
  } catch (e) { toast('Error', 'err'); }
}

on('btnAddQA', 'click', async () => {
  const q = $('lNewQ')?.value.trim();
  const a = $('lNewA')?.value.trim();
  const k = $('lNewKey')?.value.trim();
  if (!q || !a) { toast('Question and Answer required', 'err'); return; }
  try {
    const d = await fetch('/api/learning', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, answer: a, answerKey: k || undefined }) }).then((r) => r.json());
    if (d.success) { toast('Wisdom inscribed', 'ok'); $('lNewQ').value = ''; $('lNewA').value = ''; $('lNewKey').value = ''; loadLearning(); }
    else toast('Error: ' + d.error, 'err');
  } catch (e) { toast('Error', 'err'); }
});

['lSearch', 'lFilter'].forEach((id) => { on(id, 'input', renderLearning); on(id, 'change', renderLearning); });
on('btnRefreshL', 'click', loadLearning);

on('btnSelfLearn', 'click', async () => {
  const btn = $('btnSelfLearn');
  btn.disabled = true; btn.textContent = '🔮 Divining…';
  try {
    const d = await fetch('/api/learning/self-learn', { method: 'POST' }).then((r) => r.json());
    if (d.success) { toast(`🦉 Athena inscribed ${d.answered ?? 0} scrolls`, 'ok'); loadLearning(); }
    else toast(d.status || 'The Oracle is silent', 'info');
  } catch (e) { toast('Error', 'err'); }
  btn.disabled = false; btn.textContent = '✨ Divine Insight';
});

on('btnLearningExport', 'click', () => { window.location.href = '/api/learning/export/csv'; });
on('btnLearningImport', 'click', () => $('lImportFile')?.click());
on('lImportFile', 'change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const text = await file.text();
  try {
    const d = await fetch('/api/learning/import/csv', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text }).then((r) => r.json());
    if (d.success) { toast(`Imported ${d.inserted} scrolls`, 'ok'); loadLearning(); }
    else toast('Import failed: ' + d.error, 'err');
  } catch (err) { toast('Error', 'err'); }
  e.target.value = '';
});

/* ── The Hero's Legend (resume) ───────────────────────────────────────────── */
async function loadResumeContent() {
  try {
    const d = await fetch('/api/resume/content').then((r) => r.json());
    if (d.text) {
      const ed = $('resumeEditor'); if (ed) ed.value = d.text.trim();
      const b = $('btnAutoLearnResume'); if (b) b.disabled = false;
    }
  } catch (_) {}
}

on('btnResumeUpload', 'click', () => $('resumeUpload')?.click());
on('resumeUpload', 'change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('resume', file);
  toast('Offering your legend to the Oracle…', 'info');
  try {
    const d = await fetch('/api/resume/upload', { method: 'POST', body: fd }).then((r) => r.json());
    if (d.success) {
      $('resumeEditor').value = d.text.trim();
      $('btnAutoLearnResume').disabled = false;
      toast(`Read ${d.length} runes from your legend`, 'ok');
    } else toast('Offering rejected: ' + d.error, 'err');
  } catch (err) { toast('Error: ' + err.message, 'err'); }
  e.target.value = '';
});

on('resumeEditor', 'blur', async () => {
  const text = $('resumeEditor')?.value;
  if (!text || !text.trim()) return;
  try { await fetch('/api/resume/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); } catch (_) {}
});

on('btnAutoLearnResume', 'click', async () => {
  const text = $('resumeEditor')?.value.trim();
  if (!text) { toast('Offer your legend first', 'err'); return; }
  const btn = $('btnAutoLearnResume');
  btn.disabled = true; btn.textContent = '🔮 The Oracle inscribes… (up to 30s)';
  try {
    const d = await fetch('/api/resume/auto-learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).then((r) => r.json());
    if (d.success) { toast(`🦉 The Oracle penned ${d.generated} Q&As, sealed ${d.saved}`, 'ok'); loadLearning(); }
    else toast('Error: ' + d.error, 'err');
  } catch (err) { toast('Error: ' + err.message, 'err'); }
  btn.disabled = false; btn.textContent = '🔮 Oracle, Inscribe Q&A';
});

/* ═══════════════ CHRONICLE (live log) ═══════════════════════════════════════ */
function appendLog(level, msg) {
  const vp = $('logVP');
  if (!vp) return;
  const ts = new Date().toLocaleTimeString();
  const row = document.createElement('div');
  row.className = `log-row ${level}`;
  row.innerHTML = `<span class="log-ts">${ts}</span><span class="log-msg">${esc(msg)}</span>`;
  vp.appendChild(row);
  vp.scrollTop = vp.scrollHeight;
  if (vp.children.length > 500) vp.removeChild(vp.firstChild);
}
socket.on('bot:log', (d) => appendLog(d.level || detectLevel(d.msg), d.msg));
on('btnClearLog', 'click', () => { const v = $('logVP'); if (v) v.innerHTML = ''; });
on('btnLoadLogs', 'click', async () => {
  try {
    const d = await fetch('/api/logs/tail').then((r) => r.json());
    (d.lines || []).forEach((l) => appendLog(detectLevel(l), l));
    toast(`Unfurled ${(d.lines || []).length} lines`, 'ok');
  } catch (e) { toast('Failed', 'err'); }
});

/* ═══════════════ EYE OF ARGUS (live browser) ════════════════════════════════ */
async function refreshScreenshot() {
  try {
    const d = await fetch('/api/screenshot/latest-path').then((r) => r.json());
    if (d.path) updateLiveScreenshot(d.path);
  } catch (_) {}
}
function updateLiveScreenshot(pathStr) {
  const img = $('lvImg'), holder = $('lvPlaceholder'), meta = $('lvMeta');
  if (!img) return;
  if (pathStr) {
    img.src = pathStr + '?t=' + Date.now();
    img.style.display = 'block';
    if (holder) holder.style.display = 'none';
    if (meta) meta.textContent = 'Argus watches • ' + new Date().toLocaleTimeString();
  } else {
    img.style.display = 'none';
    if (holder) holder.style.display = 'block';
  }
}
socket.on('screenshot:new', (data) => { if (data && data.path) updateLiveScreenshot(data.path); });
on('btnRefreshScreenshot', 'click', refreshScreenshot);

/* ═══════════════ THE FORGE (settings) ═══════════════════════════════════════ */
async function loadConfig() {
  try {
    const [c, p, k] = await Promise.all([
      fetch('/api/config').then((r) => r.json()),
      fetch('/api/profile').then((r) => r.json()),
      fetch('/api/api-keys').then((r) => r.json()),
    ]);
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    set('cfgJobTitle', c.jobTitle || (c.searchKeywords && c.searchKeywords[0]) || '');
    set('cfgLocation', c.searchLocation || '');
    set('cfgMaxJobs', c.maxAppsPerRun || '');
    set('cfgMaxPages', c.maxPagesPerSearch || '');
    set('cfgThreshold', c.scoreThreshold || '');
    set('cfgAiModel', c.aiModel || '');
    set('cfgOllama', c.ollamaBaseUrl || '');
    set('cfgTimeout', c.ollamaTimeout || '');
    set('cfgSlowMo', c.slowMo || '');
    set('cfgDelayMin', c.delayMin || '');
    set('cfgDelayMax', c.delayMax || '');
    set('cfgHeadless', String(c.headless === true));
    set('cfgSkipAI', String(c.skipAI === true));
    set('cfgSafety', String(c.safetyMode === true));

    set('pfName', p.name || '');
    set('pfEmail', p.email || '');
    set('pfPhone', p.phone || '');
    set('pfLocation', p.currentLocation || '');
    set('pfResumePath', c.resumePath || '');
    set('pfLinkedIn', p.linkedIn || '');
    set('pfGitHub', p.github || '');
    set('pfPortfolio', p.portfolio || '');
    set('pfCompany', p.currentCompany || '');
    set('pfRole', p.currentRole || '');
    set('pfYears', p.yearsExperience || '');
    set('pfSalary', p.salary || '');
    set('pfNotice', p.noticePeriod || '');
    set('pfSummary', p.summary || '');
    set('pfCoverLetter', p.coverLetter || '');

    const setKey = (id, val) => { const el = $(id); if (!el) return; el.value = val || ''; el.dataset.dirty = '0'; };
    setKey('pfGeminiKey', k.geminiApiKey);
    setKey('pfOpenAiKey', k.openAiApiKey);
    setKey('pfOpenAiKey2', k.openAiApiKey2);
    set('pfGeminiModel', k.geminiModel || '');
    set('pfOpenAiModel', k.openAiModel || '');
    renderApiKeyStatus(k);
  } catch (e) { toast('The Forge would not open', 'err'); }
}

on('btnSaveConfig', 'click', async () => {
  const val = (id) => $(id)?.value;
  const cfgBody = {
    searchLocation: val('cfgLocation'),
    maxAppsPerRun: parseInt(val('cfgMaxJobs')) || 20,
    maxPagesPerSearch: parseInt(val('cfgMaxPages')) || 5,
    scoreThreshold: parseInt(val('cfgThreshold')) || 40,
    aiModel: val('cfgAiModel'),
    ollamaBaseUrl: val('cfgOllama'),
    ollamaTimeout: parseInt(val('cfgTimeout')) || 60000,
    slowMo: parseInt(val('cfgSlowMo')) || 20,
    delayMin: parseInt(val('cfgDelayMin')) || 1500,
    delayMax: parseInt(val('cfgDelayMax')) || 3000,
    headless: val('cfgHeadless') === 'true',
    skipAI: val('cfgSkipAI') === 'true',
    safetyMode: val('cfgSafety') === 'true',
    resumePath: (val('pfResumePath') || '').trim(),
  };
  const profile = {
    name: val('pfName'), email: val('pfEmail'), phone: val('pfPhone'),
    currentLocation: val('pfLocation'), linkedIn: val('pfLinkedIn'), github: val('pfGitHub'),
    portfolio: val('pfPortfolio'), currentCompany: val('pfCompany'), currentRole: val('pfRole'),
    yearsExperience: val('pfYears'), salary: val('pfSalary'), noticePeriod: val('pfNotice'),
    summary: val('pfSummary'), coverLetter: val('pfCoverLetter'),
  };
  const apiBody = { geminiModel: (val('pfGeminiModel') || '').trim(), openAiModel: (val('pfOpenAiModel') || '').trim() };
  const dirtyMap = { pfGeminiKey: 'geminiApiKey', pfOpenAiKey: 'openAiApiKey', pfOpenAiKey2: 'openAiApiKey2' };
  for (const [id, field] of Object.entries(dirtyMap)) {
    const el = $(id);
    if (el && el.dataset.dirty === '1') apiBody[field] = el.value.trim();
  }
  try {
    const [d1, d2, d3] = await Promise.all([
      fetch('/api/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfgBody) }).then((r) => r.json()),
      fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) }).then((r) => r.json()),
      fetch('/api/api-keys', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(apiBody) }).then((r) => r.json()),
    ]);
    if (d1.success && d2.success && d3.success) { toast('The anvil rings — all sealed 🔨', 'ok'); await loadConfig(); }
    else { toast('Partial seal — check console', 'err'); console.error('Save errors:', d1, d2, d3); }
  } catch (e) { toast('Seal failed: ' + e.message, 'err'); }
});
on('btnRefreshConfig', 'click', loadConfig);

const API_KEY_FIELDS = ['pfGeminiKey', 'pfOpenAiKey', 'pfOpenAiKey2'];
API_KEY_FIELDS.forEach((id) => on(id, 'input', () => { const el = $(id); if (el) el.dataset.dirty = '1'; }));

function renderApiKeyStatus(k) {
  const providers = [];
  if (k.geminiSet) providers.push('Gemini');
  if (k.openAiSet || k.openAiSet2) providers.push('OpenAI');
  const el = $('apiKeyStatus');
  if (!el) return;
  el.innerHTML = providers.length
    ? `🗝️ Realms open: <b>${providers.join(', ')}</b> → Ollama → keyword augury`
    : '⚠️ No keys — the Oracle uses <b>Ollama / keyword augury</b> only.';
}

/* ═══════════════ SACRED SIGILS (keywords) ═══════════════════════════════════ */
let keywords = { required: [], preferred: [], excluded: [] };
const AREA = { req: 'reqTagArea', pref: 'prefTagArea', excl: 'exclTagArea' };
const KEYMAP = { req: 'required', pref: 'preferred', excl: 'excluded' };

async function loadKeywords() {
  try {
    keywords = await fetch('/api/keywords').then((r) => r.json());
    renderTags('req'); renderTags('pref'); renderTags('excl');
  } catch (e) { toast('Could not read the Sigils', 'err'); }
}
function renderTags(type) {
  const area = $(AREA[type]);
  if (!area) return;
  const list = keywords[KEYMAP[type]] || [];
  area.innerHTML = list.map((kw, i) =>
    `<span class="tag ${type}">${esc(kw)} <span class="tag-x" data-t="${type}" data-i="${i}">×</span></span>`).join('');
  area.querySelectorAll('.tag-x').forEach((x) =>
    x.addEventListener('click', () => { keywords[KEYMAP[type]].splice(Number(x.dataset.i), 1); renderTags(type); }));
}
function addKeyword(type, inputId) {
  const input = $(inputId);
  const v = input?.value.trim();
  if (!v) return;
  const arr = keywords[KEYMAP[type]];
  if (!arr.includes(v)) { arr.push(v); renderTags(type); }
  input.value = '';
}
on('btnAddReq', 'click', () => addKeyword('req', 'reqInput'));
on('btnAddPref', 'click', () => addKeyword('pref', 'prefInput'));
on('btnAddExcl', 'click', () => addKeyword('excl', 'exclInput'));
on('reqInput', 'keydown', (e) => { if (e.key === 'Enter') addKeyword('req', 'reqInput'); });
on('prefInput', 'keydown', (e) => { if (e.key === 'Enter') addKeyword('pref', 'prefInput'); });
on('exclInput', 'keydown', (e) => { if (e.key === 'Enter') addKeyword('excl', 'exclInput'); });
on('btnSaveKeywords', 'click', async () => {
  try {
    const d = await fetch('/api/keywords', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(keywords) }).then((r) => r.json());
    if (d.success) toast('The Sigils are sealed', 'ok'); else toast('Error: ' + d.error, 'err');
  } catch (e) { toast('Error', 'err'); }
});
on('btnRefreshKeywords', 'click', loadKeywords);

/* ═══════════════ TARTARUS (blocklist) ═══════════════════════════════════════ */
async function loadBlocklist() {
  try {
    const list = await fetch('/api/blocklist').then((r) => r.json());
    const el = $('blockList'), empty = $('blockEmpty'), nc = $('nc-block');
    if (nc) nc.textContent = list.length || '–';
    if (!el) return;
    if (!list.length) { el.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
    if (empty) empty.style.display = 'none';
    el.innerHTML = list.map((c) =>
      `<li class="block-item"><span>🌋 ${esc(c)}</span><button class="btn-icon-del" data-co="${esc(c)}">Release</button></li>`).join('');
    el.querySelectorAll('[data-co]').forEach((b) => b.addEventListener('click', () => removeBlock(b.dataset.co)));
  } catch (e) { toast('Tartarus is sealed shut', 'err'); }
}
async function removeBlock(company) {
  try {
    const d = await fetch(`/api/blocklist/${encodeURIComponent(company)}`, { method: 'DELETE' }).then((r) => r.json());
    if (d.success) { loadBlocklist(); toast('Released from the pit', 'ok'); } else toast('Error', 'err');
  } catch (e) { toast('Error', 'err'); }
}
on('btnAddBlock', 'click', async () => {
  const company = $('blockInput')?.value.trim();
  if (!company) return;
  try {
    const d = await fetch('/api/blocklist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company }) }).then((r) => r.json());
    if (d.success) { $('blockInput').value = ''; loadBlocklist(); toast(`Banished: ${company}`, 'ok'); }
    else toast('Error: ' + d.error, 'err');
  } catch (e) { toast('Error', 'err'); }
});
on('blockInput', 'keydown', (e) => { if (e.key === 'Enter') $('btnAddBlock')?.click(); });

/* ═══════════════ HERMES (bot controls) ══════════════════════════════════════ */
let uptimeInterval = null;
function setBotUI(state) {
  const status = state.status;
  const dot = $('botDot'), label = $('botLabel'), uptime = $('botUptime');
  if (dot) dot.className = `bot-dot ${status}`;
  if (label) label.textContent = ({ running: 'Hermes flies', stopping: 'Hermes lands…', idle: 'Hermes rests' }[status]) || status;
  const running = status === 'running' || status === 'stopping';
  const sb = $('btnStart'), st = $('btnStop'), rs = $('btnRestart');
  if (sb) sb.disabled = running;
  if (st) st.disabled = !running;
  if (rs) rs.disabled = status === 'idle';
  if (status === 'running' && state.startedAt) {
    clearInterval(uptimeInterval);
    const start = new Date(state.startedAt);
    uptimeInterval = setInterval(() => {
      const d = Math.floor((Date.now() - start) / 1000);
      if (uptime) uptime.textContent = d < 60 ? `${d}s` : d < 3600 ? `${Math.floor(d / 60)}m ${d % 60}s` : `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`;
    }, 1000);
  } else { clearInterval(uptimeInterval); if (uptime) uptime.textContent = ''; }
  // Quick-action buttons mirror bot state
  [btnApplyNaukri, btnApplyLinkedIn, btnApplyIndeed, btnApplyCompany, btnRunAll].forEach((b) => { if (b) b.disabled = running; });
  if (btnStopBot) btnStopBot.disabled = !running;
  const cu = $('companyUrlInput'); if (cu) cu.disabled = running;
}
socket.on('bot:status', setBotUI);

async function botAction(action, payload = {}) {
  try {
    const d = await fetch(`/api/bot/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json());
    if (d.error) toast('Hermes stumbled: ' + d.error, 'err');
    else appendLog('info', `Hermes ${action}: ${d.message || 'OK'}`);
  } catch (e) { toast('Hermes did not answer', 'err'); }
}
on('btnStart', 'click', () => { botAction('start'); toast('Summoning Hermes…', 'info'); });
on('btnStop', 'click', () => { botAction('stop'); toast('Banishing Hermes…', 'info'); });
on('btnRestart', 'click', () => { botAction('restart'); toast('Hermes is reborn…', 'info'); });

const btnApplyNaukri = $('btnApplyNaukri');
const btnApplyLinkedIn = $('btnApplyLinkedIn');
const btnApplyIndeed = $('btnApplyIndeed');
const btnApplyCompany = $('btnApplyCompany');
const btnRunAll = $('btnRunAll');
const btnSaveAuth = $('btnSaveAuth');
const btnStopBot = $('btnStopBot');

[btnApplyNaukri, btnApplyLinkedIn, btnApplyIndeed].forEach((btn) => {
  if (!btn) return;
  btn.addEventListener('click', () => {
    const platform = btn.dataset.platform;
    botAction('start', { platform });
    toast(`Summoning the god of ${platform}…`, 'info');
  });
});
if (btnApplyCompany) {
  btnApplyCompany.addEventListener('click', () => {
    const url = $('companyUrlInput')?.value.trim() || '';
    const payload = { platform: 'company' };
    if (url) payload.url = url;
    botAction('start', payload);
    toast(url ? `Hephaestus rides to ${url}…` : 'Summoning Hephaestus…', 'info');
  });
}
const companyUrlInput = $('companyUrlInput');
const companyBtnSub = $('companyBtnSub');
if (companyUrlInput && companyBtnSub) {
  companyUrlInput.addEventListener('input', () => {
    const v = companyUrlInput.value.trim();
    try {
      const host = v ? new URL(v).hostname.replace(/^www\./, '') : '';
      companyBtnSub.textContent = host ? `→ ${host}` : 'Direct to the forge';
    } catch (_) { companyBtnSub.textContent = v ? v.slice(0, 24) + '…' : 'Direct to the forge'; }
  });
}
on('btnCompanyUrlClear', 'click', () => {
  if (companyUrlInput) companyUrlInput.value = '';
  if (companyBtnSub) companyBtnSub.textContent = 'Direct to the forge';
});
if (btnRunAll) btnRunAll.addEventListener('click', () => { botAction('start', {}); toast('Unleashing the full pantheon…', 'info'); });
if (btnStopBot) btnStopBot.addEventListener('click', () => { botAction('stop'); toast('Banishing Hermes…', 'info'); });
if (btnSaveAuth) {
  btnSaveAuth.addEventListener('click', async () => {
    btnSaveAuth.disabled = true;
    const lbl = btnSaveAuth.querySelector('.qa-label');
    const orig = lbl ? lbl.textContent : '';
    if (lbl) lbl.textContent = '⏳ Forging…';
    toast('A browser opens — log in to forge the keys', 'info');
    try {
      const d = await fetch('/api/bot/save-auth', { method: 'POST' }).then((r) => r.json());
      if (d.success || d.status === 'launched') {
        toast('🗝️ Keys forging — log in, then close the window', 'ok');
        appendLog('info', '🗝️ Forge the Keys launched — complete login in the opened browser');
      } else toast('Forge failed: ' + (d.error || 'unknown'), 'err');
    } catch (e) { toast('Forge failed: ' + e.message, 'err'); }
    if (lbl) lbl.textContent = orig;
    btnSaveAuth.disabled = false;
  });
}

/* ── Topbar Start/Stop + run timer ────────────────────────────────────────── */
let topTimerInterval = null;
function setTopStatus(status, startedAt) {
  const dot = $('topStatusDot'), label = $('topStatusLabel'), timer = $('topTimer');
  const start = $('topBtnStart'), stop = $('topBtnStop');
  const running = status === 'running';
  if (dot) dot.className = 'status-dot ' + (running ? 'running' : status === 'error' ? 'error' : 'idle');
  if (label) label.textContent = running ? 'Hermes flies' : status === 'stopping' ? 'Hermes lands…' : 'Hermes rests';
  if (start) start.disabled = running;
  if (stop) stop.disabled = !running;
  if (running && startedAt) {
    const t0 = new Date(startedAt);
    if (!topTimerInterval) {
      topTimerInterval = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        if (timer) timer.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      }, 1000);
    }
  } else { clearInterval(topTimerInterval); topTimerInterval = null; if (timer) timer.textContent = ''; }
}
socket.on('bot:status', (d) => setTopStatus(d.status, d.startedAt));
on('topBtnStart', 'click', () => fetch('/api/bot/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
on('topBtnStop', 'click', () => fetch('/api/bot/stop', { method: 'POST' }));
socket.on('start_bot_trigger', () => fetch('/api/bot/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
socket.on('stop_bot_trigger', () => fetch('/api/bot/stop', { method: 'POST' }));

/* ═══════════════ THE ORACLE (AI engine: Ollama + toggle) ════════════════════ */
function checkOllama() {
  const dot = $('ollamaDot'), label = $('ollamaLabel');
  fetch('/api/ollama/status').then((r) => r.json()).then((d) => {
    if (d.running) { if (dot) dot.className = 'ollama-dot ok'; if (label) label.textContent = 'The Oracle is awake'; }
    else { if (dot) dot.className = 'ollama-dot err'; if (label) label.textContent = 'The Oracle slumbers'; }
  }).catch(() => { if (dot) dot.className = 'ollama-dot err'; if (label) label.textContent = 'The Oracle slumbers'; });
}

async function loadOracleSpirits() {
  try {
    const { models = [], current } = await fetch('/api/ollama/models').then((r) => r.json());
    const sel = $('aiModelSelect');
    if (sel) {
      sel.innerHTML = models.length
        ? models.map((m) => `<option value="${esc(m.name)}" ${m.name === current ? 'selected' : ''}>${esc(m.name)}</option>`).join('')
        : `<option value="${esc(current || 'qwen2.5:7b')}">${esc(current || 'qwen2.5:7b')}</option>`;
    }
    const dl = $('aiModelDatalist');
    if (dl) dl.innerHTML = models.map((m) => `<option value="${esc(m.name)}">`).join('');
    const cfgInput = $('cfgAiModel');
    if (cfgInput && current && !cfgInput.value) cfgInput.value = current;
    const badge = $('modelCountBadge');
    if (badge) {
      if (models.length > 1) { badge.textContent = models.length + ' spirits'; badge.style.display = ''; }
      else badge.style.display = 'none';
    }
  } catch (_) {}
}
async function switchSpirit(model) {
  if (!model) return;
  try {
    await fetch('/api/ollama/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    const inp = $('cfgAiModel'); if (inp) inp.value = model;
  } catch (_) {}
}
on('aiModelSelect', 'change', (e) => switchSpirit(e.target.value));

socket.on('ai:query_start', ({ model, provider }) => {
  const disp = $('aiTimerDisplay'), val = $('aiTimerVal');
  if (disp) disp.style.display = '';
  if (val) val.textContent = `⏳ ${model || provider || '…'} divines…`;
});
socket.on('ai:query_done', ({ model, elapsedMs, error }) => {
  const disp = $('aiTimerDisplay'), val = $('aiTimerVal');
  if (disp) disp.style.display = '';
  if (val) {
    if (elapsedMs > 0) val.textContent = `${(elapsedMs / 1000).toFixed(2)}s — ${model || ''}${error ? ' ❌' : ' ✅'}`;
    else val.textContent = error ? `❌ ${String(error).slice(0, 40)}` : '–';
  }
});
socket.on('ai:model_changed', ({ model, models }) => {
  const sel = $('aiModelSelect');
  if (sel && model) {
    if (models && models.length) sel.innerHTML = models.map((m) => `<option value="${esc(m.name)}" ${m.name === model ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    else sel.value = model;
  }
  const inp = $('cfgAiModel'); if (inp && model) inp.value = model;
});
socket.on('ai:startup_log', () => loadOracleSpirits());

/* Oracle toggle (AI on/off) */
let oracleOn = true;
function setOracleToggle(enabled) {
  oracleOn = enabled;
  const pill = $('aiTogglePill'), label = $('aiToggleLabel');
  if (pill) pill.classList.toggle('on', enabled);
  if (label) {
    label.textContent = enabled ? '🔮 Oracle Awake' : '⚡ Keyword Augury';
    label.classList.toggle('on', enabled);
  }
}
fetch('/api/ai-mode').then((r) => r.json()).then((d) => setOracleToggle(d.aiEnabled !== false)).catch(() => {});
on('aiToggleWrap', 'click', () => {
  const next = !oracleOn;
  setOracleToggle(next);
  fetch('/api/ai-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiEnabled: next }) })
    .then((r) => r.json()).then((d) => setOracleToggle(d.aiEnabled !== false)).catch(() => setOracleToggle(!next));
});
socket.on('ai_mode', (d) => setOracleToggle(d.aiEnabled !== false));

/* ═══════════════ PANTHEON (portal live dots + bar chart) ════════════════════ */
function canonicalPortal(raw) {
  const lower = (raw || '').toLowerCase();
  return { naukri: 'Naukri', linkedin: 'Linkedin', indeed: 'Indeed', company: 'Company' }[lower] || raw;
}
const portalDotMap = { Naukri: 'pd-naukri', Linkedin: 'pd-linkedin', Indeed: 'pd-indeed', Company: 'pd-company' };
const portalStats = {
  Naukri: { applied: 0, skipped: 0, failed: 0 }, Linkedin: { applied: 0, skipped: 0, failed: 0 },
  Indeed: { applied: 0, skipped: 0, failed: 0 }, Company: { applied: 0, skipped: 0, failed: 0 },
};
function updatePortalDot(portal, status) {
  const dot = $(portalDotMap[canonicalPortal(portal)]);
  if (dot) dot.className = 'portal-live-dot' + (status === 'started' ? ' active' : '');
}
function updatePortalStat(portal, key, delta) {
  const p = canonicalPortal(portal);
  if (!portalStats[p]) return;
  portalStats[p][key] = (portalStats[p][key] || 0) + delta;
  const el = $('ps-' + p.toLowerCase() + '-' + key);
  if (el) el.textContent = portalStats[p][key];
  updatePortalChart();
}
socket.on('portal', (d) => updatePortalDot(d.portal, d.status));
socket.on('applied', (d) => updatePortalStat(d.portal, 'applied', 1));
socket.on('job_scored', (d) => { if (d.decision === 'SKIP') updatePortalStat(d.portal, 'skipped', 1); });
socket.on('error', (d) => updatePortalStat(d.portal, 'failed', 1));

let portalChart = null;
function updatePortalChart() {
  const canvas = $('cPortals');
  if (!canvas) return;
  const labels = ['Zeus · Naukri', 'Athena · LinkedIn', 'Poseidon · Indeed', 'Hephaestus · Company'];
  const keys = ['Naukri', 'Linkedin', 'Indeed', 'Company'];
  const data = {
    labels,
    datasets: [
      { label: 'Conquered', data: keys.map((k) => portalStats[k]?.applied || 0), backgroundColor: COL.applied, borderRadius: 4 },
      { label: 'Spared',    data: keys.map((k) => portalStats[k]?.skipped || 0), backgroundColor: COL.skipped, borderRadius: 4 },
      { label: 'Fallen',    data: keys.map((k) => portalStats[k]?.failed || 0),  backgroundColor: COL.failed,  borderRadius: 4 },
    ],
  };
  if (portalChart) { portalChart.data = data; portalChart.update(); return; }
  portalChart = new Chart(canvas, { type: 'bar', data, options: chartBase() });
}
(function loadInitialPortalStats() {
  fetch('/api/stats/portals').then((r) => r.json()).then((data) => {
    Object.entries(data).forEach(([rawPortal, stats]) => {
      const p = canonicalPortal(rawPortal);
      if (!portalStats[p]) return;
      ['applied', 'skipped', 'failed'].forEach((k) => {
        portalStats[p][k] = stats[k] || 0;
        const el = $('ps-' + p.toLowerCase() + '-' + k);
        if (el) el.textContent = portalStats[p][k];
      });
    });
    updatePortalChart();
  }).catch(() => {});
})();

/* ═══════════════ DIVINE SCROLLS (cover letters) ═════════════════════════════ */
let coverJobs = [];
let selectedCoverJob = null;
function loadCoverJobs() {
  fetch('/api/jobs').then((r) => r.json()).then((jobs) => {
    coverJobs = (jobs || []).filter((j) => j.apply_status === 'success' || j.status === 'applied');
    const list = $('coverJobList'), empty = $('coverEmpty');
    if (!list) return;
    list.querySelectorAll('.cover-list-item').forEach((e) => e.remove());
    if (!coverJobs.length) { if (empty) empty.style.display = ''; return; }
    if (empty) empty.style.display = 'none';
    coverJobs.forEach((j) => {
      const el = document.createElement('div');
      el.className = 'cover-list-item';
      el.innerHTML = `<div class="cl-title">${esc(j.title || 'Untitled')}</div><div class="cl-co">${esc(j.company || '')}</div>`;
      el.addEventListener('click', () => selectCoverJob(j, el));
      list.appendChild(el);
    });
  }).catch(() => {});
}
function selectCoverJob(job, el) {
  selectedCoverJob = job;
  document.querySelectorAll('.cover-list-item').forEach((e) => e.classList.remove('active'));
  el.classList.add('active');
  const t = $('coverJobTitle'); if (t) t.textContent = (job.title || '') + ' @ ' + (job.company || '');
  const g = $('btnGenCover'); if (g) g.disabled = false;
}
async function generateCoverLetter() {
  if (!selectedCoverJob) return;
  const out = $('coverOutput'), gen = $('btnGenCover'), cp = $('btnCopyCover'), rg = $('btnRegenCover');
  if (out) out.textContent = '🪶 The Oracle pens your scroll…';
  if (gen) gen.disabled = true;
  try {
    const data = await fetch('/api/cover-letter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job: selectedCoverJob }) }).then((r) => r.json());
    if (out) out.textContent = data.letter || '(the Oracle returned silence)';
    if (cp) cp.disabled = false;
    if (rg) rg.disabled = false;
  } catch (err) { if (out) out.textContent = 'Error: ' + err.message; }
  finally { if (gen) gen.disabled = false; }
}
on('btnGenCover', 'click', generateCoverLetter);
on('btnRegenCover', 'click', generateCoverLetter);
on('btnCopyCover', 'click', () => {
  const txt = $('coverOutput')?.textContent;
  if (txt) navigator.clipboard.writeText(txt).then(() => toast('Scroll copied', 'ok')).catch(() => {});
});

/* ═══════════════ Shared renderers ═══════════════════════════════════════════ */
function jobLinkCell(j) {
  const url = j.url || '';
  if (url) {
    try {
      const u = new URL(url);
      const isNaukri = u.hostname.includes('naukri.com');
      const label = isNaukri ? 'Naukri' : u.hostname.replace(/^www\./, '');
      const icon = isNaukri ? '🌩️' : '🔗';
      return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}" style="font-size:12px;white-space:nowrap">${icon} ${esc(label)}</a>`;
    } catch (_) {
      return `<a href="${esc(url)}" target="_blank" style="font-size:12px">🔗 Open</a>`;
    }
  }
  const title = (j.title || '').trim();
  if (title && title !== 'Unknown') {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `<a href="https://www.naukri.com/${slug}-jobs" target="_blank" rel="noopener noreferrer" title="Seek: ${esc(title)}" style="color:var(--tx3);font-size:12px;white-space:nowrap">🔍 Seek</a>`;
  }
  return '–';
}
function scoreBar(score) {
  const n = parseInt(score) || 0;
  const c = n >= 80 ? '#3ecf8e' : n >= 60 ? '#5ea2e8' : n >= 40 ? '#e8b341' : '#e25c5c';
  return `<div class="sbar"><div class="sbar-bg"><div class="sbar-fill" style="width:${n}%;background:${c}"></div></div><span class="sbar-num">${n}</span></div>`;
}
function statusBadge(s) {
  const map = { success: 'b-green', applied: 'b-green', skipped: 'b-amber', failed: 'b-red', pending: 'b-muted', external: 'b-blue' };
  const txt = { success: '⚔️ Conquered', applied: '⚔️ Conquered', skipped: '🕊️ Spared', failed: '💀 Fallen', pending: '⏳ Fated', external: '🔗 Beyond' };
  return `<span class="badge ${map[s] || 'b-muted'}">${txt[s] || esc(s)}</span>`;
}
function fmtDate(d) {
  if (!d) return '–';
  const dt = new Date(d);
  return isNaN(dt) ? d : dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}
function detectLevel(msg) {
  if (/error|fail|exception/i.test(msg)) return 'error';
  if (/warn|skip/i.test(msg)) return 'warn';
  if (/applied|success|✅|conquer/i.test(msg)) return 'success';
  return 'info';
}

/* ═══════════════ INIT ═══════════════════════════════════════════════════════ */
(async () => {
  await loadDashboard();
  loadConfig();
  loadOracleSpirits();
  checkOllama();
  setInterval(checkOllama, 30000);
  try { const s = await fetch('/api/bot/status').then((r) => r.json()); setBotUI(s); setTopStatus(s.status, s.startedAt); } catch (_) {}
  setInterval(loadDashboard, 30000);
})();
