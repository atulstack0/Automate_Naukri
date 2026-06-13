<<<<<<< HEAD
# ⚡ AutoApply — AI-Powered Job Application Bot

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/Playwright-1.42+-blue)](https://playwright.dev/)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-orange)](https://github.com/WiseLibs/better-sqlite3)

An intelligent, fully automated job application system that applies to jobs on **Naukri**, **LinkedIn**, **Indeed**, and **company career portals**. Powered by **Playwright** browser automation, a cascading **AI engine** (OpenAI → Gemini → Ollama → keyword-only), and a real-time **Express + Socket.io** web dashboard.

---

## ✨ Feature Highlights

| Feature | Description |
|---------|-------------|
| 🤖 **Cascading AI Engine** | OpenAI → Gemini → Ollama → keyword-only fallback — never fully offline |
| 🏢 **Multi-Portal Support** | Naukri, LinkedIn, Indeed, and direct company career pages / ATS |
| 📊 **Live Dashboard** | Real-time KPIs, charts, activity feed, bot controls at `http://localhost:3000` |
| 🧠 **3-Tier Form Learning** | Exact DB match → profile keyword scan → AI answer (cached for future runs) |
| 🔀 **Multi-ATS Support** | Workday, Greenhouse, Lever, Ashby, SmartRecruiters, iCIMS, Taleo |
| 📸 **Live Browser View** | Screenshot stream of the bot's browser in real-time |
| 🛡️ **Anti-Detection** | Human-like typing, cubic bezier mouse movement, randomised viewport & user-agent |
| 📄 **Resume Auto-Learn** | Upload PDF → AI extracts Q&A pairs → auto-populates form learning DB |
| ✉️ **Cover Letter Gen** | Per-job AI-generated cover letters |
| 📥 **CSV Export/Import** | Full job history and learning Q&A data portability |

| 🔑 **Session Auth** | Browser cookies saved once via `saveAuth.js`; reused across all runs |

---

## 🗂 Project Structure

```
autoapply/
├── config/
│   ├── config.example.json      ← Config template (copy to config.json)
│   ├── config.json              ← Your local config (gitignored)
│   └── sql/
│       └── init.sql             ← SQLite schema (auto-applied on start)
├── data/                        ← Auto-created at runtime
│   ├── autoapply.db             ← SQLite database
│   ├── screenshots/             ← Per-job browser screenshots
│   ├── uploads/                 ← Resume file uploads
│   ├── resume_extracted.txt     ← Parsed resume text for AI learning
│   └── blocklist.json           ← Company blocklist
├── logs/                        ← Daily rotating logs (14–30 day retention)
├── src/
│   ├── index.js                 ← Orchestrator: dashboard mode OR worker-only mode
│   ├── saveAuth.js              ← One-time login cookie saver
│   ├── ai/
│   │   ├── aiProvider.js        ← Unified AI cascade: OpenAI → Gemini → Ollama
│   │   ├── aiAgent.js           ← 3-tier form Q&A learning system
│   │   ├── ollamaClient.js      ← Local LLM scoring + keyword fallback
│   │   ├── ollamaManager.js     ← Ollama process lifecycle + model inventory
│   │   ├── coverLetter.js       ← AI cover letter generation
│   │   └── resumeCache.js       ← Resume text cache for AI context
│   ├── auth/
│   │   └── autoLogin.js         ← Automatic re-login if session expires
│   ├── browser/
│   │   └── browser.js           ← Playwright wrapper with anti-detection
│   ├── dashboard/
│   │   ├── server.js            ← Express REST API + Socket.io server
│   │   └── public/
│   │       ├── index.html       ← SPA dashboard UI
│   │       ├── app.js           ← Vanilla JS frontend (~50KB)
│   │       └── styles.css       ← Dashboard styles (~35KB)
│   ├── db/
│   │   ├── db.js                ← SQLite singleton (better-sqlite3)
│   │   └── seedLearningList.js  ← Pre-seeds common form Q&A pairs
│   ├── portals/
│   │   ├── naukriWorker.js      ← Naukri: search → job cards → apply modal
│   │   ├── linkedinWorker.js    ← LinkedIn: Easy Apply multi-step form
│   │   ├── indeedWorker.js      ← Indeed: native vs. external apply
│   │   └── companyWorker.js     ← Company pages: ATS detection → delegated apply
│   ├── utils/
│   │   ├── antiDetection.js     ← Human-like delays, mouse curves, typo simulation
│   │   ├── formFiller.js        ← Dynamic field detection and filling (utils layer)
│   │   └── logger.js            ← Winston with daily log rotation
│   └── worker/
│       ├── applyEngine.js       ← Universal apply handler (CAPTCHA, OTP, multi-step)
│       ├── formFiller.js        ← Core form field detection and fill logic
│       ├── externalApplier.js   ← ATS-specific apply flows
│       └── worker.js            ← Job processing pipeline
├── auth.json                    ← Saved browser session cookies (gitignored)
├── .env.example                 ← Environment variables template
├── .gitignore
├── package.json
└── CLAUDE.md                    ← Developer guidance for AI coding assistants
```

---

## ⚡ Quick Start

### 1. Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js ≥ 18** | [nodejs.org](https://nodejs.org/) |
| **Chromium** | Installed via `npx playwright install chromium` |
| **Ollama** *(optional)* | [ollama.com](https://ollama.com) — for local AI scoring |

### 2. Install

```bash
git clone https://github.com/atulpatil87/autoapply.git
cd autoapply
npm install
npx playwright install chromium
```

### 3. Configure

```bash
# Copy the config template
cp config/config.example.json config/config.json

# Copy the environment template (for API keys)
cp .env.example .env
```

Edit **`config/config.json`** with your personal details (see [Configuration Reference](#️-configuration-reference)).

### 4. Start Local AI (Optional)

```bash
# Install Ollama from https://ollama.com, then:
ollama pull llama3.2:3b
ollama serve
```

> **AI is fully optional.** The bot degrades gracefully to keyword-only mode when all AI providers are offline or unconfigured.

### 5. Save Your Login Session *(run once per portal)*

```bash
npm run save-auth
```

A browser window opens. **Log in to your job portal(s) manually**, then press **ENTER** in the terminal. Session cookies are saved to `auth.json` and reloaded on every subsequent run.

### 6. Launch the Bot

```bash
npm start
```

The dashboard starts at **[http://localhost:3000](http://localhost:3000)**. Click **Start** in the Portals tab to begin applying.

---

## 🖥 Dashboard Pages

| Page | Description |
|------|-------------|
| **Dashboard** | KPI cards (total / applied / skipped / failed), 14-day trend chart, top companies, AI score distribution |
| **Jobs** | Full job history — search, filter by portal/status, sort, CSV export |
| **AI Learning** | View, edit, add, or delete form Q&A pairs; import/export CSV; auto-learn from resume |
| **Live Log** | Real-time bot activity stream via Socket.io |
| **Live Browser** | Screenshot stream of the bot's active browser window |
| **Settings** | Ollama model selector, delays, headless mode, score threshold, safety mode |
| **API Keys** | Configure OpenAI / Gemini keys (masked on display, never logged) |
| **Keywords** | Manage required, preferred, and excluded keyword lists |
| **Profile** | Edit personal info used to fill application forms |
| **Portals** | Launch individual portals (Naukri, LinkedIn, Indeed, Company) or run all |
| **Blocklist** | Block companies to prevent accidental applications |
| **Cover Letters** | View AI-generated cover letters per job |


---

## 🏗 Architecture

### System Architecture & Data Flow (Macro View)

The following flowchart illustrates the complete macro-architecture of the AutoApply system. Designed with a modular, layered approach, the system cleanly separates the presentation tier, process orchestration, portal-specific scrapers, a universal state-machine for application handling, and a fault-tolerant cognitive tier (cascading AI). This decoupled design ensures resilience against portal DOM changes, robust anti-bot mitigation, and seamless local/cloud AI fallback.

```mermaid
flowchart TD
    %% Styling
    classDef ui fill:#2A3342,stroke:#5A6A85,stroke-width:2px,color:#E1E8F0,rx:8px,ry:8px;
    classDef orchestrator fill:#1E293B,stroke:#3B82F6,stroke-width:2px,color:#F8FAFC,rx:8px,ry:8px;
    classDef worker fill:#334155,stroke:#10B981,stroke-width:2px,color:#F8FAFC,rx:8px,ry:8px;
    classDef ai fill:#4C1D95,stroke:#8B5CF6,stroke-width:2px,color:#EDE9FE,rx:8px,ry:8px;
    classDef db fill:#064E3B,stroke:#059669,stroke-width:2px,color:#D1FAE5,rx:8px,ry:8px;
    classDef external fill:#7F1D1D,stroke:#EF4444,stroke-width:2px,color:#FEE2E2,rx:8px,ry:8px;

    %% Subgraphs
    subgraph Client ["Client Interface (Presentation Layer)"]
        UI["React/Vanilla Dashboard<br/>(SPA / Real-time KPIs)"]:::ui
        CLI["CLI Commands<br/>(Headless Executions)"]:::ui
    end

    subgraph Server ["Orchestrator Layer (Node.js Express + Socket.io)"]
        API["REST API Endpoints"]:::orchestrator
        WS["WebSocket Server<br/>(Telemetry & I/O Piping)"]:::orchestrator
        Index["Process Manager<br/>(child_process.spawn)"]:::orchestrator
    end

    subgraph Portals ["Job Board Abstraction Layer (Workers)"]
        NW["Naukri Worker<br/>(Search & Scrape)"]:::worker
        LW["LinkedIn Worker<br/>(Easy Apply Paginator)"]:::worker
        IW["Indeed Worker<br/>(Native & External)"]:::worker
        CW["Company Worker<br/>(ATS Delegator)"]:::worker
    end

    subgraph CoreEngine ["Universal Apply Engine (DOM State Machine)"]
        AE["Apply Engine<br/>(Multi-step Form Orchestrator)"]:::worker
        FF["Form Filler<br/>(Dynamic DOM Evaluator)"]:::worker
        AD["Anti-Detection<br/>(Bezier Curves & Typo Sim)"]:::worker
    end

    subgraph AIEngine ["Cognitive AI Cascade (Decision Layer)"]
        AP["AI Provider<br/>(Fault-Tolerant Router)"]:::ai
        AA["AI Agent<br/>(3-Tier Knowledge Retrieval)"]:::ai
        OAM["Ollama Manager<br/>(Local LLM Daemon)"]:::ai
    end

    subgraph Storage ["Persistence Layer"]
        DB[("SQLite<br/>(WAL Mode / better-sqlite3)")]:::db
        Auth{"auth.json<br/>(Serialized Session)"}:::db
        Screens["Screenshots<br/>(Disk I/O Pipeline)"]:::db
    end

    subgraph External ["External Services"]
        JobSite[("Target Portals / ATS")]:::external
        OpenAI[("OpenAI API")]:::external
        Gemini[("Gemini API")]:::external
    end

    %% Data & Control Flows
    UI <-->|HTTP / WS (Telemetry)| API & WS
    CLI -->|Spawns| Index
    API -->|POST /start (IPC)| Index

    Index -->|Forks Worker Process| NW & LW & IW & CW
    WS <..>|Stdio Piped Logs| NW & LW & IW & CW

    NW & LW & IW & CW -->|Initiates Application| AE
    AE <-->|DOM Controls| FF
    AE -.->|Wraps Playwright| AD

    AD -->|Injects Human-like Input| JobSite
    JobSite -.->|DOM Mutates / Captcha| AE

    FF -->|Unresolved Form Field| AA
    AA -->|L1: Exact Match Query| DB
    AA -->|L2: Keyword Heuristics| DB
    AA -->|L3: Infer Answer| AP
    
    AP -->|Primary| OpenAI
    AP -->|Fallback 1| Gemini
    AP -->|Fallback 2| OAM

    AE -->|Commit Transaction / Dedup| DB
    AE -->|Restores Cookies| Auth
    AE -->|Captures Frame| Screens
    DB -.->|Broadcasts KPIs| WS
    AP -.->|Caches Inference| DB
```

### Execution Modes

`src/index.js` supports two modes via CLI flags:

| Mode | Trigger | Description |
|------|---------|-------------|
| **Dashboard** | `npm start` | Starts Express + Socket.io, serves the web UI, and spawns portal workers as child processes |
| **Worker-only** | `--worker-only` flag | Runs a single portal directly — spawned by `server.js POST /api/bot/start` |

### Request Flow

```
Browser UI (http://localhost:3000)
    │
    ▼ Socket.io / REST
src/dashboard/server.js  ──── POST /api/bot/start ────►  child_process.spawn()
    │                                                          │
    │ Socket.io events                                         ▼
    │ (bot:log, stats:update, etc.)                   src/index.js --worker-only
    │                                                          │
    │                                          ┌──────────────┴──────────────┐
    │                                          ▼              ▼              ▼
    │                                   naukriWorker   linkedinWorker  indeedWorker
    │                                          │              │              │
    │                                          └──────────────┴──────────────┘
    │                                                         │
    │                                                         ▼
    │                                                  applyEngine.js
    │                                                  (universal form handler)
    │                                                    ├── aiProvider.js
    │                                                    ├── aiAgent.js
    │                                                    └── db.js
    │
    ◄─────────────────── stdout/stderr piped back as bot:log events ──────────────
```

### AI Provider Cascade

`src/ai/aiProvider.js` tries providers in order, auto-disabling on persistent errors:

```
OpenAI (gpt-4o-mini or configured model)
    │ 429 rate-limit → wait 5s & retry once
    │ 401/403 quota  → switch to next API key; if none left, disable OpenAI
    ▼ (on failure)
Google Gemini (gemini-2.0-flash or configured model)
    │ 429 rate-limit → wait 65s & retry once
    │ 401/403        → disable Gemini for session
    ▼ (on failure)
Ollama (local model — default llama3.2:3b)
    │ Timeout default: 300s
    │ deepseek-r1 <think>...</think> blocks are stripped automatically
    ▼ (on failure)
Keyword-only scoring (NullAI — zero external dependencies)
```

**Configuration:** Each provider is independently enabled by the presence of its API key. Leave a key blank to skip that provider entirely.

### 3-Tier Form Learning (`src/ai/aiAgent.js`)

When the bot encounters a form field it needs to fill:

1. **Exact DB match** — looks up `learning_questions` table by `answer_key` (normalised field name)
2. **Profile keyword match** — scans resume / profile fields for relevant data without an AI call
3. **Ask AI + auto-save** — calls `aiProvider.js`, saves the answer for future runs

> **Cache:** A 30-second in-memory cache sits in front of the DB lookup. After 3 consecutive AI failures, a 5-minute cooldown activates to prevent quota burn.

### Anti-Detection (`src/browser/browser.js`, `src/utils/antiDetection.js`)

| Technique | Details |
|-----------|---------|
| Random viewport | 1280–1440 × 768–900 px |
| Rotated User-Agent | Pool of real Chrome user-agents |
| Automation flags disabled | `--disable-blink-features=AutomationControlled` etc. |
| Geolocation | Pune, India (18.52°N, 73.86°E) |
| Timezone | `Asia/Kolkata` |
| Human typing | 50–180 ms/char, 5% typo rate with self-correction |
| Mouse movement | Cubic bezier interpolation, 3–5 random waypoints |

### Apply Engine Edge Cases (`src/worker/applyEngine.js`)

| Scenario | Handling |
|----------|---------|
| CAPTCHA / slider | 45-second pause for manual solve |
| OTP / 2FA | 60-second pause + terminal prompt |
| Already applied | Portal-specific detection (Naukri, LinkedIn, Indeed, generic) |
| Rate limiting | 90-second cooldown |
| Multi-step forms | Up to 12 steps with step deduplication |
| External redirect | Detects new window/tab opens from apply buttons |
| Validation errors | Re-fills with corrected values |
| Network errors | Exponential backoff |

All CSS selectors are defined as arrays with fallbacks — one broken selector degrades gracefully.

### ATS Support (`src/worker/externalApplier.js`)

Company career page worker auto-detects and handles:
`Workday` · `Greenhouse` · `Lever` · `Ashby` · `SmartRecruiters` · `iCIMS` · `Taleo`

### Socket.io Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `bot:log` | Server → Client | Real-time log line |
| `stats` / `stats:update` | Server → Client | KPI refresh |
| `bot_started` / `bot_stopped` | Server → Client | Bot lifecycle |
| `bot:status` | Server → Client | `{ status, startedAt, pid }` |
| `screenshot:new` | Server → Client | New screenshot path |
| `ai:query_start` / `ai:query_done` | Server → Client | AI request lifecycle |
| `selflearn:done` | Server → Client | Self-learn cycle result |

| `start_bot_trigger` / `stop_bot_trigger` | Client → Server | User-initiated controls |
| `set_ai_mode` | Client → Server | Toggle AI on/off |

---

## ⚙️ Configuration Reference

### `config/config.json` Keys

#### Job Search URLs
| Key | Default | Description |
|-----|---------|-------------|
| `jobsUrl` | Naukri QA URL | Naukri search page URL |
| `linkedinUrl` | LinkedIn QA search | LinkedIn job search URL |
| `indeedUrl` | Indeed Pune | Indeed job search URL |
| `companyUrls` | `[]` | Array of company career page URLs |

#### LinkedIn Filters
| Key | Example | Description |
|-----|---------|-------------|
| `linkedinFilters.experienceLevel` | `["mid-senior", "entry"]` | Filter by seniority |
| `linkedinFilters.jobType` | `["full-time"]` | `full-time`, `part-time`, `contract` |
| `linkedinFilters.datePosted` | `"week"` | `day`, `week`, `month` |
| `linkedinFilters.remote` | `["remote", "hybrid"]` | Work arrangement |

#### Browser Behaviour
| Key | Default | Description |
|-----|---------|-------------|
| `headless` | `false` | Run browser without visible window |
| `safetyMode` | `false` | Add extra random delays |
| `parallelTabs` | `1` | Tabs to use (keep at 1 for safety) |
| `delayMin` / `delayMax` | `1500` / `3000` | Human-like delay range (ms) |
| `slowMo` | `80` | Playwright slowMo (ms per action) |

#### Application Limits
| Key | Default | Description |
|-----|---------|-------------|
| `maxAppsPerRun` | `20` | Max applications per session |
| `maxRetries` | `3` | Retry count on apply failure |
| `maxPagesPerSearch` | `5` | Max search result pages to scrape |
| `scoreThreshold` | `40` | Min AI score to trigger apply (0–100) |

#### AI Configuration
| Key | Default | Description |
|-----|---------|-------------|
| `aiEnabled` | `true` | Toggle AI scoring on/off |
| `skipAI` | `false` | Skip Ollama entirely |
| `aiModel` | `llama3.2:3b` | Ollama model for job scoring |
| `coverModel` | `llama3.2:3b` | Ollama model for cover letters |
| `formModel` | `llama3.2:3b` | Ollama model for form filling |
| `ollamaBaseUrl` | `http://localhost:11434` | Ollama API endpoint |
| `ollamaTimeout` | `120000` | Ollama request timeout (ms) |
| `openAiApiKey` | `""` | Primary OpenAI key |
| `openAiApiKey2` | `""` | Secondary OpenAI key (fallback) |
| `openAiModel` | `gpt-3.5-turbo` | OpenAI model |
| `geminiApiKey` | `""` | Google Gemini API key |
| `geminiModel` | `gemini-2.0-flash` | Gemini model |

#### Profile (used in form filling)
| Key | Example |
|-----|---------|
| `profile.name` | `"Jane Doe"` |
| `profile.email` | `"jane@example.com"` |
| `profile.phone` | `"+91XXXXXXXXXX"` |
| `profile.currentLocation` | `"Pune, India"` |
| `profile.noticePeriod` | `"30 days"` |
| `profile.currentCompany` | `"Acme Corp"` |
| `profile.currentRole` | `"QA Engineer"` |
| `profile.yearsExperience` | `"3"` |
| `profile.salary` | `"10"` (LPA) |
| `profile.portfolio` | `"https://yoursite.com"` |
| `profile.github` | `"https://github.com/you"` |
| `profile.linkedIn` | `"https://linkedin.com/in/you"` |
| `profile.coverLetter` | Your cover letter text |
| `profile.summary` | Professional summary |

#### Keywords
```json
"keywords": {
  "required": ["QA", "automation", "Playwright"],
  "preferred": ["SDET", "CI/CD", "TestNG"],
  "excluded": ["TOSCA"]
}
```

### Environment Variables (`.env`)

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key (overrides `config.json`) |
| `GEMINI_API_KEY` | Google Gemini API key (overrides `config.json`) |
| `OLLAMA_BASE_URL` | Ollama endpoint (default: `http://localhost:11434`) |
| `OLLAMA_MODEL` | Default Ollama model |
| `DASHBOARD_PORT` | Dashboard HTTP port (default: `3000`) |

---

## 🗄 Database Schema

SQLite file: **`data/autoapply.db`** (WAL mode enabled)

### Tables

| Table | Description |
|-------|-------------|
| `jobs` | Legacy Naukri apply log (original schema) |
| `applications` | Unified multi-portal apply log — `UNIQUE(job_id, portal)` |
| `screenshots` | Per-job screenshot file paths |
| `run_stats` | Session-level counters |
| `learning_questions` | Cached form Q&A pairs; `answer_key` uniquely identifies a field |
| `jobs_queue` | URLs pending apply (ATS company worker) |

### View

| View | Description |
|------|-------------|
| `unified_jobs` | Merges `applications` + legacy `jobs` for dashboard queries |

### Key DB Methods (`src/db/db.js`)

| Method | Description |
|--------|-------------|
| `saveApplication(opts)` | INSERT OR IGNORE new application record |
| `isAlreadyApplied(jobId, portal)` | Deduplication check |
| `updateStatus(id, status)` | Update application status |
| `getStats()` | Aggregate KPIs across all portals |
| `getLearningQuestions(limit)` | List Q&A pairs |
| `findAnswerByKey(answerKey)` | Exact key lookup for form filling |
| `addManualLearningQuestion(q, a, key)` | Upsert a Q&A pair |
| `getAllAnsweredAsMap()` | Returns `{ answerKey: answer }` map for batch fill |

---

## 🌐 REST API Reference

### Bot Control
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/bot/status` | `{ status, startedAt, pid }` |
| `POST` | `/api/bot/start` | Start bot `{ platform?, url? }` |
| `POST` | `/api/bot/stop` | Stop bot (SIGTERM → SIGKILL after 5s) |
| `POST` | `/api/bot/restart` | Stop + restart |
| `POST` | `/api/bot/save-auth` | Launch saveAuth.js browser |

### Stats & Jobs
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/stats` | Aggregate KPIs |
| `GET` | `/api/stats/portals` | Per-portal breakdown |
| `GET` | `/api/jobs/all` | All jobs (merged legacy + applications) |
| `GET` | `/api/jobs/recent` | Last 20 jobs |
| `GET` | `/api/jobs/trend` | 14-day daily trend |
| `GET` | `/api/jobs/top-companies` | Top 8 companies by volume |
| `GET` | `/api/jobs/score-dist` | Score distribution buckets |
| `GET` | `/api/jobs/export/csv` | Download jobs CSV |
| `POST` | `/api/jobs/import/csv` | Upload jobs CSV |

### Learning
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/learning` | List Q&A pairs |
| `POST` | `/api/learning` | Add Q&A pair |
| `PATCH` | `/api/learning/:id` | Update answer |
| `DELETE` | `/api/learning/:id` | Delete entry |
| `GET` | `/api/learning/export/csv` | Download learning CSV |
| `POST` | `/api/learning/import/csv` | Upload learning CSV |
| `POST` | `/api/learning/self-learn` | Run self-learn cycle |

### Resume
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/resume/upload` | Upload PDF/TXT resume |
| `GET` | `/api/resume/content` | Get extracted resume text |
| `POST` | `/api/resume/save` | Save resume text directly |
| `POST` | `/api/resume/auto-learn` | Generate Q&A from resume text via AI |

### Configuration
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/config` | Read config (API keys stripped) |
| `PATCH/POST` | `/api/config` | Update config fields |
| `GET/PUT` | `/api/keywords` | Read / write keyword lists |
| `GET/PUT` | `/api/profile` | Read / write profile info |
| `GET/PUT` | `/api/api-keys` | Read (masked) / write API keys |

| `GET/POST` | `/api/ai-mode` | Read / toggle AI on or off |

### Ollama
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/ollama/status` | `{ running, models[], current }` |
| `POST` | `/api/ollama/ensure` | Start Ollama if offline |
| `POST` | `/api/ollama/model` | Switch active model `{ model }` |
| `GET` | `/api/ollama/models` | List installed models |

### Screenshots & Misc
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/screenshot/latest` | Serve latest screenshot file |
| `GET` | `/api/screenshot/latest-path` | Latest screenshot relative URL |
| `GET` | `/api/screenshots/:jobId` | All screenshots for a job |
| `GET/POST` | `/api/blocklist` | Read / add to blocklist |
| `DELETE` | `/api/blocklist/:company` | Remove from blocklist |
| `GET` | `/api/logs/tail` | Last 100 lines from log file |
| `GET` | `/api/db/summary` | Job/learning/screenshot counts |

---

## 🖥 Running Without the Dashboard

```bash
# Run Naukri only
node src/index.js --worker-only --platform=naukri

# Run LinkedIn only
node src/index.js --worker-only --platform=linkedin

# Run Indeed only
node src/index.js --worker-only --platform=indeed

# Run a specific company career page
node src/index.js --worker-only --platform=company --url=https://careers.example.com/jobs

# Run all configured portals sequentially
node src/index.js --worker-only --platform=all
```

---

## 🔌 Extending AutoApply

### Adding a New Job Portal

1. Create `src/portals/<name>Worker.js` exporting `async function run<Name>(deps)`
2. The `deps` object contains: `{ browser, db, ai, config, logger, emitLog, emitStats }`
3. Lazy-import and call it in `runBot()` in `src/index.js`
4. Add the portal URL key to `config/config.example.json`

### Adding a New ATS

1. Add a detector in `detectATS(url)` in `src/worker/externalApplier.js`
2. Implement a handler function in the same file
3. Call the handler from `src/portals/companyWorker.js`

---

## 🔐 Security Notes

- **`auth.json`** stores browser session cookies — **never commit this file**
- **`config/config.json`** may contain API keys — it is gitignored by default
- API keys shown in the dashboard are **masked** (only last 4 chars visible); raw keys are never sent to the browser
- Use `.env` or environment variables for sensitive keys in CI/CD
- No passwords are stored anywhere in the codebase

---

## 📝 Logging

Logs are written to `logs/` using Winston with **daily log rotation**:
- Retention: **14 days** for combined log, **30 days** for error log
- Format: timestamped JSON (file) and coloured text (console)
- Level: `info` by default; set `LOG_LEVEL=debug` for verbose output

---

## 🛑 Stopping the Bot

- **Dashboard:** Click the **Stop** button in the Portals tab
- **Terminal:** Press `Ctrl+C` for graceful shutdown (SIGINT handler closes the browser cleanly)
- The dashboard remains accessible after the bot stops for reviewing results

---

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

> No TypeScript, no build step, no test framework — plain Node.js ≥ 18.

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

## ⚠️ Disclaimer

This tool is for **educational and personal use only**. Ensure you comply with the Terms of Service of any job portal you use. Automated interactions may violate platform ToS — use responsibly. The authors are not responsible for any misuse, account bans, or ToS violations.
=======
Automated Job Suggestion Tool for Naukri.com using Selenium, Java, Maven, and TestNG

Description:
I developed a robust project aimed at automating the job search process on Naukri.com, one of the leading job portals in India. Leveraging the power of Selenium for web automation, along with Java as the primary programming language, Maven for project management, and TestNG for test execution and reporting, this project offers a seamless and efficient solution for job seekers.

Key Features:
1. **Automated Job Search**: The project automates the process of searching for relevant job positions or roles on Naukri.com based on specified criteria.
2. **Dynamic Filtering**: Users can input various parameters such as job title, location, experience level, industry, etc., to narrow down search results and find the most suitable job opportunities.
3. **Scraping and Analysis**: The tool scrapes job listings from the website and performs analysis to suggest the most relevant positions based on the provided criteria.
4. **Customized Job Suggestions**: By analyzing job descriptions, requirements, and other factors, the tool generates personalized job suggestions tailored to the user's preferences and qualifications.
5. **User-Friendly Interface**: The project provides a user-friendly interface for inputting search criteria, viewing search results, and accessing suggested job roles.

Benefits:
- **Time-Saving**: By automating the job search process, the project saves users valuable time and effort that would otherwise be spent manually browsing through numerous job listings.
- **Improved Accuracy**: The automated analysis and filtering ensure more accurate and relevant job suggestions, leading to higher chances of finding suitable job opportunities.
- **Flexibility and Customization**: Users have the flexibility to customize their search criteria and preferences, allowing for a personalized job search experience.
- **Efficient Job Hunting**: With quick access to relevant job suggestions, users can streamline their job hunting process and focus on applying to the most promising opportunities.

Overall, this project showcases the power of automation and technology in enhancing the job search experience, making it more efficient, personalized, and effective for job seekers on Naukri.com.
>>>>>>> 646740d41f7e023c6be2c7702f732817d7438a89
