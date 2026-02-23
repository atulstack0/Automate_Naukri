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
  config = require(path.join(process.cwd(), 'config', 'config.json'));
} catch (err) {
  logger.error('Could not load config/config.json', { err: err.message });
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
  createDashboardServer(PORT);

  // 2. Wire live-update emitter
  setEmitter((event, data) => {
    emitToClients(event, data);
    logger.debug('WS emit', { event });
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
  await new Promise(r => setTimeout(r, 1000));

  // 5. Run worker
  try {
    await runWorker(config);
  } catch (err) {
    logger.error('Worker crashed', { message: err.message, stack: err.stack });
  }

  logger.info('Session complete. Dashboard still running at http://localhost:' + PORT);
})();

process.on('SIGINT', () => { logger.info('SIGINT – shutting down'); process.exit(0); });
process.on('uncaughtException',  (err) => logger.error('Uncaught exception', { message: err.message, stack: err.stack }));
process.on('unhandledRejection', (r)   => logger.error('Unhandled rejection', { reason: String(r) }));
