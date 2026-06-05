'use strict';

/**
 * CoverLetterGenerator
 * Uses Ollama (coverModel from config) to generate tailored cover letters
 * and to map form fields from a form snapshot to the candidate profile.
 */

const { OllamaClient } = require('./ollamaClient');
const logger = require('../utils/logger');

class CoverLetterGenerator {
  /**
   * @param {object} config - AutoApply config object
   */
  constructor(config) {
    this.config  = config;
    this.profile = config.profile || {};
    this.client  = new OllamaClient({
      model:   config.coverModel || config.aiModel || 'qwen2.5:7b',
      baseUrl: config.ollamaUrl  || config.ollamaBaseUrl || 'http://localhost:11434',
    });
  }

  // ── Cover letter generation ──────────────────────────────────────────────────

  /**
   * Generate a confident, tailored cover letter.
   * @param {{ job: { title, company, location, description }, profile: object }} opts
   * @returns {Promise<string>}
   */
  async generate({ job, profile } = {}) {
    const p = profile || this.profile;
    const j = job    || {};

    const prompt = `Write a confident, tailored cover letter. 3 paragraphs + sign-off.
Do NOT start with "I am writing to apply".

JOB: ${j.title || ''} at ${j.company || ''}, ${j.location || ''}
JOB DESC: ${(j.description || '').slice(0, 1200)}

CANDIDATE: ${p.name || ''}, ${p.currentRole || p.role || ''}, Skills: ${(p.skills || []).join(', ')}

Para 1: Hook - specific excitement about this company and role.
Para 2: Match 2-3 of the candidate's skills to the job requirements.
Para 3: What the candidate will deliver in the first 90 days.
Sign off: Best regards, ${p.name || 'the candidate'}

Write only the letter body. No subject line. No "Dear Hiring Manager" preamble.`;

    try {
      logger.info(`[CoverLetter] Generating for "${j.title}" at ${j.company} (model: ${this.client.model})`);
      const text = await this.client.complete(prompt, 90000);
      if (!text) throw new Error('Empty response from Ollama');
      logger.info(`[CoverLetter] Generated ${text.length} chars`);
      return text;
    } catch (err) {
      logger.warn(`[CoverLetter] Generation failed — using profile default. Reason: ${err.message}`);
      return p.coverLetter || this.profile.coverLetter || '';
    }
  }

  // ── Form field mapping ───────────────────────────────────────────────────────

  /**
   * Ask Ollama to map form fields from a snapshot to the correct profile values.
   * @param {{ formSnapshot: Array<object>, profile: object }} opts
   * @returns {Promise<object>} { selector: value, ... } or {} on failure
   */
  async mapFormFields({ formSnapshot, profile } = {}) {
    const p = profile || this.profile;

    const safeSnapshot = (formSnapshot || []).map(f => {
      if (!f || typeof f !== 'object') return f;
      const safe = {};
      for (const [k, v] of Object.entries(f)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) safe[k] = v;
      }
      return safe;
    });

    const prompt = `Map each form field to the correct profile value.
Respond ONLY with JSON: { "selector": "value", ... }
Only include confident mappings. Skip file inputs.

FIELDS: ${JSON.stringify(safeSnapshot)}
PROFILE: ${JSON.stringify(p)}`;

    try {
      logger.info('[CoverLetter] Mapping form fields via AI...');
      const result = await this.client.completeJSON(prompt);
      logger.info(`[CoverLetter] Mapped ${Object.keys(result).length} field(s)`);
      return result;
    } catch (err) {
      logger.warn(`[CoverLetter] mapFormFields failed: ${err.message}`);
      return {};
    }
  }
}

module.exports = CoverLetterGenerator;
