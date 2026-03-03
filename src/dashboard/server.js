'use strict';
/**
 * Dashboard server v3 — all features:
 * stats, jobs, learning, bot control, config, keywords,
 * blocklist, resume upload+AI-learn, CSV import/export,
 * screenshot stream, profile editor, selector editor
 */

const express   = require('express');
const http      = require('http');
const { Server: SocketServer } = require('socket.io');
const path      = require('path');
const fs        = require('fs');
const cors      = require('cors');
const { spawn } = require('child_process');
const multer    = require('multer');

const db       = require('../db/db');
const logger   = require('../utils/logger');
const { runSelfLearnCycle, askAI } = require('../ai/aiAgent');
const { seedLearningList }         = require('../db/seedLearningList');

const PUBLIC_DIR      = path.join(__dirname, 'public');
const SCREENSHOTS_DIR = path.join(process.cwd(), 'data', 'screenshots');
const CONFIG_PATH     = path.join(process.cwd(), 'config', 'config.json');
const LOG_PATH        = path.join(process.cwd(), 'logs', 'app.log');
const RESUME_PATH     = path.join(process.cwd(), 'data', 'resume_extracted.txt');

const upload = multer({ dest: path.join(process.cwd(), 'data', 'uploads') });

let io;
let botProcess   = null;
let botStatus    = 'idle';
let botStartedAt = null;
let selfLearnRunning = false;

function getBotState() {
  return { status: botStatus, startedAt: botStartedAt, pid: botProcess ? botProcess.pid : null };
}

function normaliseStats(raw) {
  if (!raw) return { total: 0, applied: 0, skipped: 0, failed: 0, pending: 0, successRate: 0 };
  const total   = raw.total_scanned || 0;
  const applied = raw.success_count || 0;
  const skipped = raw.total_skipped || 0;
  const failed  = raw.fail_count    || 0;
  const pending = Math.max(0, (raw.total_applied || 0) - applied - failed);
  const rate    = total > 0 ? Math.round((applied / total) * 100) : 0;
  return { total, applied, skipped, failed, pending, successRate: rate, raw };
}

function readConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
function writeConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

// ── CSV helpers ────────────────────────────────────────────────────────────
function toCsv(rows, cols) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}
function fromCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = line.match(/("(?:[^"]|"")*"|[^,]*)/g) || [];
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/^"|"$/g, '').replace(/""/g, '"').trim(); });
    return obj;
  });
}

