# AutoApply – Automated Job Application Bot

A production-ready Node.js automation system that applies to jobs on Naukri (and other portals) using **Playwright**, a local **Ollama** LLM for AI decisions, and a live **Express + Socket.io** dashboard.

---

## 🗂 Project Structure

```
autoapply/
├── config/
│   ├── config.json          # All settings (edit this first)
│   └── sql/init.sql         # SQLite schema
├── data/
│   ├── resume.pdf           # ← Place your resume here
│   └── screenshots/         # Auto-created per run
├── logs/                    # Auto-created rotating logs
├── src/
│   ├── index.js             # Entry point
│   ├── saveAuth.js          # One-time login helper
│   ├── browser/browser.js
│   ├── worker/worker.js
│   ├── ai/ollamaClient.js
│   ├── db/db.js
│   ├── utils/
│   │   ├── logger.js
│   │   └── antiDetection.js
│   └── dashboard/
│       ├── server.js
│       └── public/          # Dashboard UI
└── package.json
```

---

## ⚡ Quick Start

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Configure

Edit **`config/config.json`** with your:

- `jobsUrl` – the Naukri search URL (e.g. `https://www.naukri.com/qa-engineer-jobs`)
- `profile` – your name, email, phone, cover letter
- `resumePath` – path to your resume (default: `./data/resume.pdf`)
- `aiModel` – your Ollama model name (e.g. `mistral`, `llama3`, `gemma`)
- `keywords` – required and preferred skills to filter jobs

### 3. Start Ollama

```bash
# Install from https://ollama.com then:
ollama pull mistral
ollama serve
```

### 4. Save your login session (run once)

```bash
node src/saveAuth.js
```

A browser window will open. **Log into Naukri manually**, then press **ENTER** in the terminal. This creates `auth.json`.

### 5. Run the bot

```bash
npm start
```

The bot will:

1. Start the dashboard at **http://localhost:3000**
2. Open a browser and navigate to your configured jobs URL
3. Scrape job cards, send each to Ollama for an APPLY/SKIP decision
4. Apply to matching jobs, fill forms, upload resume, take screenshots
5. Store all records in SQLite (`data/autoapply.db`)

---

## 📊 Dashboard

Open **http://localhost:3000** in your browser to see:

- Live stats (scanned / applied / skipped / errors)
- Real-time activity feed
- Applied jobs table with scores and screenshot links
- **Export CSV** button to download all applied jobs

---

## ⚙️ Configuration Reference

| Key                     | Default             | Description                        |
| ----------------------- | ------------------- | ---------------------------------- |
| `jobsUrl`               | Naukri QA URL       | Target job search URL              |
| `headless`              | `false`             | Run browser headless               |
| `maxAppsPerRun`         | `20`                | Max applications per session       |
| `delayMin` / `delayMax` | 2000 / 5000         | Human-like delay range (ms)        |
| `safetyMode`            | `false`             | Extra delays to reduce detection   |
| `scoreThreshold`        | `50`                | Min AI score to trigger apply      |
| `aiModel`               | `mistral`           | Ollama model name                  |
| `maxRetries`            | `3`                 | Retry count on apply failure       |
| `parallelTabs`          | `1`                 | Tabs to use (keep at 1 for safety) |
| `resumePath`            | `./data/resume.pdf` | Resume file path                   |

---

## 🔐 Auth & Security

- `auth.json` stores your browser session cookies — **never commit this file**
- No passwords are stored anywhere in the code
- Config uses non-sensitive defaults; keep API keys in env variables if needed

---

## 📝 Logs

Logs are written to `logs/` with daily rotation (14-day retention). Each run logs AI decisions, apply results, and errors.

---

## 🛑 Stopping

Press `Ctrl+C` to gracefully stop the bot. The dashboard will stay accessible for review.
