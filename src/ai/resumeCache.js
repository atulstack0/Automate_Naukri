'use strict';
/**
 * resumeCache.js
 *
 * Fast profile-based answer lookup — NO AI call required.
 * Checks the learning list DB for matching answers using keyword patterns
 * before falling through to the AI model.
 *
 * Priority:
 *  1. Exact answer_key match  (e.g. question contains "notice" → read noticePeriod key)
 *  2. Fuzzy keyword match     (e.g. "how long until you join" → notice period)
 */

const logger = require('../utils/logger');

// ─── Keyword → answer_key mappings ──────────────────────────────────────────
// Each entry: [regex pattern, answerKey from learning list]
// Order matters — more specific patterns first
const KEYWORD_MAP = [
  // Personal / Identity
  [/\bfull\s*name\b|\byour\s*name\b/i,                      'name'],
  [/\bfirst\s*name\b/i,                                      'firstName'],
  [/\blast\s*name\b|\bsurname\b/i,                            'lastName'],
  [/\bemail\b/i,                                              'email'],
  [/\bphone\b|\bmobile\b|\bcontact\s*num/i,                   'phone'],
  [/\bdate\s*of\s*birth\b|\bdob\b|\bbirthdate\b/i,            'dob'],
  [/\bgender\b/i,                                             'gender'],
  [/\bnational(?:ity|alism)\b|\bcitizen/i,                    'nationality'],
  [/\bmarital\b/i,                                            'maritalStatus'],
  [/\blanguage.*speak|speak.*language/i,                      'languagesSpoken'],
  [/\bdisabilit/i,                                            'disability'],
  [/\bvisa\s*sponsor/i,                                       'visaSponsorship'],
  [/\bwork\s*auth|authorized\s*to\s*work/i,                   'workAuth'],

  // Location
  [/\bcurrent\s*(city|location)\b|\bwhere.*located\b/i,       'city'],
  [/\bstate\b/i,                                              'state'],
  [/\baddress\b/i,                                            'address'],
  [/\bpin\s*code\b|\bzip\s*code\b|\bpostal\b/i,               'zipCode'],
  [/\bcountry\b/i,                                            'country'],
  [/\bcurrent\s*location\b|\blocation\b/i,                    'currentLocation'],

  // Work Preference
  [/\brelocat/i,                                              'relocation'],
  [/\bwork\s*from\s*home\b|\bremote\b/i,                      'remoteWork'],
  [/\bcontract\b|\bfreelance\b/i,                             'contractWork'],
  [/\bwork\s*mode\b|\bpreferred.*mode\b/i,                    'preferredWorkMode'],
  [/\btravel\b/i,                                             'travel'],
  [/\bwilling.*office\b|\bwfo\b/i,                            'workMode'],

  // Experience / Role
  [/\byears?\s*of\s*exp|\bhow\s*many\s*years?\b/i,            'yearsExperience'],
  [/\bmonths?\s*of\s*exp/i,                                   'monthsExperience'],
  [/\btotal\s*(it)?\s*exp/i,                                   'totalExperience'],
  [/\bcurrent\s*(company|employer|organisation|organization)\b/i, 'currentCompany'],
  [/\bcurrent\s*(role|designation|position|title)\b/i,         'currentRole'],
  [/\bprevious\s*company\b|\blast\s*company\b/i,               'previousCompany'],
  [/\bprevious\s*role\b|\bpast\s*role\b/i,                     'previousRole'],
  [/\bhow\s*many\s*companies\b/i,                              'companiesWorked'],
  [/\bresponsibilit/i,                                         'responsibilities'],
  [/\bnotice\s*period\b|\bserving\s*notice\b/i,                'noticePeriod'],
  [/\bjoin.*how\s*long\b|\bavailable.*join\b|\bwhen.*start\b/i,'availableToJoin'],
  [/\bselect\s*experience\b/i,                                  'experience'],

  // Salary / Compensation
  [/\bcurrent\s*(ctc|salary|package)\b/i,                      'currentCTC'],
  [/\bexpected\s*(ctc|salary|package)\b|\bsalary\s*expect/i,   'salary'],
  [/\bctc\b|\bsalary.*lpa\b|\blpa.*salary\b/i,                 'salary'],
  [/\bhike\b/i,                                                 'hikeExpected'],

  // Education
  [/\bhighest.*qualif|\bqualific/i,                             'qualification'],
  [/\bcollege\b|\buniversity\b|\binstitut/i,                    'college'],
  [/\bgraduat\b/i,                                              'graduationYear'],
  [/\bcgpa\b|\bpercentage\b|\bgrade\b/i,                        'cgpa'],

  // Technical
  [/\bautomation\s*framework\b/i,                               'automationFrameworks'],
  [/\bselenium\b/i,                                             'selenium'],
  [/\bplaywright\b/i,                                           'playwright'],
  [/\bapi\s*test/i,                                             'apiTesting'],
  [/\bci\/?cd\b|\bjenkins\b/i,                                  'cicd'],
  [/\btestng\b|\bjunit\b/i,                                     'testng'],
  [/\bsql\b|\bdatabase\b/i,                                     'sql'],
  [/\bjira\b/i,                                                  'jira'],
  [/\bjava\b/i,                                                  'java'],
  [/\bpython\b/i,                                               'python'],
  [/\btools?\b|\btechnolog/i,                                    'tools'],
  [/\bprogramming\s*lang|\bcoding\s*lang/i,                     'languages'],
  [/\btech\s*stack\b/i,                                          'techStack'],
  [/\bversion\s*control\b|\bgit\b/i,                             'versionControl'],
  [/\bdocker\b/i,                                               'docker'],
  [/\bgenai\b|\bllm\b|\bartificial\s*int/i,                     'genai'],

  // Profiles / Links
  [/\blinkedin\b/i,                                             'linkedIn'],
  [/\bgithub\b/i,                                               'github'],
  [/\bportfolio\b|\bwebsite\b/i,                                'portfolio'],

  // Behavioral
  [/\bweakness\b/i,                                             'weaknesses'],
  [/\b5\s*years?\b|\bfive\s*years?\b/i,                         'fiveYears'],
  [/\bwhy.*leave|\bleaving.*reason/i,                            'whyLeaving'],
  [/\bstrength\b/i,                                              'strengths'],
  [/\bachievement\b|\aaward\b/i,                                 'biggestAchievement'],
  [/\bteam\s*lead\b|\bmanag.*team\b/i,                           'teamLead'],
  [/\bteam\s*player\b/i,                                         'teamPlayer'],
  [/\bcover\s*letter\b/i,                                        'coverLetter'],
  [/\bsummary\b|\babout\s*yourself\b/i,                          'summary'],
  [/\bwhy.*role\b|\binterest.*role\b|\bwhy.*appl/i,              'whyRole'],
  [/\btesting.*impact\b|\bimprovement\b/i,                       'improvements'],

  // Application
  [/\bfull.?time\b/i,                                           'fullTime'],
  [/\bemployment\s*type\b/i,                                    'employmentType'],
  [/\bcurrently\s*employed\b/i,                                  'currentlyEmployed'],
  [/\boffers?\s*in\s*hand\b/i,                                   'offersInHand'],
  [/\bheard\s*about\b|\bsource\b/i,                              'heardAbout'],

  // Misc
  [/\bage\b/i,                                                   'age'],
];

/**
 * Try to answer a form question using only the learning list + profile data.
 * Returns the answer string if found, or null if it should fall through to AI.
 *
 * @param {string} question - The form field label / question
 * @param {Object} learningMap - Result of db.getAllAnsweredAsMap()
 * @returns {string|null}
 */
function findFromProfile(question, learningMap) {
  if (!question || !learningMap) return null;

  const q = question.trim();

  // 1. Try direct answer_key lookup via keyword map
  for (const [pattern, keyName] of KEYWORD_MAP) {
    if (pattern.test(q)) {
      const val = learningMap[keyName];
      if (val && String(val).length > 0) {
        logger.info(`[ResumeCache] Matched "${q.substring(0, 50)}" → key:${keyName} → "${String(val).substring(0, 40)}"`);
        return String(val);
      }
    }
  }

  return null; // Not found — let AI handle it
}

module.exports = { findFromProfile, KEYWORD_MAP };
