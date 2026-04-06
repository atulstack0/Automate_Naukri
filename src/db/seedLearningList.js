'use strict';

/**
 * seedLearningList.js
 * Pre-loads all Q&A data from config.json into the learning_questions table.
 * Idempotent — uses answer_key UNIQUE constraint to avoid duplicates.
 * Run on every server boot to ensure the Learning List is the single source of truth.
 */

const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger');

// Map each qaAnswers / profile key to a human-readable question string
const KEY_TO_QUESTION = {
  // Identity
  name:             'What is your full name?',
  email:            'What is your email address?',
  phone:            'What is your phone number?',
  linkedIn:         'What is your LinkedIn profile URL?',
  portfolio:        'What is your portfolio/website URL?',
  github:           'What is your GitHub profile URL?',

  // Location & availability
  location:         'What is your current location?',
  currentLocation:  'What is your current location?',
  notice:           'What is your notice period?',
  noticePeriod:     'What is your notice period?',
  relocation:       'Are you open to relocation or remote work?',

  // Experience
  experience:       'How many years of experience do you have?',
  yearsExperience:  'How many years of experience do you have?',
  currentRole:      'What is your current role and company?',
  currentCompany:   'What is your current company?',
  previousRoles:    'What are your previous roles and work history?',
  responsibilities: 'What are your current key responsibilities?',

  // Technical
  languages:        'What programming languages do you know?',
  tools:            'What testing tools and technologies do you use?',
  selenium:         'Do you have experience with Selenium or Playwright?',
  testng:           'Do you have experience with TestNG?',
  restAssured:      'Do you have experience with REST Assured?',
  apiTesting:       'Describe your API testing experience.',
  cicd:             'Do you have CI/CD experience (Jenkins, pipelines)?',
  frameworks:       'Describe your test automation framework experience.',
  sql:              'Do you have SQL or database testing experience?',
  genai:            'Do you have GenAI/AI testing experience?',
  improvements:     'What testing improvements or impact have you achieved?',

  // Education
  education:        'What is your highest education/qualification?',
  undergraduate:    'What is your undergraduate degree?',

  // HR / Behavioral
  whyRole:          'Why are you interested in this role?',
  strengths:        'What are your key strengths?',
  weaknesses:       'What are your areas of improvement?',
  awards:           'What awards or achievements have you received?',

  // Salary
  salary:           'What is your expected salary (CTC/LPA)?',

  // Summaries
  coverLetter:      'Write a brief cover letter for this application.',
  shortSummary:     'Provide a professional summary about yourself.',
  summary:          'Provide a professional summary about yourself.',
};

/**
 * Seed the learning_questions table with all Q&A from config.json.
 * @param {object} db - The better-sqlite3 database instance (from getDb())
 * @param {object} config - The parsed config.json object
 */
function seedLearningList(db, config) {
  const qaAnswers = config.qaAnswers || {};
  const profile   = config.profile   || {};

  // Merge both sources — qaAnswers takes priority over profile for the same key
  const merged = { ...profile, ...qaAnswers };

  const insert = db.prepare(`
    INSERT INTO learning_questions (question, field_type, answer, answer_key, answered)
    VALUES (?, 'text', ?, ?, 1)
    ON CONFLICT(answer_key) DO UPDATE SET
      answer     = excluded.answer,
      answered   = 1,
      updated_at = datetime('now')
  `);

  let seeded = 0;
  const txn = db.transaction(() => {
    for (const [key, value] of Object.entries(merged)) {
      if (!value || typeof value !== 'string') continue;

      const question = KEY_TO_QUESTION[key];
      if (!question) continue; // skip keys we don't have a question for (e.g. selectors)

      insert.run(question, value.trim(), key);
      seeded++;
    }
  });

  txn();
  const totalCount = db.prepare('SELECT COUNT(*) as count FROM learning_questions').get().count;
  logger.info(`[Seed] Learning list loaded: ${totalCount} Q&A pairs (Seeded ${seeded} from config)`);
  return seeded;
}

module.exports = { seedLearningList, KEY_TO_QUESTION };
