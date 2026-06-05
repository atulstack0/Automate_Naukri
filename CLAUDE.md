# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

AutoApply is a **Node.js job application automation bot** that uses Playwright to apply to jobs on Naukri, LinkedIn, Indeed, and company career pages. It includes a real-time Express + Socket.io dashboard, AI-powered job scoring (OpenAI → Gemini → Ollama), smart form filling with a learning system, and anti-detection browser behavior.

Node ≥ 18 required. No TypeScript, no build step, no test framework, no linter.

## Commands

```bash
# Install dependencies
npm install

# Install Playwright browser (required once)
npx playwright install chromium

# Save job portal login cookies (required before first run)
node src/saveAuth.js

# Start the dashboard (primary mode)
npm start                  # or: node src/index.js

# Run a specific portal without the dashboard
node src/index.js --worker-only --platform=naukri --url=<search_url>
node src/index.js --worker-only --platform=linkedin --url=<search_url>
node src/index.js --worker-only --platform=indeed --url=<search_url>
node src/index.js --worker-only --platform=company --url=<careers_url>
```

Dashboard runs at `http://localhost:3000` (port configurable via `DASHBOARD_PORT` env var or `config.json`).

## Configuration

**First-time setup:**
1. Copy `config/config.example.json` → `config/config.json` (auto-created on first run if missing)
2. Copy `.env.example` → `.env` and fill in API keys

**`.env` keys:**
- `OPENAI_API_KEY` — optional; enables OpenAI scoring
- `GEMINI_API_KEY` — optional; enables Gemini fallback
- `OLLAMA_BASE_URL` / `OLLAMA_MODEL` — local LLM (default `http://localhost:11434`, `llama3.2:3b`)
- `DASHBOARD_PORT` — default `3000`

**`config/config.json`** controls everything else: job URLs per portal, profile details (name, email, phone, resume path), AI model selection, keyword lists, browser settings (headless, delays), LinkedIn filters, company blocklist, minimum AI score threshold.

## Architecture

### Execution Modes

`src/index.js` has two modes controlled by CLI args:

1. **Dashboard mode** (default): starts Express + Socket.io server, serves the web UI, and spawns portal workers as child processes when the user clicks "Start" in the UI.
2. **Worker-only mode** (`--worker-only`): runs a single portal directly, used when spawned as a child process by `src/dashboard/server.js` via `POST /api/bot/start`.

### Request Flow

```
Browser (UI) → Socket.io → dashboard/server.js → spawns child process
                                                  └→ index.js (worker-only)
                                                       └→ portal worker (naukriWorker, linkedinWorker, etc.)
                                                            └→ applyEngine.js (universal form filler)
                                                                 ├→ aiProvider.js (scoring/answers)
                                                                 ├→ aiAgent.js (learning Q&A)
                                                                 └→ db.js (record results)
```

### Key Modules

| Path | Role |
|------|------|
| `src/index.js` | Orchestrator: loads config, inits AI + browser, runs portals |
| `src/dashboard/server.js` | Express REST API + Socket.io; spawns workers; serves static UI |
| `src/dashboard/public/` | Vanilla JS frontend (no framework) |
| `src/portals/naukriWorker.js` | Naukri: search → job cards → apply modal |
| `src/portals/linkedinWorker.js` | LinkedIn: filters → Easy Apply → multi-step form |
| `src/portals/indeedWorker.js` | Indeed: native vs external apply detection |
| `src/portals/companyWorker.js` | Company pages: ATS detection → delegated apply |
| `src/worker/applyEngine.js` | Universal apply handler: CAPTCHA/OTP detection, multi-step forms, edge cases |
| `src/worker/formFiller.js` | Dynamic form field detection and filling |
| `src/worker/externalApplier.js` | ATS-specific flows (Workday, Greenhouse, Lever, Ashby, etc.) |
| `src/ai/aiProvider.js` | Cascading AI: OpenAI → Gemini → Ollama with retry/fallback logic |
| `src/ai/aiAgent.js` | 3-tier learning system for form Q&A |
| `src/ai/ollamaClient.js` | Local LLM job scoring; keyword-only fallback |
| `src/ai/coverLetter.js` | AI cover letter generation per job |
| `src/browser/browser.js` | Playwright wrapper with anti-detection and auth cookie loading |
| `src/utils/antiDetection.js` | Human-like delays, mouse movement, typing with typos |
| `src/db/db.js` | SQLite singleton (better-sqlite3, synchronous API) |
| `src/utils/logger.js` | Winston with daily rotation (logs/ dir, 14–30 day retention) |