function createDashboardServer(port = 3000) {
  const app    = express();
  const server = http.createServer(app);
  io = new SocketServer(server, { cors: { origin: '*' } });

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(PUBLIC_DIR));
  app.use('/screenshots', express.static(SCREENSHOTS_DIR));

  // ── Stats ─────────────────────────────────────────────────────────────
  app.get('/api/stats', (req, res) => {
    try { res.json(normaliseStats(db.getStats())); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Jobs ──────────────────────────────────────────────────────────────
  app.get('/api/jobs/all', (req, res) => {
    try { res.json(db.getAllJobs(500)); } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/jobs', (req, res) => {
    try { res.json(db.getAppliedJobs(200)); } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/jobs/recent', (req, res) => {
    try {
      const d = db.getDb();
      const rows = d.prepare(`SELECT job_id,title,company,apply_status,score,created_at,location,url FROM jobs ORDER BY created_at DESC LIMIT 20`).all();
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/jobs/trend', (req, res) => {
    try {
      const rows = db.getDb().prepare(`
        SELECT date(created_at) as day,
          SUM(CASE WHEN apply_status='success' THEN 1 ELSE 0 END) as applied,
          SUM(CASE WHEN apply_status='skipped' THEN 1 ELSE 0 END) as skipped,
          SUM(CASE WHEN apply_status='failed'  THEN 1 ELSE 0 END) as failed,
          COUNT(*) as total
        FROM jobs WHERE created_at >= date('now','-14 days')
        GROUP BY day ORDER BY day ASC`).all();
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/jobs/top-companies', (req, res) => {
    try {
      const rows = db.getDb().prepare(`
        SELECT company, COUNT(*) as total,
          SUM(CASE WHEN apply_status='success' THEN 1 ELSE 0 END) as applied
        FROM jobs WHERE company IS NOT NULL AND company != ''
        GROUP BY company ORDER BY total DESC LIMIT 8`).all();
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/jobs/score-dist', (req, res) => {
    try {
      const rows = db.getDb().prepare(`
        SELECT CASE
            WHEN score >= 90 THEN '90-100' WHEN score >= 75 THEN '75-89'
            WHEN score >= 60 THEN '60-74'  WHEN score >= 40 THEN '40-59'
            ELSE 'Below 40' END as range, COUNT(*) as count
        FROM jobs GROUP BY range ORDER BY range DESC`).all();
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Jobs CSV export
  app.get('/api/jobs/export/csv', (req, res) => {
    try {
      const jobs = db.getAllJobs(5000);
      const csv  = toCsv(jobs, ['job_id','title','company','location','url','decision','score','reason','apply_status','created_at']);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="jobs_export.csv"');
      res.send(csv);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  // Alias
  app.get('/api/export/csv', (req, res) => res.redirect('/api/jobs/export/csv'));

  // Jobs CSV import
  app.post('/api/jobs/import/csv', express.text({ type: 'text/csv', limit: '10mb' }), (req, res) => {
    try {
      const rows = fromCsv(req.body);
      let inserted = 0;
      for (const r of rows) {
        if (!r.title || !r.company) continue;
        db.upsertJob({
          job_id:       r.job_id || `${r.title}_${r.company}_${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g,'_').substring(0,80),
          title:        r.title, company: r.company, location: r.location || '',
          url:          r.url || '', description: r.description || '',
          decision:     r.decision || 'PENDING', score: Number(r.score) || 0,
          reason:       r.reason || '', apply_status: r.apply_status || 'pending',
        });
        inserted++;
      }
      io.emit('stats:update', normaliseStats(db.getStats()));
      res.json({ success: true, inserted });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Screenshots
  app.get('/api/screenshots/:jobId', (req, res) => {
    try { res.json(db.getScreenshotsForJob(req.params.jobId)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  // Latest screenshot stream (for Live Browser view)
  app.get('/api/screenshot/latest', (req, res) => {
    try {
      const imgFile = getLatestScreenshot();
      if (!imgFile) return res.status(404).json({ error: 'No screenshots yet' });
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(imgFile);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/screenshot/latest-path', (req, res) => {
    const imgFile = getLatestScreenshot();
    res.json({ path: imgFile ? `/screenshots/${path.relative(SCREENSHOTS_DIR, imgFile).replace(/\\/g, '/')}` : null });
  });

  // ── Keywords ──────────────────────────────────────────────────────────
  app.get('/api/keywords', (req, res) => {
    try { const c = readConfig(); res.json(c.keywords || { required: [], preferred: [], excluded: [] }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.put('/api/keywords', (req, res) => {
    try {
      const cfg = readConfig();
      cfg.keywords = { required: req.body.required || [], preferred: req.body.preferred || [], excluded: req.body.excluded || [] };
      writeConfig(cfg);
      res.json({ success: true });
      addLog('info', `Keywords updated: ${cfg.keywords.excluded.length} excluded, ${cfg.keywords.required.length} required`);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Profile editor ────────────────────────────────────────────────────
  app.get('/api/profile', (req, res) => {
    try { const c = readConfig(); res.json(c.profile || {}); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.put('/api/profile', (req, res) => {
    try {
      const cfg = readConfig();
      cfg.profile = { ...(cfg.profile || {}), ...req.body };
      writeConfig(cfg);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Selectors editor ──────────────────────────────────────────────────
  app.get('/api/selectors', (req, res) => {
    try { const c = readConfig(); res.json(c.selector || {}); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.put('/api/selectors', (req, res) => {
    try {
      const cfg = readConfig();
      cfg.selector = { ...(cfg.selector || {}), ...req.body };
      writeConfig(cfg);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Config read/write ─────────────────────────────────────────────────
  app.get('/api/config', (req, res) => {
    try {
      const cfg = { ...readConfig() }; delete cfg.geminiApiKey;
      res.json(cfg);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.patch('/api/config', (req, res) => {
    try {
      const allowed = ['jobTitle','searchLocation','maxJobs','maxAppsPerRun','scoreThreshold','aiModel',
                       'ollamaBaseUrl','ollamaTimeout','skipAI','maxPagesPerSearch','delayBetweenJobs',
                       'headless','delayMin','delayMax','safetyMode','slowMo','resumePath'];
      const cfg = readConfig();
      for (const k of allowed) { if (req.body[k] !== undefined) cfg[k] = req.body[k]; }
      writeConfig(cfg);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Bot Control ───────────────────────────────────────────────────────
  app.get('/api/bot/status', (req, res) => res.json(getBotState()));

  app.post('/api/bot/start', (req, res) => {
    if (botProcess && botStatus === 'running') {
      return res.json({ status: 'already_running', message: 'Bot is already running' });
    }
    const targetPlatform = req.body.platform || 'naukri';
    try {
      botProcess   = spawn(process.execPath, ['src/index.js', '--worker-only', `--platform=${targetPlatform}`], { cwd: process.cwd(), env: { ...process.env } });
      botStatus    = 'running';
      botStartedAt = new Date().toISOString();
      botProcess.stdout.on('data', d => {
        const msg = d.toString().trim();
        if (msg) {
          io.emit('bot:log', { level: detectLevel(msg), msg, ts: new Date().toISOString() });
          if (/applied|success/i.test(msg)) io.emit('stats:update', normaliseStats(db.getStats()));
        }
      });
      botProcess.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg) io.emit('bot:log', { level: 'error', msg, ts: new Date().toISOString() });
      });
      botProcess.on('exit', code => {
        botStatus = 'idle'; botProcess = null; botStartedAt = null;
        io.emit('bot:status', getBotState());
        io.emit('bot:log', { level: 'info', msg: `Bot exited (code ${code})`, ts: new Date().toISOString() });
        io.emit('stats:update', normaliseStats(db.getStats()));
      });
      io.emit('bot:status', getBotState());
      logger.info(`[BotCtrl] Started (pid=${botProcess.pid})`);
      res.json({ success: true, ...getBotState() });
    } catch (err) { botStatus = 'idle'; res.status(500).json({ error: err.message }); }
  });

  app.post('/api/bot/stop', (req, res) => {
    if (!botProcess) { botStatus = 'idle'; io.emit('bot:status', getBotState()); return res.json({ status: 'idle' }); }
    try {
      botStatus = 'stopping'; io.emit('bot:status', getBotState());
      botProcess.kill('SIGTERM');
      setTimeout(() => {
        if (botProcess) { try { botProcess.kill('SIGKILL'); } catch (_) {} botProcess = null; botStartedAt = null; botStatus = 'idle'; io.emit('bot:status', getBotState()); }
      }, 5000);
      res.json({ success: true, ...getBotState() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/bot/restart', async (req, res) => {
    if (botProcess) { try { botProcess.kill('SIGTERM'); } catch (_) {} }
    botProcess = null; botStartedAt = null; botStatus = 'idle';
    io.emit('bot:status', getBotState());
    await new Promise(r => setTimeout(r, 1200));
    // Re-trigger start
    const fakeRes = { json: () => {}, status: () => ({ json: () => {} }) };
    app._router.handle({ method: 'POST', url: '/api/bot/start', path: '/api/bot/start', body: {} }, fakeRes, () => {});
    res.json({ success: true, message: 'Restarting…' });
  });

  // ── Blocklist ─────────────────────────────────────────────────────────
  const BLOCK_PATH = path.join(process.cwd(), 'data', 'blocklist.json');
  function readBlocklist() { try { return JSON.parse(fs.readFileSync(BLOCK_PATH, 'utf8')); } catch { return []; } }
  function writeBlocklist(l) { fs.mkdirSync(path.dirname(BLOCK_PATH), { recursive: true }); fs.writeFileSync(BLOCK_PATH, JSON.stringify(l, null, 2)); }
  app.get('/api/blocklist',             (req, res) => res.json(readBlocklist()));
  app.post('/api/blocklist',            (req, res) => {
    const { company } = req.body;
    if (!company) return res.status(400).json({ error: 'company required' });
    const list = readBlocklist(); if (!list.includes(company)) { list.push(company); writeBlocklist(list); }
    res.json({ success: true, list });
  });
  app.delete('/api/blocklist/:company', (req, res) => {
    let list = readBlocklist().filter(c => c !== decodeURIComponent(req.params.company));
    writeBlocklist(list); res.json({ success: true, list });
  });

  // ── Learning List ─────────────────────────────────────────────────────
  app.get('/api/learning', (req, res) => {
    try { res.json(db.getLearningQuestions(500)); } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/learning', (req, res) => {
    const { question, answer, answerKey } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    try { db.addManualLearningQuestion(question, answer, answerKey); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.patch('/api/learning/:id', (req, res) => {
    try {
      const { answer } = req.body;
      if (typeof answer !== 'string') return res.status(400).json({ error: 'answer required' });
      db.updateLearningAnswer(Number(req.params.id), answer.trim()); res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.delete('/api/learning/:id', (req, res) => {
    try {
      const result = db.deleteLearningQuestion(Number(req.params.id));
      if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Learning CSV export
  app.get('/api/learning/export/csv', (req, res) => {
    try {
      const rows = db.getLearningQuestions(5000);
      const csv  = toCsv(rows, ['id','question','answer_key','answer','answered','field_type','options','asked_count']);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="learning_export.csv"');
      res.send(csv);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Learning CSV import
  app.post('/api/learning/import/csv', express.text({ type: 'text/csv', limit: '5mb' }), (req, res) => {
    try {
      const rows = fromCsv(req.body);
      let inserted = 0;
      for (const r of rows) {
        if (!r.question) continue;
        try {
          db.addManualLearningQuestion(r.question.trim(), r.answer || '', r.answer_key || undefined);
          inserted++;
        } catch (_) {}
      }
      res.json({ success: true, inserted });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Self-learn ────────────────────────────────────────────────────────
  app.post('/api/learning/self-learn', async (req, res) => {
    if (selfLearnRunning) return res.json({ status: 'already_running' });
    selfLearnRunning = true;
    try {
      const result = await runSelfLearnCycle();
      io.emit('selflearn:done', result);
      res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { selfLearnRunning = false; }
  });

  // ── Resume Upload + Extract + AI Auto-Learn ───────────────────────────
  app.post('/api/resume/upload', upload.single('resume'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      let text = '';
      if (req.file.originalname.endsWith('.pdf')) {
        const pdfParse = require('pdf-parse');
        const buf = fs.readFileSync(req.file.path);
        const parsed = await pdfParse(buf);
        text = parsed.text;
      } else {
        text = fs.readFileSync(req.file.path, 'utf8');
      }
      fs.mkdirSync(path.dirname(RESUME_PATH), { recursive: true });
      fs.writeFileSync(RESUME_PATH, text);
      res.json({ success: true, text, length: text.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/resume/content', (req, res) => {
    try {
      if (!fs.existsSync(RESUME_PATH)) return res.json({ text: '' });
      res.json({ text: fs.readFileSync(RESUME_PATH, 'utf8') });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/resume/save', (req, res) => {
    try {
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: 'text required' });
      fs.mkdirSync(path.dirname(RESUME_PATH), { recursive: true });
      fs.writeFileSync(RESUME_PATH, text);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/resume/auto-learn', async (req, res) => {
    if (selfLearnRunning) return res.json({ status: 'already_running' });
    selfLearnRunning = true;
    try {
      const text = req.body.text || (fs.existsSync(RESUME_PATH) ? fs.readFileSync(RESUME_PATH, 'utf8') : '');
      if (!text.trim()) return res.status(400).json({ error: 'Resume text is empty. Upload your resume first.' });

      const prompt = `You are a job application assistant. Based on the following resume/profile, generate a comprehensive list of question-answer pairs that would appear in job application forms.

RESUME/PROFILE:
${text.substring(0, 4000)}

Generate 30 question-answer pairs in this EXACT JSON format (no extra text):
[
  { "question": "...", "answer": "..." },
  ...
]

Include questions about:
- Personal info (name, email, phone, location)
- Experience (years, current role, previous roles, company names)
- Skills and tools mentioned in resume
- Education (degree, institution, year)
- Expected CTC / salary expectation
- Notice period
- Willingness to relocate
- Cover letter / summarize yourself
- Why are you looking for a job change
- Languages known (programming + spoken)
- Certifications if any
- LinkedIn / GitHub URLs if mentioned
- Any technical skills specifically mentioned

IMPORTANT: Return ONLY the JSON array, nothing else.`;

      const rawAI = await askAI(prompt, { temperature: 0.3, num_predict: 2000 });
      // Extract JSON from AI response
      const jsonMatch = rawAI.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('AI did not return valid JSON');
      const pairs = JSON.parse(jsonMatch[0]);

      let saved = 0;
      for (const pair of pairs) {
        if (!pair.question || !pair.answer) continue;
        try {
          db.addManualLearningQuestion(pair.question.trim(), pair.answer.trim());
          saved++;
        } catch (_) {}
      }

      io.emit('selflearn:done', { answered: saved, processed: pairs.length });
      res.json({ success: true, generated: pairs.length, saved, pairs });
    } catch (err) {
      logger.error('[ResumeLearn] Error', { err: err.message });
      res.status(500).json({ error: err.message });
    } finally { selfLearnRunning = false; }
  });

  // ── Logs ──────────────────────────────────────────────────────────────
  app.get('/api/logs/tail', (req, res) => {
    try {
      if (!fs.existsSync(LOG_PATH)) return res.json({ lines: [] });
      const content = fs.readFileSync(LOG_PATH, 'utf8');
      const lines = content.split('\n').filter(Boolean).slice(-100);
      res.json({ lines });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── DB summary ────────────────────────────────────────────────────────
  app.get('/api/db/summary', (req, res) => {
    try {
      const d = db.getDb();
      const jobCount   = d.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
      const learnCount = d.prepare('SELECT COUNT(*) as n FROM learning_questions').get().n;
      const answCount  = d.prepare("SELECT COUNT(*) as n FROM learning_questions WHERE answered=1").get().n;
      const shotCount  = d.prepare('SELECT COUNT(*) as n FROM screenshots').get().n;
      res.json({ jobs: jobCount, learning: learnCount, answered: answCount, screenshots: shotCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // SPA fallback
  app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // ── Socket.io ─────────────────────────────────────────────────────────
  io.on('connection', socket => {
    logger.debug(`[WS] ${socket.id} connected`);
    try {
      socket.emit('init:stats', normaliseStats(db.getStats()));
      socket.emit('init:jobs',  db.getAppliedJobs(50));
      socket.emit('bot:status', getBotState());
    } catch (err) { logger.warn('[WS] Init error', { err: err.message }); }
    socket.on('disconnect', () => logger.debug(`[WS] ${socket.id} disconnected`));
  });

  server.listen(port, () => {
    logger.info(`Dashboard v3 → http://localhost:${port}`);
    try { const c = readConfig(); seedLearningList(db.getDb(), c); } catch (_) {}

    // Auto self-learn every 5 min
    const cycle = async () => {
      if (selfLearnRunning) return;
      selfLearnRunning = true;
      try {
        const result = await runSelfLearnCycle();
        if (result.answered > 0) { io.emit('selflearn:done', result); }
      } catch (_) {} finally { selfLearnRunning = false; }
    };
    setTimeout(cycle, 30_000);
    setInterval(cycle, 5 * 60 * 1000);
  });

  return { app, server, io };
}

function emitToClients(event, data) {
  if (io) {
    io.emit(event, data);
    try { io.emit('stats:update', normaliseStats(db.getStats())); } catch (_) {}
  }
}

function detectLevel(msg) {
  if (/error|failed|exception/i.test(msg)) return 'error';
  if (/warn|skip/i.test(msg))  return 'warn';
  if (/applied|success/i.test(msg)) return 'success';
  return 'info';
}

function getLatestScreenshot() {
  try {
    let latest = null; let latestMtime = 0;
    const walkDir = dir => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walkDir(full);
        else if (/\.(png|jpg|jpeg|webp)$/i.test(f)) {
          if (stat.mtimeMs > latestMtime) { latestMtime = stat.mtimeMs; latest = full; }
        }
      }
    };
    walkDir(SCREENSHOTS_DIR);
    return latest;
  } catch { return null; }
}

module.exports = { createDashboardServer, emitToClients };
