'use strict';

/**
 * ollamaManager.js
 *
 * Manages the Ollama process lifecycle and model inventory:
 *  - ensureRunning()  — pings Ollama; if offline, spawns `ollama serve` and waits
 *  - listModels()     — fetches installed models via GET /api/tags
 *  - getStatus()      — returns { running, models, current }
 *
 * Designed as a singleton exported at the bottom of this file.
 */

const { spawn }  = require('child_process');
const axios      = require('axios');
const logger     = require('../utils/logger');

// ── tiny sleep helper ──────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── short random id for log correlation ───────────────────────────────────
function shortId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
class OllamaManager {
  /**
   * @param {{ baseUrl?: string, currentModel?: string }} opts
   */
  constructor({ baseUrl = 'http://localhost:11434', currentModel = 'qwen2.5:7b' } = {}) {
    this.baseUrl      = baseUrl;
    this.currentModel = currentModel;
    this._proc        = null;          // spawned child process (if we launched it)
    this._status      = 'unknown';     // 'running' | 'starting' | 'offline' | 'error'
    this._models      = [];            // cached model list
    this._logEmitter  = null;          // optional fn(level, msg, meta) for socket streaming
  }

  // ── Inject a socket-emit function so logs reach the Live Log panel ────────
  setLogEmitter(fn) { this._logEmitter = fn; }

  _log(level, msg, meta = {}) {
    const entry = { level, msg, ts: new Date().toISOString(), ...meta };
    if (level === 'error') logger.error(msg, meta);
    else if (level === 'warn') logger.warn(msg, meta);
    else logger.info(msg, meta);
    if (this._logEmitter) {
      try { this._logEmitter('bot:log', entry); } catch (_) {}
    }
  }

  // ── Ping Ollama ──────────────────────────────────────────────────────────
  async _ping() {
    try {
      const res = await axios.get(this.baseUrl, { timeout: 3000 });
      return res.status === 200;
    } catch (_) {
      return false;
    }
  }

  // ── Auto-start Ollama if not running ─────────────────────────────────────
  /**
   * Ensures Ollama is running. If offline, spawns `ollama serve`.
   * Waits up to `maxWaitMs` (default 30s) polling every 2s.
   * @returns {Promise<'already_running'|'started'|'failed'>}
   */
  async ensureRunning(maxWaitMs = 30000) {
    const reqId = shortId();

    // 1. Already running?
    if (await this._ping()) {
      this._status = 'running';
      this._log('info', `[OllamaManager:${reqId}] ✅ Ollama already running at ${this.baseUrl}`);
      await this._refreshModels(reqId);
      return 'already_running';
    }

    // 2. Try to spawn
    this._status = 'starting';
    this._log('info', `[OllamaManager:${reqId}] 🚀 Ollama not detected — spawning 'ollama serve'…`);

    try {
      // Try 'ollama' first (cross-platform), fall back to 'ollama.exe' on Windows
      const cmd  = process.platform === 'win32' ? 'ollama' : 'ollama';
      const args = ['serve'];

      this._proc = spawn(cmd, args, {
        detached: true,
        stdio:    'ignore',
        windowsHide: true,
        shell:    process.platform === 'win32', // needed for PATH resolution on Windows
      });
      this._proc.unref(); // don't keep node alive waiting for it

      this._proc.on('error', err => {
        this._log('error',
          `[OllamaManager:${reqId}] ❌ Failed to spawn Ollama: ${err.message}. ` +
          `Ensure 'ollama' is installed and in your PATH (https://ollama.com/download).`
        );
        this._status = 'error';
      });
    } catch (err) {
      this._log('error', `[OllamaManager:${reqId}] ❌ Spawn error: ${err.message}`);
      this._status = 'error';
      return 'failed';
    }

    // 3. Poll until Ollama responds or timeout
    const deadline = Date.now() + maxWaitMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      await sleep(2000);
      attempt++;
      if (await this._ping()) {
        this._status = 'running';
        this._log('info', `[OllamaManager:${reqId}] ✅ Ollama started (attempt ${attempt}). Ready.`);
        await this._refreshModels(reqId);
        return 'started';
      }
      this._log('info', `[OllamaManager:${reqId}] ⏳ Waiting for Ollama… (attempt ${attempt})`);
    }

    // 4. Timeout
    this._status = 'offline';
    this._log('error',
      `[OllamaManager:${reqId}] ❌ Ollama did not respond within ${maxWaitMs / 1000}s. ` +
      `Start it manually with: ollama serve`
    );
    return 'failed';
  }

  // ── Fetch and cache model list ────────────────────────────────────────────
  async _refreshModels(reqId = shortId()) {
    try {
      const res = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 5000 });
      this._models = (res.data?.models || []).map(m => ({
        name:     m.name,
        size:     m.size,
        modified: m.modified_at,
      })).sort((a, b) => (a.size || 0) - (b.size || 0)); // smallest first

      const names = this._models.map(m => m.name).join(', ') || '(none)';
      this._log('info',
        `[OllamaManager:${reqId}] 📦 Available models (${this._models.length}): ${names}. Default: ${this.currentModel}`
      );
    } catch (err) {
      this._log('warn', `[OllamaManager:${reqId}] ⚠️ Could not fetch model list: ${err.message}`);
      this._models = [];
    }
    return this._models;
  }

  // ── Public: list models (refreshes cache) ────────────────────────────────
  async listModels() {
    return this._refreshModels();
  }

  // ── Public: get current status snapshot ──────────────────────────────────
  async getStatus() {
    const running = await this._ping();
    this._status  = running ? 'running' : 'offline';
    if (running && this._models.length === 0) {
      await this._refreshModels();
    }
    return {
      running,
      status:  this._status,
      models:  this._models,
      current: this.currentModel,
      baseUrl: this.baseUrl,
    };
  }

  // ── Public: switch active model ───────────────────────────────────────────
  setCurrentModel(modelName) {
    const prev = this.currentModel;
    this.currentModel = modelName;
    this._log('info',
      `[OllamaManager] 🔄 Switching model: '${prev}' → '${modelName}'`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton — re-configured by server.js after reading config
// ─────────────────────────────────────────────────────────────────────────────
const ollamaManager = new OllamaManager();

module.exports = { OllamaManager, ollamaManager };
