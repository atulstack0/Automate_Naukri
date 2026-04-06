'use strict';

/**
 * src/index.js — AutoApply orchestrator.
 *
 * TWO MODES:
 *
 * 1. DASHBOARD MODE (default / npm start):
 *    Starts the Express dashboard on port 3000 and waits for
 *    socket "start_bot_trigger" to launch runBot().
 *
 * 2. WORKER-ONLY MODE (--worker-only flag):
 *    Spawned by server.js POST /api/bot/start as a child process.
 *    Runs the requested portal workers WITHOUT starting a dashboard.
 *    Args: --platform=<naukri|linkedin|indeed|company|all>
 *          --url=<https://...>   (optional, for company mode)
 */

const path = require('path');
const fs   = require('fs');

const logger             = require('./utils/logger');
const db                 = require('./db/db');
const { BrowserManager } = require('./browser/browser');
const { OllamaClient }   = require('./ai/ollamaClient');
const { initAIProvider } = require('./ai/aiProvider');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const isWorkerOnly  = process.argv.includes('--worker-only');
const platformArg   = process.argv.find(a => a.startsWith('--platform='));
const targetPlatform = platformArg ? platformArg.split('=')[1] : 'all';
const urlArg        = process.argv.find(a => a.startsWith('--url='));
const targetUrl     = urlArg ? urlArg.slice(6) : null;

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(process.cwd(), 'config', 'config.json');
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
let config;
try {
  config = loadConfig();
  logger.info(`[Main] config.json loaded (mode: ${isWorkerOnly ? 'worker-only' : 'dashboard'})`);
} catch (err) {
  logger.error('[Main] Cannot load config/config.json: ' + err.message);
  process.exit(1);
}

// ─── Global state (dashboard mode only) ──────────────────────────────────────
let isRunning      = false;
let stopRequested  = false;
let browserManager = null;

// ─────────────────────────────────────────────────────────────────────────────
// NullAI stub — keyword-only scoring when aiEnabled=false
// Uses the real localKeywordScore from ollamaClient.
// localKeywordScore expects: (text, { required:[], preferred:[], excluded:[] })
// It returns: { score, decision, reason }
// ─────────────────────────────────────────────────────────────────────────────
let _localKeywordScore;
try {
  _localKeywordScore = require('./ai/ollamaClient').localKeywordScore;
} catch (_) {
  _localKeywordScore = null;
}

