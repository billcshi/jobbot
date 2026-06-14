# JobBot

**Web-UI personal job-search assistant.** AI-native, quality over quantity.

JobBot is a local web application (Express + EJS) that helps you manage every stage of a job search — from discovering listings to generating tailored LaTeX resumes. Designed to be used with Claude Code: talk to the AI, and it populates your profile, scores jobs, tailors resumes, and will eventually fill out applications. Everything defaults to dry-run.

**Start the web UI:**

```bash
pnpm jobbot ui
# Open http://localhost:3000
```

The web UI provides dashboard analytics, pipeline management, batch URL adding, job board discovery, profile editing with AI assistance (side-by-side diff view), cover letter generation, AI call logging, and more. CLI commands are available for scripting and automation.

## Quick Setup

```bash
git clone <this-repo> jobbot
cd jobbot
bash scripts/setup.sh
```

That's it. The script installs LaTeX, pnpm dependencies, and initializes everything.

Then open Claude Code and say "let's fill in my profile":

```bash
claude
```

## Dependencies

### One-command install

```bash
bash scripts/setup.sh
```

### Manual install

```bash
# System: LaTeX (for resume/cover-letter PDFs)
sudo apt update && sudo apt install -y \
  texlive-latex-base \
  texlive-latex-recommended \
  texlive-latex-extra \
  texlive-fonts-recommended \
  texlive-fonts-extra

# System: poppler-utils (for PDF-to-image conversion in visual audit)
sudo apt install -y poppler-utils python3-pip
pip3 install PyMuPDF --quiet --break-system-packages

# Node.js
pnpm install

# Initialize
pnpm jobbot init-db
```

### What each system package provides

| Package | Why needed |
|---|---|
| `texlive-latex-base` | pdflatex, article class, basic formatting |
| `texlive-latex-recommended` | fullpage, fancyhdr, tabularx, enumitem, titlesec |
| `texlive-latex-extra` | marvosym, fontaxes, more layout packages |
| `texlive-fonts-recommended` | Core fonts, Latin Modern |
| `texlive-fonts-extra` | **fontawesome5** (icons), **lato** (body font) |
| `poppler-utils` | **pdftoppm** — PDF → PNG for visual audit |
| `python3-pip` + `PyMuPDF` | Python PDF-to-image fallback |

### Future dependencies (v1.0+)

| Dependency | Purpose |
|---|---|
| Playwright | Deterministic browser automation (Greenhouse, Lever, Ashby) |
| Stagehand | AI-driven form filling for ambiguous ATS forms |

```bash
pnpm exec playwright install chromium
sudo apt install -y \
  libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64
```

See `docs/browser-setup.md` for detailed WSL2 Playwright setup.

## Important: Personal Data vs. Project Code

This repo is designed to be **safe to share on GitHub**. Your personal data lives in `local/` — a directory that is **gitignored and never committed**.

```
local/              ← YOUR personal data (gitignored — NEVER commit)
  data/               Your SQLite database (profile, jobs, scores, preferences)
  resumes/            Your generated LaTeX resumes and PDFs
  browser-data/       Your Playwright browser profile

local.example/      ← Public template (committed — shows the structure)
```

On first run, `pnpm jobbot init-db` copies `local.example/` → `local/`. Fill in your real data there. Everything else in the repo is safe to push to a public GitHub.

## Philosophy

- **AI-native.** You don't edit anything by hand. Describe your background, preferences, and deal-breakers to Claude Code — it fills in your profile via the DB.
- **Quality, not quantity.** This is not a mass-apply bot. The goal is to surface the best matches and give each one genuine attention.
- **Never auto-submit.** Every application command defaults to `--dry-run`. You must explicitly pass `--submit` to finalize.
- **Never invent data.** Resume tailoring may reorder, select, or lightly rephrase *real* experience — but it will never fabricate employers, dates, skills, or claims.
- **You are in control.** Sensitive answers are stored in your local SQLite DB. Fields marked `ask_every_time: true` stop the pipeline and ask you each time.

## Creating Your Profile (AI-Native)

You do **not** manually edit anything. Instead, open Claude Code in this directory and talk to it. Claude will interview you and write your profile to the database for you.

### Step 1: Open Claude Code

```bash
cd jobbot
claude
```

Claude reads `CLAUDE.md` on startup and knows it should interview you.

### Step 2: Talk to Claude

Tell Claude about yourself. It will ask questions and fill in your profile (stored in SQLite `user_preferences` table, viewable at `/profile` in the web UI):

**Candidate Profile** — Your real background:
- Work history (company, title, dates, highlights, technologies)
- Education (school, degree, year)
- Skills (languages, frameworks, infrastructure, databases)
- Links (GitHub, LinkedIn, website)

**Preferences** — What you're looking for:
- Preferred job titles ("Senior Software Engineer", "Staff Engineer"...)
- Location (remote? which cities?)
- Preferred companies and industries
- Deal-breakers (keywords or industries to reject)
- Salary expectations

**Answers** — Sensitive application answers:
- Work authorization, sponsorship
- Disability, veteran, gender, race status
- Whether you've applied recently
- Expected salary

Claude sets `ask_every_time: true` for anything that should be decided per-application.

### Step 3: Review

Open the web UI at http://localhost:3000/profile to review and edit your profile at any time. Everything Claude writes is based on what you said. Nothing is invented.

## Commands

### Web UI (primary interface)

