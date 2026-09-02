# JobBot

**Web-UI personal job-search assistant.** AI-native, quality over quantity.

JobBot is a local web application (Express + EJS) that helps you discover and evaluate listings, then generate tailored LaTeX resumes and cover letters. It is designed to work with AI coding agents such as Claude Code, Codex, Cursor, and Copilot: talk to your agent, and it populates your profile, scores jobs, and tailors application materials. Applications themselves remain entirely manual.

**Start the web UI:**

```bash
pnpm jobbot ui
# Open http://localhost:3000
```

The web UI provides dashboard analytics, pipeline management, batch URL adding, job board discovery, review-first AI editing for candidate details and preferences, truth-validated cover letter generation, AI call logging, and more. CLI commands are available for scripting and automation.

## Quick Setup

The setup requires Node.js 20 or newer, an internet connection, and permission to install system packages. Linux automatic system-package installation supports Debian/Ubuntu; Windows uses WinGet.

```bash
git clone <this-repo> jobbot
cd jobbot
bash scripts/setup.sh
```

On Windows PowerShell, use:

```powershell
git clone <this-repo> jobbot
cd jobbot
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

That's it. The script installs LaTeX, Poppler, and pnpm dependencies; initializes the database; then runs type-checking and the automated test suite. It also compiles a disposable document using JobBot's real resume-template packages, so a successful setup means PDF generation is actually usable. On Windows, the script repairs the current PowerShell session's MiKTeX/Poppler paths and preinstalls the required MiKTeX packages.

Then open the repository in your preferred AI coding agent and say "let's fill in my profile." For Claude Code, if installed:

```bash
claude
```

If you are already working with Codex or another compatible agent in this repository, no additional command is required.

## Dependencies

### One-command install

Debian/Ubuntu Linux:

```bash
bash scripts/setup.sh
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

To install only the web UI dependencies and skip LaTeX/Poppler:

```powershell
.\scripts\setup.ps1 -SkipSystemDependencies
```

### Manual install

Windows users should normally run `scripts/setup.ps1`. For a manual Windows installation, install `MiKTeX.MiKTeX` and `oschwartz10612.Poppler` with WinGet. The setup script additionally provisions the MiKTeX packages used by `resumes/master.tex`: `titlesec`, `marvosym`, `enumitem`, `hyperref`, `fancyhdr`, `tabularx`, `lato`, and `fontawesome5`.

```bash
# System: LaTeX (for resume/cover-letter PDFs)
sudo apt update && sudo apt install -y \
  texlive-latex-base \
  texlive-latex-recommended \
  texlive-latex-extra \
  texlive-fonts-recommended \
  texlive-fonts-extra

# System: poppler-utils (for PDF-to-image conversion in visual audit)
sudo apt install -y poppler-utils

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

### API keys and PDF audit providers

Store API keys only in `local/config.yaml`; `local/` is gitignored. Never put a real key in `local.example/`, a README, source code, or a command that you intend to share.

- DeepSeek is used for job extraction, scoring, resume tailoring, content audit, and AI-assisted profile editing. Configure `api_keys.deepseek` for the complete pipeline.
- Anthropic and OpenAI are optional visual-audit providers. If neither is configured, JobBot fails closed unless a human or AI agent explicitly inspects the rendered PDF and records `local/resumes/<job-id>/visual-review.json`.
- A local visual review is bound to the exact job ID, resume-version ID, and PDF SHA-256. Regenerating or changing the PDF invalidates the old review.
- Candidate/profile facts and job descriptions are sent to DeepSeek for those AI stages. Rendered resume page images are sent to the configured Anthropic or OpenAI visual provider. Prompt/debug logs remain plaintext under the gitignored `local/` directory.

After actually inspecting the rendered PDF, a local reviewer can create
`local/resumes/<job-id>/visual-review.json` with this schema:

```json
{
  "schema_version": 1,
  "job_id": 123,
  "resume_version_id": 456,
  "resume_sha256": "exact SHA-256 from the canonical PDF artifact",
  "status": "passed",
  "reviewer_type": "human",
  "reviewer": "reviewer name",
  "score": 90,
  "summary": "Inspected the rendered PDF; no clipping or layout defects found.",
  "issues": []
}
```

`reviewer_type` must be `human` or `agent`. Each issue, when present, must use
`high`, `medium`, or `low` severity and one of `accuracy`, `formatting`,
`keywords`, `layout`, `visual`, or `content` as its category.

## Important: Personal Data vs. Project Code

This repo is designed to be **safe to share on GitHub**. Your personal data lives in `local/` — a directory that is **gitignored and never committed**.

```
local/              ← YOUR personal data (gitignored — NEVER commit)
  data/               Your SQLite database (profile, jobs, scores, preferences)
  resumes/            Your generated LaTeX resumes and PDFs