function makeNullAI(cfg) {
  return {
    isOllamaRunning: async () => false,

    scoreJob({ title = '', company = '', description = '', keywords = [] }) {
      // Build combined text — description first for best keyword hits
      const text = `${description} ${title} ${company}`.trim();

      // localKeywordScore needs {required, preferred, excluded}
      // keywords here is a flat array (combined required+preferred from the caller)
      // Map it so required=all passed keywords, preferred=[], excluded=[]
      const kwObj = {
        required:  Array.isArray(keywords) ? keywords : [],
        preferred: Array.isArray(cfg.keywords?.preferred) ? cfg.keywords.preferred : [],
        excluded:  Array.isArray(cfg.keywords?.excluded)  ? cfg.keywords.excluded  : [],
      };

      let score = 0, decision = 'APPLY', reason = 'keyword-only (AI disabled)';

      if (_localKeywordScore) {
        try {
          const res = _localKeywordScore(text, kwObj);
          score  = res.score  ?? 0;
          reason = res.reason ?? reason;

          // localKeywordScore has its own internal threshold of 40pt (3 keyword hits).
          // In keyword-only mode we use a much lower threshold — any real keyword match
          // (score > 5) should trigger APPLY.
          // score === 5 is the special "excluded keyword" marker from localKeywordScore.
          // score === 0 means no matches at all → genuinely SKIP.
          if (res.decision === 'SKIP' && score > 5) {
            decision = 'APPLY';
            reason   = res.reason + ' [threshold lowered for keyword-only mode]';
          } else {
            decision = res.decision ?? 'SKIP';
          }
        } catch (e) {
          logger.warn('[NullAI] localKeywordScore error: ' + e.message);
        }
      } else {
        // Pure inline fallback
        const lower = text.toLowerCase();
        const hits  = kwObj.required.filter(k => k && lower.includes(k.toLowerCase()));
        score    = kwObj.required.length ? Math.round((hits.length / kwObj.required.length) * 100) : 50;
        decision = score >= 15 ? 'APPLY' : 'SKIP';
        reason   = hits.length ? `matched: ${hits.join(', ')}` : 'no keyword matches';
      }

      // Excluded keywords always force SKIP (already in localKeywordScore, but belt+braces)
      if (decision !== 'SKIP' && kwObj.excluded.length) {
        const lower = text.toLowerCase();
        for (const ex of kwObj.excluded) {
          if (ex && lower.includes(ex.toLowerCase())) {
            score = 0; decision = 'SKIP';
            reason = `excluded keyword: "${ex}"`;
            break;
          }
        }
      }

      // No keywords configured at all → apply everything by default
      if (!kwObj.required.length && !kwObj.preferred.length && !kwObj.excluded.length) {
        score = 60; decision = 'APPLY'; reason = 'no keywords configured — applying by default';
      }

      logger.info(`[NullAI] "${title}": ${decision} (${score}) — ${reason}`);
      return Promise.resolve({ score, decision, reason });
    },

    complete:     async () => '',
    completeJSON: async () => ({}),
    generate:     async () => 'Cover letter generation requires Ollama.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core runBot logic — shared by both modes
// ─────────────────────────────────────────────────────────────────────────────
async function runBot({ platform = 'all', io = null, companyUrl = null } = {}) {
  // Re-read config so dashboard edits are picked up
  try { config = loadConfig(); } catch (_) {}
  initAIProvider(config);
  const aiEnabled = config.aiEnabled !== false;

  const ollamaUrl  = config.ollamaUrl || config.ollamaBaseUrl || 'http://localhost:11434';
  const ollamaAI   = new OllamaClient({ model: config.aiModel || 'qwen2.5:7b', baseUrl: ollamaUrl });
  let ai           = aiEnabled ? ollamaAI : makeNullAI(config);

  const emit = (ev, data) => {
    if (io) io.emit(ev, data);
  };

  if (aiEnabled) {
    const alive = await ollamaAI.isOllamaRunning().catch(() => false);
    if (!alive) {
      // ── Graceful degradation: fall back to keyword-only mode instead of aborting ──
      // Allows Company Sites (and all portals) to still run when Ollama is offline.
      const msg = 'Ollama is not running — falling back to keyword-only mode. Start Ollama with: ollama serve';
      logger.warn('[Bot] ' + msg);
      emit('bot:log', { level: 'warn', msg: '⚠️ ' + msg, ts: new Date().toISOString() });
      ai = makeNullAI(config);  // switch to keyword-only scoring
    } else {
      logger.info(`[Bot] Ollama OK — model: ${config.aiModel}`);
    }
  } else {
    logger.info('[Bot] AI disabled — keyword-only mode');
    emit('bot:log', { level: 'info', msg: '⚡ Running in keyword-only mode (AI disabled)', ts: new Date().toISOString() });
  }

  // Lazy-load workers to avoid circular deps
  const { runNaukri }   = require('./portals/naukriWorker');
  const { runLinkedin } = require('./portals/linkedinWorker');
  const { runIndeed }   = require('./portals/indeedWorker');
  const { runCompany }  = require('./portals/companyWorker');

  browserManager = new BrowserManager(config);
  await browserManager.launch();
  logger.info('[Bot] Browser launched');

  // If a direct URL was provided, inject it into companyUrls for this run
  let effectiveConfig = config;
  if (companyUrl) {
    effectiveConfig = {
      ...config,
      companyUrls: [companyUrl, ...(config.companyUrls || [])],
    };
    emit('bot:log', { level: 'info', msg: `🔗 Company URL injected: ${companyUrl}`, ts: new Date().toISOString() });
  }

  const deps = { browser: browserManager, config: effectiveConfig, db, io, ai };


  try {
    const all = (platform === 'all');

    if ((all || platform === 'naukri')  && !stopRequested && effectiveConfig.jobsUrl) {
      logger.info('[Bot] → Naukri');
      emit('bot:log', { level: 'info', msg: '🏢 Starting Naukri worker…', ts: new Date().toISOString() });
      await runNaukri(deps);
    }
    if ((all || platform === 'linkedin') && !stopRequested && effectiveConfig.linkedinUrl) {
      logger.info('[Bot] → LinkedIn');
      emit('bot:log', { level: 'info', msg: '💼 Starting LinkedIn worker…', ts: new Date().toISOString() });
      await runLinkedin(deps);
    }
    if ((all || platform === 'indeed')  && !stopRequested && effectiveConfig.indeedUrl) {
      logger.info('[Bot] → Indeed');
      emit('bot:log', { level: 'info', msg: '🔍 Starting Indeed worker…', ts: new Date().toISOString() });
      await runIndeed(deps);
    }
    if ((all || platform === 'company') && !stopRequested) {
      logger.info('[Bot] → Company');
      emit('bot:log', { level: 'info', msg: '🏭 Starting Company worker…', ts: new Date().toISOString() });
      await runCompany({ ...deps, config: effectiveConfig });
    }

  } catch (err) {
    logger.error('[Bot] Fatal: ' + err.message, { stack: err.stack });
    emit('error', { portal: 'System', message: err.message });
  } finally {
    await browserManager?.close().catch(() => {});
    browserManager = null;
    const stats = db.getStats();
    emit('stats', stats);
    emit('stats:update', stats);
    logger.info('[Bot] ====== Session complete ======');
    logger.info('[Bot] Stats: ' + JSON.stringify(stats));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKER-ONLY MODE  (spawned as child process by server.js)
// ─────────────────────────────────────────────────────────────────────────────
if (isWorkerOnly) {
  logger.info(`[Worker] Worker-only mode — platform: ${targetPlatform}${targetUrl ? ' url: ' + targetUrl : ''}`);

  // Validate auth
  const authPath = path.join(process.cwd(), 'auth.json');
  if (!fs.existsSync(authPath)) {
    logger.warn('[Worker] auth.json missing — run: npm run save-auth');
  }

  runBot({ platform: targetPlatform, io: null, companyUrl: targetUrl })
    .then(() => {
      logger.info('[Worker] Done');
      process.exit(0);
    })
    .catch(err => {
      logger.error('[Worker] Uncaught: ' + err.message);
      process.exit(1);
    });

} else {
  // ─────────────────────────────────────────────────────────────────────────
  // DASHBOARD MODE
  // ─────────────────────────────────────────────────────────────────────────
  (async () => {
    logger.info('=========================================');
    logger.info('   AutoApply — AI Job Application Bot');
    logger.info('=========================================');

    if (!config.profile?.name) {
      logger.warn('[Main] Profile name empty — fill config.json > profile.name');
    }

    const authPath = path.join(process.cwd(), 'auth.json');
    if (!fs.existsSync(authPath)) {
      logger.warn('[Main] auth.json not found — run: npm run save-auth');
    }

    if (config.resumePath && !fs.existsSync(config.resumePath)) {
      logger.warn(`[Main] Resume not found at: ${config.resumePath}`);
    }

    // ── Start dashboard ────────────────────────────────────────────────────
    const { DashboardServer } = require('./dashboard/server');
    const dashboard = new DashboardServer({ port: 3000, db, config });
    const io        = dashboard.start();
    logger.info('[Main] Dashboard → http://localhost:3000');

    // ── AI mode socket toggle ──────────────────────────────────────────────
    io.on('connection', socket => {
      socket.emit('ai_mode', { aiEnabled: loadConfig().aiEnabled !== false });
      socket.on('get_ai_mode', () => socket.emit('ai_mode', { aiEnabled: loadConfig().aiEnabled !== false }));
      socket.on('set_ai_mode', ({ enabled }) => {
        try {
          const c = loadConfig(); c.aiEnabled = !!enabled; fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
          io.emit('ai_mode', { aiEnabled: !!enabled });
          logger.info(`[Main] AI mode → ${enabled ? 'enabled' : 'disabled'}`);
        } catch (_) {}
      });
    });

    // ── Bot triggers from socket ───────────────────────────────────────────
    io.on('start_bot_trigger', () => {
      logger.info('[Main] start_bot_trigger → runBot');
      startBotDashboard(io, {});
    });
    io.on('stop_bot_trigger', () => {
      logger.info('[Main] stop_bot_trigger');
      stopRequested = true;
    });

    if (config.autoStart === true) {
      logger.info('[Main] autoStart=true → launching in 2s');
      setTimeout(() => startBotDashboard(io, {}), 2000);
    }

    async function startBotDashboard(io, opts) {
      if (isRunning) { logger.warn('[Bot] Already running'); return; }
      isRunning = true; stopRequested = false;
      io.emit('bot_started');
      io.emit('bot:status', { status: 'running', startedAt: new Date().toISOString() });
      try {
        await runBot({ ...opts, io });
      } finally {
        isRunning = false;
        io.emit('bot_stopped');
        io.emit('bot:status', { status: 'idle', startedAt: null });
      }
    }
  })();
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function gracefulExit(sig) {
  logger.info(`[Main] ${sig} — shutting down`);
  stopRequested = true;
  await browserManager?.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT',  () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('uncaughtException',  err => logger.error('[Main] Uncaught',  { message: err.message, stack: err.stack }));
process.on('unhandledRejection', r   => logger.error('[Main] Rejection', { reason: String(r) }));
