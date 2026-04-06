# ⚡ AutoApply — AI-Powered Job Application Bot

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

An intelligent automation system that applies to jobs on **Naukri**, **LinkedIn**, **Indeed**, and **company career portals** using **Playwright**, a local **Ollama** LLM for AI-driven decisions, and a real-time **Express + Socket.io** dashboard.

---

## ✨ Features

- 🤖 **AI-Powered Scoring** — Uses Ollama (local LLM) or OpenAI/Gemini to evaluate jobs
- 🏢 **Multi-Portal Support** — Naukri, LinkedIn, Indeed, and direct company career pages
- 📊 **Live Dashboard** — Real-time stats, charts, activity feed, and job history
- 🧠 **Smart Form Filling** — AI-assisted form completion with a learning Q&A system
- 📸 **Live Browser View** — Watch the bot work in real-time via screenshots
- 🔑 **Keyword Filtering** — Required, preferred, and excluded keyword matching
- ✉️ **Cover Letter Generation** — AI-generated cover letters per job
- 📄 **Resume Upload & Auto-Learn** — Upload your resume to auto-generate Q&A pairs
- 📥 **CSV Export/Import** — Export job history and learning data
- 🔐 **Anti-Detection** — Built-in fingerprint masking and human-like delays

---

## 🗂 Project Structure

```
autoapply/
├── config/
│   ├── config.example.json  ← Template (copy to config.json)
│   └── sql/init.sql         ← SQLite schema
├── data/
│   ├── screenshots/         ← Auto-created per run
│   └── uploads/             ← Resume uploads
├── logs/                    ← Auto-created rotating logs
├── src/
│   ├── index.js             ← Entry point
│   ├── saveAuth.js          ← One-time login helper
│   ├── ai/                  ← AI scoring, cover letters, resume parsing
│   ├── auth/                ← Auto-login utilities
│   ├── browser/             ← Playwright browser manager
│   ├── db/                  ← SQLite database layer
│   ├── portals/             ← Per-portal workers (Naukri, LinkedIn, Indeed, Company)
│   ├── utils/               ← Logger, anti-detection, form filler
│   ├── worker/              ← Job processing engine
│   └── dashboard/
│       ├── server.js        ← Express + Socket.io API
│       └── public/          ← Dashboard UI (HTML/CSS/JS)
├── .env.example             ← Environment variables template
├── .gitignore
└── package.json
```

---

## ⚡ Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/atulpatil87/autoapply.git
cd autoapply
npm install
npx playwright install chromium
```

### 2. Configure

```bash
# Copy the example config
cp config/config.example.json config/config.json
```

Edit **`config/config.json`** with your details:

| Key               | Description                                          |
| ----------------- | ---------------------------------------------------- |
| `jobsUrl`         | Naukri search URL (e.g., `https://www.naukri.com/qa-engineer-jobs`) |
| `profile`         | Your name, email, phone, cover letter, summary       |
| `resumePath`      | Path to your resume PDF                              |
| `aiModel`         | Ollama model name (e.g., `llama3.2:3b`, `mistral`)   |
| `keywords`        | Required, preferred, and excluded skills              |
| `scoreThreshold`  | Minimum AI score to trigger apply (default: 40)       |

**Optional: API Keys** — For OpenAI/Gemini, set in `config.json` or via `.env`:

```bash
cp .env.example .env
# Edit .env with your API keys
```

### 3. Start Ollama (for AI mode)

```bash
# Install from https://ollama.com then:
ollama pull llama3.2:3b
ollama serve
```

> **Note:** AI is optional. The bot works in keyword-only mode when Ollama is offline.

### 4. Save Your Login Session (run once per portal)

```bash
npm run save-auth
```

A browser window will open. **Log into your job portal(s) manually**, then press **ENTER** in the terminal. This saves session cookies to `auth.json`.

### 5. Run the Bot

```bash
npm start
```

The bot will:
1. Start the dashboard at **http://localhost:3000**
2. Open a browser and navigate to your configured job search URLs
3. Scrape job cards, score each with AI (or keywords)
4. Apply to matching jobs, fill forms, upload resume, take screenshots
5. Store all records in SQLite (`data/autoapply.db`)

---

## 📊 Dashboard

Open **http://localhost:3000** to access:

- **Dashboard** — KPI cards, trend charts, company breakdown, score distribution
- **Jobs** — Full job history with search, filter, sort, and CSV export
- **AI Learning** — Q&A pairs for smart form filling, auto-learn from resume
- **Live Log** — Real-time bot activity stream
- **Live Browser** — Screenshot stream of the bot in action
- **Settings** — Configure AI model, delays, headless mode, etc.
- **Keywords** — Manage required, preferred, and excluded keywords
- **Profile** — Edit your personal details for form filling
- **Portals** — Launch individual portals or run all at once
- **Blocklist** — Block specific companies
- **Cover Letters** — AI-generated cover letters per job

---

## ⚙️ Configuration Reference

| Key                      | Default             | Description                         |
| ------------------------ | ------------------- | ----------------------------------- |
| `jobsUrl`                | Naukri QA URL       | Target job search URL               |
| `headless`               | `false`             | Run browser headless                |
| `maxAppsPerRun`          | `20`                | Max applications per session        |
| `delayMin` / `delayMax`  | 1500 / 3000         | Human-like delay range (ms)         |
| `safetyMode`             | `false`             | Extra delays to reduce detection    |
| `scoreThreshold`         | `40`                | Min AI score to trigger apply       |
| `aiModel`                | `llama3.2:3b`       | Ollama model name                   |
| `aiEnabled`              | `true`              | Toggle AI scoring on/off            |
| `maxRetries`             | `3`                 | Retry count on apply failure        |
| `parallelTabs`           | `1`                 | Tabs to use (keep at 1 for safety)  |
| `resumePath`             | `./data/resume.pdf` | Resume file path                    |
| `maxPagesPerSearch`      | `5`                 | Max search result pages to scrape   |

---

## 🔐 Security Notes

- `auth.json` stores browser session cookies — **never commit this file**
- `config/config.json` may contain API keys — it's gitignored by default
- Use `.env` or environment variables for sensitive keys in production
- No passwords are stored in the codebase

---

## 📝 Logs

Logs are written to `logs/` with daily rotation (14-day retention). Each run logs AI decisions, apply results, and errors.

---

## 🛑 Stopping

Press `Ctrl+C` to gracefully stop the bot. The dashboard will stay accessible for review.

---

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

## ⚠️ Disclaimer

This tool is for educational and personal use only. Ensure you comply with the terms of service of any job portal you use. The authors are not responsible for any misuse or violations.