| Command | Description |
|---|---|
| `pnpm jobbot ui` | **Start web dashboard** at http://localhost:3000 |

The web UI provides: dashboard with analytics charts, pipeline management, batch URL adding, job board discovery, job detail with salary/skills display and interactive pipeline tracker, profile editing with AI assistance (side-by-side diff view), cover letter generation, AI call logging, and event timeline.

### CLI Commands

| Command | Description |
|---|---|
| `bash scripts/setup.sh` | One-command full setup (LaTeX + poppler + pnpm + init) |
| `pnpm jobbot init-db` | Create `local/` (from template) + initialize SQLite schema |
| `pnpm jobbot add-url <url> [url2 ...]` | Add one or more job posting URLs (detects ATS type) |
| `pnpm jobbot discover --query <terms> [--location <city>] [--source <board>] [--ingest]` | Search job boards for new postings |
| `pnpm jobbot extract [--job <id>]` | Fetch + LLM-extract job details |
| `pnpm jobbot score` | Score all jobs via LLM against preferences |
| `pnpm jobbot list [--tier <tier>]` | List all jobs in a table |
| `pnpm jobbot market-data [--key <prefix>]` | View extracted market intelligence |
| `pnpm jobbot delete --job <id> [--force]` | Delete a job |
| `pnpm jobbot delete --tier <tier> [--force]` | Bulk delete by tier |
| `pnpm jobbot delete --status <status> [--force]` | Bulk delete by status |
| `pnpm jobbot run [--step extract\|score\|compose\|audit]` | Run pipeline (all or single step) |
| `pnpm jobbot run --job <id>` | Full pipeline for one job |
| `pnpm jobbot tailor --job <id>` | LLM resume tailoring (internal) |
| `pnpm jobbot render --job <id>` | LaTeX → PDF rendering (internal) |
| `pnpm jobbot compose --job <id>` | Tailor + render in one step |
| `pnpm jobbot cover-letter --job <id>` | Generate cover letter via LLM |
| `pnpm jobbot audit --job <id>` | Content (DeepSeek committee) + visual (GPT-5.5/Claude) audit |
| `pnpm jobbot schedule --once` | Run pipeline once |
| `pnpm jobbot schedule --interval <minutes>` | Run pipeline on a recurring interval |
| `pnpm test` | Run the test suite |
| `pnpm typecheck` | Run TypeScript type-checking |

## Compiling a Resume

Resumes are compiled automatically by the pipeline. To manually compile:

```bash
# Compile a specific job's resume
pdflatex -output-directory local/resumes/54 local/resumes/54/resume.tex

# View
explorer.exe local/resumes/54/resume.pdf   # WSL
open local/resumes/54/resume.pdf            # macOS
xdg-open local/resumes/54/resume.pdf        # Linux
```

## Project Structure

```
jobbot/
  scripts/
    setup.sh            One-command setup script

  local.example/        Public template (committed to git)
    data/                 .gitkeep placeholder
    resumes/              Generated resume versions placeholder

  local/                YOUR personal data (gitignored, never committed)
    data/                 SQLite database (profile, jobs, scores, preferences)
    resumes/              Generated LaTeX resumes and PDFs
    browser-data/         Playwright persistent browser profile

  src/                  TypeScript source (public, committed)
    cli.ts                CLI entry point
    db/                   Database schema, client, init
    jobs/                 Add, extract, score, list, delete, run, audit
    jobs/extractors/      LLM-based job detail extraction (DeepSeek)
    jobs/scorers/         LLM + deterministic job scoring
    ui/                   Express web UI server + EJS views
    apply/                Application orchestration + ATS adapters (future)
    email/                Gmail sync and classification (future)
    analytics/            Search reports (future)
    utils/                Profile store, config, logger, AI logger, paths

  resumes/
    master.tex            LaTeX resume template (public)
  prompts/                LLM prompt templates (public)
  tests/                  Vitest tests (public)
  docs/                   Setup guides, release notes, WSL2
```

## Roadmap

- [x] **v0** — CLI skeleton: init-db, add-url, score, list
- [x] **v0.1** — Scrape and extract job details via DeepSeek LLM
- [x] **v0.2** — LLM-based scoring using `prompts/score-job.md`
- [x] **v0.3** — Web UI dashboard + pipeline visualization
- [x] **v0.4** — Pipeline automation, delete, compose (tailor+render), audit, AI logging
- [x] **v0.5** — Job discovery, batch URL add, market intelligence, dashboard analytics, resume variants, cover letter tones, scheduled runs
- [x] **v0.6** — Multi-user, committee audit, customize pipeline, interactive UI, profile in DB
- [x] **v0.7** — Bug bash, pipeline polish, visual audit, experience ordering, tier gating
- [ ] **v0.8** — Playwright browser automation (Greenhouse, Lever, Ashby, Workday, LinkedIn)
- [ ] **v1.0** — Stagehand AI-driven form filling for ambiguous ATS forms
- [ ] **v1.5** — Gmail sync and email classification
- [ ] **v2.0** — Analytics dashboard and search reports

## Tech Stack

TypeScript · pnpm · SQLite (better-sqlite3) · YAML config · LaTeX · EJS · Express · DeepSeek API (v4-pro/v4-flash) · OpenAI GPT-5.5 (vision) · Claude API (vision) · poppler-utils · PyMuPDF · Vitest · Playwright (v0.8) · Stagehand (v1.0)

Designed for use with **Claude Code** and other AI coding agents on **WSL2**.
