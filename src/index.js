'use strict';

/**
 * src/index.js – Entry point: starts dashboard then runs Playwright worker.
 */

const path = require('path');
const logger = require('./utils/logger');
const { createDashboardServer, emitToClients } = require('./dashboard/server');
const { runWorker, setEmitter } = require('./worker/worker');
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

(async () => {
  logger.info('====================================');
  logger.info('  AutoApply – Job Application Bot');
  logger.info('====================================');

  // 1. Start dashboard
  logger.info(`[Main] Starting Dashboard server on port ${PORT}...`);
  createDashboardServer(PORT);
 
  // 2. Wire live-update emitter
  logger.debug('[Main] Wiring up Socket.io emitter for worker events');
  setEmitter((event, data) => {
    emitToClients(event, data);
    logger.debug('[WS] Outbound event', { event });
  });

  // 3. Initialize AI provider (Gemini → Ollama fallback)
  initAIProvider(config);
  logger.info(`[AI] Provider: ${getProviderInfo()}`);

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

  // 4. Short pause to let dashboard fully bind
  logger.debug('[Main] Brief initialization pause (1s)...');
  await new Promise(r => setTimeout(r, 1000));
 
  // 5. Run worker
  try {
    logger.info('[Main] Relaying control to Worker...');
    await runWorker(config);
  } catch (err) {
    logger.error('[Main] Worker execution failure', { message: err.message, stack: err.stack });
  }
 
  logger.info('=== AutoApply Session Complete ===');
  logger.info('[Main] Dashboard remains active at http://localhost:' + PORT);
})();

process.on('SIGINT', () => { logger.info('SIGINT – shutting down'); process.exit(0); });
process.on('uncaughtException',  (err) => logger.error('Uncaught exception', { message: err.message, stack: err.stack }));
process.on('unhandledRejection', (r)   => logger.error('Unhandled rejection', { reason: String(r) }));
