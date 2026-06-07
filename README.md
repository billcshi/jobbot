# JobBot

AI-native personal job-search assistant. **Quality over quantity.**

JobBot is built to work with Claude Code (and other AI coding agents). You talk to the AI — it populates your profile, scores jobs, tailors resumes, and (eventually) fills out applications. Everything defaults to dry-run.

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

# Node.js
pnpm install

# Initialize
pnpm jobbot init-db
```

### What each LaTeX package provides

| Package | Why needed |
|---|---|
| `texlive-latex-base` | pdflatex, article class, basic formatting |
| `texlive-latex-recommended` | fullpage, fancyhdr, tabularx, enumitem, titlesec |
| `texlive-latex-extra` | marvosym, fontaxes, more layout packages |
| `texlive-fonts-recommended` | Core fonts, Latin Modern |
| `texlive-fonts-extra` | **fontawesome5** (icons), **lato** (body font) |

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
  profile/            Your real background, preferences, answers
  data/               Your SQLite database
  resumes/            Your generated LaTeX resumes and PDFs
  browser-data/       Your Playwright browser profile

local.example/      ← Public template (committed — shows the structure)
```

On first run, `pnpm jobbot init-db` copies `local.example/` → `local/`. Fill in your real data there. Everything else in the repo is safe to push to a public GitHub.

## Philosophy

- **AI-native.** You don't edit YAML by hand. Describe your background, preferences, and deal-breakers to Claude Code — it fills in `local/profile/` for you.
- **Quality, not quantity.** This is not a mass-apply bot. The goal is to surface the best matches and give each one genuine attention.
- **Never auto-submit.** Every application command defaults to `--dry-run`. You must explicitly pass `--submit` to finalize.
- **Never invent data.** Resume tailoring may reorder, select, or lightly rephrase *real* experience — but it will never fabricate employers, dates, skills, or claims.
- **You are in control.** Sensitive answers live in `local/profile/answers.yaml`. Fields marked `ask_every_time: true` stop the pipeline and ask you each time.

## Creating Your Profile (AI-Native)

You do **not** manually edit YAML files. Instead, open Claude Code in this directory and talk to it. Claude will interview you and write `local/profile/` for you.

### Step 1: Open Claude Code

```bash
cd jobbot
claude
```

Claude reads `CLAUDE.md` on startup and knows it should interview you.

### Step 2: Talk to Claude

Tell Claude about yourself. It will ask questions and fill in the files:

**`local/profile/candidate.yaml`** — Your real background:
- Work history (company, title, dates, highlights, technologies)
- Education (school, degree, year)
- Skills (languages, frameworks, infrastructure, databases)
- Links (GitHub, LinkedIn, website)

**`local/profile/preferences.yaml`** — What you're looking for:
- Preferred job titles ("Senior Software Engineer", "Staff Engineer"...)
- Location (remote? which cities?)
- Preferred companies and industries
- Deal-breakers (keywords or industries to reject)
- Salary expectations

**`local/profile/answers.yaml`** — Sensitive application answers:
- Work authorization, sponsorship
- Disability, veteran, gender, race status
- Whether you've applied recently
- Expected salary

Claude sets `ask_every_time: true` for anything that should be decided per-application.

### Step 3: Review

```bash
cat local/profile/candidate.yaml
cat local/profile/preferences.yaml
cat local/profile/answers.yaml
```

Everything Claude writes is based on what you said. Nothing is invented. You can review and tweak at any time.

## Commands (v0)

| Command | Description |
|---|---|
| `bash scripts/setup.sh` | One-command full setup (LaTeX + pnpm + init) |
| `pnpm jobbot init-db` | Create `local/` (from template) + initialize SQLite schema |
| `pnpm jobbot add-url <url>` | Add a job posting URL (detects ATS type, no scraping yet) |
| `pnpm jobbot score` | Score all jobs against `local/profile/preferences.yaml` |
| `pnpm jobbot list` | List all jobs in a table |
| `pnpm jobbot list --tier A` | List only tier-A jobs |
| `pnpm test` | Run the test suite |
| `pnpm typecheck` | Run TypeScript type-checking |

## Compiling a Resume

```bash
# General resume
pdflatex -output-directory local/resumes/output local/resumes/resume-general.tex

# View
explorer.exe local/resumes/output/resume-general.pdf   # WSL
open local/resumes/output/resume-general.pdf            # macOS
xdg-open local/resumes/output/resume-general.pdf        # Linux
```

## Project Structure

```
jobbot/
  scripts/
    setup.sh            One-command setup script

  local.example/        Public template (committed to git)
    profile/              Candidate, preferences, answers templates
    data/                 .gitkeep placeholder
    resumes/              Generated resume versions placeholder

  local/                YOUR personal data (gitignored, never committed)
    profile/              AI-populated: your background, preferences, answers
    data/                 SQLite database
    resumes/              Generated LaTeX resumes and PDFs
    browser-data/         Playwright persistent browser profile

  src/                  TypeScript source (public, committed)
    cli.ts                CLI entry point
    db/                   Database schema, client, init
    jobs/                 Add, extract, score, list, ATS detection
    resume/               Tailor, render (LaTeX → PDF), validate
    apply/                Application orchestration + ATS adapters (future)
    email/                Gmail sync and classification (future)
    analytics/            Search reports (future)
    utils/                YAML, logger, paths

  resumes/
    master.tex            LaTeX resume template (public)
  prompts/                LLM prompt templates (public)
  tests/                  Vitest tests (public)
  docs/                   Setup guides (browser, LaTeX, WSL2)
```

## Roadmap

- [x] **v0** — CLI skeleton: init-db, add-url, score, list
- [ ] **v0.1** — Scrape and extract job details from Greenhouse, Lever, Ashby
- [ ] **v0.2** — LLM-based scoring using `prompts/score-job.md`
- [ ] **v0.3** — Resume tailoring with `prompts/tailor-resume.md`
- [ ] **v0.4** — LaTeX resume rendering (pdflatex)
- [ ] **v0.5** — Cover letter generation (LaTeX)
- [ ] **v1.0** — Playwright + Stagehand browser automation (dry-run default)
- [ ] **v1.5** — Gmail sync and email classification
- [ ] **v2.0** — Analytics dashboard and search reports

## Tech Stack

TypeScript · pnpm · SQLite (better-sqlite3) · YAML config · LaTeX · Vitest · Playwright (future) · Stagehand (future)

Designed for use with **Claude Code** and other AI coding agents on **WSL2**.