### AI Provider Cascade

`src/ai/aiProvider.js` tries providers in order: **OpenAI → Gemini → Ollama → keyword-only**. Each provider auto-disables on persistent auth/quota errors. Rate-limit handling: OpenAI waits 5s and retries once; Gemini waits 65s. Ollama has a 300s timeout. The `NullAI` stub in `index.js` handles the keyword-only fallback when all AI is offline.

### 3-Tier Form Learning (`src/ai/aiAgent.js`)

When filling a form field with an unknown question:
1. **Exact DB match** — looks up `learning_questions` table by `answer_key`
2. **Profile keyword match** — scans resume/profile for relevant data without an AI call
3. **Ask AI + auto-save** — calls AI provider, saves the answer for future runs

There's a 30s in-memory cache on the learning map and a 5-minute cooldown after 3 consecutive AI failures.

### Database (`src/db/db.js`)

SQLite via `better-sqlite3` (synchronous). Database file: `data/autoapply.db`. Schema in `config/sql/init.sql`. WAL mode enabled.

Key tables:
- `applications` — unified apply log across all portals (unique on `job_id + portal`)
- `learning_questions` — cached Q&A pairs for form filling
- `jobs_queue` — URLs pending apply
- `run_stats` — session-level counters
- `unified_jobs` view — merges legacy `jobs` + `applications` for the dashboard

### Browser Anti-Detection (`src/browser/browser.js`, `src/utils/antiDetection.js`)

- Random viewport (1280–1440 × 768–900), rotated Chrome user-agents
- Playwright launched with automation-control flags disabled
- Geolocation: Pune (18.52°N, 73.86°E); timezone: `Asia/Kolkata`
- Human typing: 50–180ms/char, 5% typo rate with self-correction
- Mouse: cubic bezier interpolation with 3–5 random waypoints
- Auth cookies loaded from `auth.json` (created by `saveAuth.js`)

### Apply Engine Edge Cases (`src/worker/applyEngine.js`)

This module handles the hard parts of apply automation:
- **CAPTCHA/slider** — 45s pause for manual solve
- **OTP/2FA** — 60s pause + user prompt
- **Already applied** — portal-specific detection (Naukri, LinkedIn, Indeed, generic)
- **Rate limiting** — 90s cooldown
- **Multi-step forms** — up to 12 steps with step deduplication
- **External redirect tabs** — detects new window opens
- **Validation errors** — re-fills with corrected values
- **Network errors** — exponential backoff

All selectors are defined as arrays with fallbacks so breakage in one selector degrades gracefully.

### Socket.io Events

Dashboard ↔ bot communication via Socket.io:
- `bot:log` — real-time log line stream
- `stats` / `stats:update` — KPI refresh
- `bot_started` / `bot_stopped` — lifecycle
- `start_bot_trigger` / `stop_bot_trigger` — user-initiated controls
- `ai_mode` — toggle AI scoring on/off

## Adding a New Portal

1. Create `src/portals/<name>Worker.js` exporting `async function run<Name>(deps)`
2. `deps` object contains: `{ browser, db, ai, config, logger, emitLog, emitStats }`
3. Lazy-import and call it in `runBot()` in `src/index.js`
4. Add portal URL key to `config/config.example.json`

## Adding a New ATS

In `src/worker/externalApplier.js`, add a detector in `detectATS(url)` and a handler function, then call it from `src/portals/companyWorker.js`. Currently supported: Workday, Greenhouse, Lever, Ashby, SmartRecruiters, iCIMS, Taleo.

## Runtime Directories

These are auto-created and git-ignored:
- `data/autoapply.db` — SQLite database
- `data/screenshots/` — per-run screenshots
- `data/uploads/` — resume uploads
- `logs/` — rotating daily log files
- `auth.json` — saved browser cookies (never commit this)
- `config/config.json` — local config (never commit this)
