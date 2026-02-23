'use strict';

/**
 * Express + Socket.io dashboard server.
 */

const express = require('express');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const path = require('path');
const cors = require('cors');
const db = require('../db/db');
const logger = require('../utils/logger');
const { runSelfLearnCycle } = require('../ai/aiAgent');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SCREENSHOTS_DIR = path.join(process.cwd(), 'data', 'screenshots');

let io; // exported for the worker to emit events

function createDashboardServer(port = 3000) {
  const app = express();
  const server = http.createServer(app);
  io = new SocketServer(server, {
    cors: { origin: '*' },
  });

  app.use(cors());
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  // Serve screenshots statically
  app.use('/screenshots', express.static(SCREENSHOTS_DIR));

  // --- REST API ---

  app.get('/api/stats', (req, res) => {
    try {
      const stats = db.getStats();
      res.json(stats);
    } catch (err) {
      logger.error('GET /api/stats error', { err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/jobs', (req, res) => {
    try {
      const jobs = db.getAppliedJobs(200);
      res.json(jobs);
    } catch (err) {
      logger.error('GET /api/jobs error', { err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/jobs/all', (req, res) => {
    try {
      const jobs = db.getAllJobs(500);
      res.json(jobs);
    } catch (err) {
      logger.error('GET /api/jobs/all error', { err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/export/csv', (req, res) => {
    try {
      const csv = db.exportAppliedJobsCsv();
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="applied_jobs.csv"');
      res.send(csv);
    } catch (err) {
      logger.error('GET /api/export/csv error', { err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/screenshots/:jobId', (req, res) => {
    try {
      const shots = db.getScreenshotsForJob(req.params.jobId);
      res.json(shots);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/jobs/recent', (req, res) => {
    try {
      const d = db.getDb();
      const rows = d.prepare(`SELECT job_id,title,company,apply_status,score,created_at FROM jobs ORDER BY created_at DESC LIMIT 20`).all();
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/jobs/trend', (req, res) => {
    try {
      const d = db.getDb();
      const rows = d.prepare(`
        SELECT date(created_at) as day,
          SUM(CASE WHEN apply_status='success' THEN 1 ELSE 0 END) as applied,
          SUM(CASE WHEN apply_status='skipped' THEN 1 ELSE 0 END) as skipped,
          SUM(CASE WHEN apply_status='failed'  THEN 1 ELSE 0 END) as failed
        FROM jobs
        WHERE created_at >= date('now','-14 days')
        GROUP BY day ORDER BY day ASC
      `).all();
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/jobs/top-companies', (req, res) => {
    try {
      const d = db.getDb();
      const rows = d.prepare(`
        SELECT company, COUNT(*) as total,
          SUM(CASE WHEN apply_status='success' THEN 1 ELSE 0 END) as applied
        FROM jobs WHERE company IS NOT NULL AND company != ''
        GROUP BY company ORDER BY total DESC LIMIT 8
      `).all();
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/jobs/score-dist', (req, res) => {
    try {
      const d = db.getDb();
      const rows = d.prepare(`
        SELECT
          CASE
            WHEN score >= 90 THEN '90-100'
            WHEN score >= 75 THEN '75-89'
            WHEN score >= 60 THEN '60-74'
            WHEN score >= 40 THEN '40-59'
            ELSE 'Below 40'
          END as range,
          COUNT(*) as count
        FROM jobs GROUP BY range ORDER BY range DESC
      `).all();
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Learning List API ---

  app.get('/api/learning', (req, res) => {
    try {
      const rows = db.getLearningQuestions(200);
      res.json(rows);
    } catch (err) {
      logger.error('GET /api/learning error', { err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/learning/:id', (req, res) => {
    try {
      const { answer } = req.body;
      if (typeof answer !== 'string') return res.status(400).json({ error: 'answer is required' });
      db.updateLearningAnswer(Number(req.params.id), answer.trim());
      res.json({ success: true });
    } catch (err) {
      logger.error('PATCH /api/learning/:id error', { err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // Trigger a self-learn cycle on demand
  let selfLearnRunning = false;
  app.post('/api/learning/self-learn', async (req, res) => {
    if (selfLearnRunning) return res.json({ status: 'already_running' });
    try {
      selfLearnRunning = true;
      logger.info('[SelfLearn] Manual cycle triggered from dashboard');
      const result = await runSelfLearnCycle();
      io.emit('selflearn:done', result);
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error('POST /api/learning/self-learn error', { err: err.message });
      res.status(500).json({ error: err.message });
    } finally {
      selfLearnRunning = false;
    }
  });

  // Serve the dashboard SPA for all unmatched routes
  app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // --- Socket.io ---
  io.on('connection', (socket) => {
    logger.debug(`Dashboard client connected: ${socket.id}`);

    // Send initial data on connect
    try {
      socket.emit('init:stats', db.getStats());
      socket.emit('init:jobs', db.getAppliedJobs(50));
    } catch (err) {
      logger.warn('Could not send init data', { err: err.message });
    }

    socket.on('disconnect', () => {
      logger.debug(`Dashboard client disconnected: ${socket.id}`);
    });
  });

  server.listen(port, () => {
    logger.info(`Dashboard running at http://localhost:${port}`);

    // ── Auto self-learn scheduler ──────────────────────────────────────────
    // First run: 30 s after boot (handles questions captured right at startup)
    // Subsequent runs: every 5 minutes
    const SELF_LEARN_INTERVAL = 5 * 60 * 1000; // 5 min
    const runCycle = async () => {
      if (selfLearnRunning) return;
      selfLearnRunning = true;
      try {
        const result = await runSelfLearnCycle();
        if (result.answered > 0) {
          io.emit('selflearn:done', result);
          logger.info(`[SelfLearn] Scheduled cycle auto-answered ${result.answered}/${result.processed}`);
        }
      } catch (err) {
        logger.warn('[SelfLearn] Scheduled cycle error', { err: err.message });
      } finally {
        selfLearnRunning = false;
      }
    };
    setTimeout(runCycle, 30_000);
    setInterval(runCycle, SELF_LEARN_INTERVAL);
  });


  return { app, server, io };
}

/**
 * Emit an event to all connected dashboard clients.
 */
function emitToClients(event, data) {
  if (io) {
    io.emit(event, data);
    try {
      // Also push updated stats with every event
      io.emit('stats:update', db.getStats());
    } catch (_) {}
  }
}

module.exports = { createDashboardServer, emitToClients };
