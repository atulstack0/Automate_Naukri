'use strict';

/**
 * src/index.js – Entry point: starts dashboard then runs Playwright worker.
 */

const path = require('path');
const logger = require('./utils/logger');
const { createDashboardServer, emitToClients } = require('./dashboard/server');
const { runWorker, setEmitter: setNaukriEmitter } = require('./worker/worker');
const { runLinkedinWorker, setEmitter: setLinkedinEmitter } = require('./worker/linkedinWorker');
const { warmUpOllama } = require('./ai/ollamaClient');
const { initAIProvider, getProviderInfo } = require('./ai/aiProvider');


let config;
try {
  const configPath = path.join(process.cwd(), 'config', 'config.json');
  logger.debug(`[Main] Loading configuration from: ${configPath}`);
  config = require(configPath);
  logger.info('[Main] Configuration loaded successfully');
} catch (err) {
  logger.error('[Main] CRITICAL: Could not load config/config.json', { err: err.message });
  process.exit(1);
}

const PORT          = config.dashboardPort   || 3000;
const OLLAMA_URL    = config.ollamaBaseUrl   || 'http://localhost:11434';
const AI_MODEL      = config.aiModel         || 'mistral';
const SKIP_AI       = config.skipAI          || false;

const isWorkerOnly = process.argv.includes('--worker-only');
const platformArg = process.argv.find(arg => arg.startsWith('--platform='));
const targetPlatform = platformArg ? platformArg.split('=')[1] : 'naukri';

(async () => {
  logger.info('====================================');
  logger.info('  AutoApply – Job Application Bot');
  logger.info('====================================');

  // 1. Initialize AI provider globally so both Dashboard and Worker share the config
  initAIProvider(config);
  logger.info(`[AI] Provider: ${getProviderInfo()}`);

  if (!isWorkerOnly) {
    // 2. Start dashboard only
    logger.info(`[Main] Starting Dashboard server on port ${PORT}...`);
    createDashboardServer(PORT);
    logger.info('[Main] Dashboard is active at http://localhost:' + PORT);
    logger.info('[Main] Waiting for Start command from Dashboard...');
    return; // Don't run worker yet
  }

  // --- Worker Only Mode Below ---
  logger.info('[Main] Starting Worker process (--worker-only)');

  // 2. Wire live-update emitter
  logger.debug(`[Main] Wiring up Socket.io emitter for ${targetPlatform} worker events`);
  const emitFn = (event, data) => {
    emitToClients(event, data);
    logger.debug('[WS] Outbound event', { event });
  };
  setNaukriEmitter(emitFn);
  setLinkedinEmitter(emitFn);

  // 3. Initialize AI provider (Already done globally above, but keeping comment for structural flow)
  // initAIProvider(config);
  // logger.info(`[AI] Provider: ${getProviderInfo()}`);

  // 4. If Ollama is needed and no Gemini key, warm it up
  const needsOllama = !config.geminiApiKey && !process.env.GEMINI_API_KEY;
  if (!SKIP_AI && needsOllama) {
    logger.info('No Gemini API key – warming up Ollama before starting worker...');
    await warmUpOllama(OLLAMA_URL, AI_MODEL, 180000);
  } else if (!SKIP_AI) {
    logger.info('Gemini API key found – skipping Ollama warm-up');
  } else {
    logger.info('skipAI=true – skipping all AI warm-up, using local keyword scorer');
  }

  // 5. Short pause
  logger.debug('[Main] Brief initialization pause (1s)...');
  await new Promise(r => setTimeout(r, 1000));
 
  // 6. Run worker
  try {
    logger.info(`[Main] Relaying control to Worker (${targetPlatform})...`);
    if (targetPlatform === 'linkedin') {
      await runLinkedinWorker(config);
    } else {
      await runWorker(config);
    }
  } catch (err) {
    logger.error('[Main] Worker execution failure', { message: err.message, stack: err.stack });
  }
 
  logger.info('=== AutoApply Session Complete ===');
})();

const gracefulShutdown = (signal) => { logger.info(`${signal} – shutting down`); process.exit(0); };
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException',  (err) => logger.error('Uncaught exception', { message: err.message, stack: err.stack }));
process.on('unhandledRejection', (r)   => logger.error('Unhandled rejection', { reason: String(r) }));