local.example/      ← Public template (committed — shows the structure)
```

On first run, `pnpm jobbot init-db` copies `local.example/` → `local/`. Fill in your real data there. Everything else in the repo is safe to push to a public GitHub.

## Philosophy

- **AI-native.** You don't edit anything by hand. Describe your background, preferences, and deal-breakers to your AI coding agent — it fills in your profile via the DB.
- **Quality, not quantity.** This is not a mass-apply bot. The goal is to surface the best matches and give each one genuine attention.
- **Manual applications.** JobBot prepares materials and tracks outcomes, but never fills or submits application forms.
- **Never invent data.** Resume tailoring may reorder, select, or lightly rephrase *real* experience — but it will never fabricate employers, dates, skills, or claims.
- **You are in control.** You review the generated materials and submit every application yourself.

## Creating Your Profile (AI-Native)

You do **not** manually edit anything. Instead, open this directory in a compatible AI coding agent and talk to it. The agent will interview you and write your profile to the database for you.

### Step 1: Open an AI coding agent

```bash
cd jobbot
# Claude Code, if installed:
claude
```

Claude Code reads `CLAUDE.md`; Codex and other compatible agents read `AGENTS.md`. If you are already chatting with an agent in this repository, skip the `claude` command and continue in that conversation.

### Step 2: Talk to your AI agent

Tell the agent about yourself. It will ask questions and create immutable profile revisions in SQLite, viewable at `/profile` in the web UI:

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

### Step 3: Review

Open the web UI at http://localhost:3000/profile to review and edit your profile at any time. AI drafts must stay within facts you supplied; review them before saving.

Both profile sections support **Edit with AI**. Candidate edits are drafts only: review the diff, move the draft to the manual editor, verify every fact, and save explicitly. Saving creates a new immutable profile revision; the AI endpoint never saves a candidate draft directly.

## Commands

### Web UI (primary interface)

| Command | Description |
|---|---|
| `pnpm jobbot ui` | **Start web dashboard** at http://localhost:3000 |

The web UI provides: dashboard with analytics charts, pipeline management, batch URL adding, job board discovery, job detail with salary/skills display and interactive pipeline tracker, review-first AI editing for candidate details and preferences, truth-validated cover letter generation, AI call logging, and event timeline.

### CLI Commands

| Command | Description |
|---|---|
| `bash scripts/setup.sh` | Linux one-command full setup (LaTeX + poppler + pnpm + init) |
| `powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1` | Windows one-command full setup (MiKTeX + Poppler + pnpm + init) |
| `pnpm jobbot init-db` | Create `local/` (from template) + initialize SQLite schema |
| `pnpm jobbot add-url <url> [url2 ...]` | Add one or more job posting URLs (detects ATS type) |
| `pnpm jobbot discover --query <English terms> [--location <English city>] [--source <board>] [--company <ATS slug>] [--work-mode any\|remote\|onsite] [--depth quick\|deep] [--ingest]` | Search job boards for new postings; Chinese discovery input is rejected consistently by CLI and UI |
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
| `pnpm jobbot cover-letter --job <id>` | Generate a versioned, evidence/provenance-validated cover letter |
| `pnpm jobbot audit --job <id>` | DeepSeek content audit + visual provider or hash-bound local visual review |
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
    config.yaml           Safe configuration template

  local/                YOUR personal data (gitignored, never committed)
    data/                 SQLite database (profile, jobs, scores, preferences)
    resumes/              Generated LaTeX resumes and PDFs

  src/                  TypeScript source (public, committed)
    cli.ts                CLI entry point
    db/                   Database schema, client, init
    jobs/                 Add, extract, score, list, delete, run, audit
    jobs/extractors/      LLM-based job detail extraction (DeepSeek)
    jobs/scorers/         LLM + deterministic job scoring
    ui/                   Express web UI server + EJS views
    utils/                Profile store, config, logger, AI logger, paths

  resumes/
    master.tex            LaTeX resume template (public)
  prompts/                LLM prompt templates (public)
  tests/                  Vitest tests (public)
  docs/                   Architecture and pipeline guides
```

## Implemented Capabilities

- Authenticated, per-user Web workspace and versioned SQLite profiles
- Job discovery, extraction, scoring, filtering, and scheduled pipeline runs
- Evidence-bound resume tailoring, LaTeX rendering, and PDF artifact verification
- Committee content review and visual quality gates
- Provenanced cover-letter generation
- Manual application and response tracking

## Tech Stack

TypeScript · pnpm · SQLite (better-sqlite3) · YAML config · LaTeX · EJS · Express · DeepSeek API · OpenAI/Claude vision · poppler-utils · Vitest

Designed for use with **Claude Code, Codex, and other AI coding agents** on Windows PowerShell or WSL2/Linux.
