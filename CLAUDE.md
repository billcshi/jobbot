# CLAUDE.md

Project-level instructions for Claude Code. This file is read automatically when Claude Code is launched in this repository.

---

## Mission

JobBot is an **AI-native personal job-search assistant** for one person. It is designed to work with Claude Code — the user talks to Claude, and Claude populates profiles, scores jobs, and tailors resumes and cover letters. The user submits applications manually outside JobBot.

It optimizes for **quality over quantity** — surfacing the best matches and giving each genuine attention, not mass-applying to hundreds of jobs.

## Onboarding: Populating the Profile

When the profile is empty or contains only placeholders (first run), Claude MUST **interview the user through conversation**. Do NOT ask the user to edit anything manually — that is Claude's job.

### How to onboard

1. Tell the user: "Let me set up your JobBot profile. I'll ask you a few questions."
2. Ask questions section by section (see below).
3. After each section, create an immutable SQLite profile revision via `profile-store.ts`.
4. Confirm with the user before moving on.

### Candidate Profile (stored in `profile_revisions.candidate_json`, editable at `/profile`)

Ask the user about, then write into the DB:

- Name, email, phone, current location
- Work history (for each position): company, title, start/end dates, 2-4 bullet-point highlights, technologies used
- Education: school, degree, graduation year
- Skills broken into: languages, frameworks, infrastructure, databases
- Links: GitHub, LinkedIn, personal website

**Hard rule:** Only write what the user tells you. Never invent or embellish. If the user hasn't mentioned a skill, don't add it. If dates are vague ("around 2020"), keep them vague.

### Preferences (stored in `profile_revisions.preferences_json`, editable at `/profile`)

Ask the user about:

- Preferred job titles (e.g., "Senior Software Engineer", "Staff Engineer", "Backend Engineer")
- Location preferences: remote? which cities?
- Preferred companies (can be empty)
- Preferred industries (e.g., "developer tools", "AI/ML", "cloud infrastructure")
- Deal-breakers — keywords or industries to auto-reject

Tune `weights` based on what matters most to the user. Default: title (0.35), location (0.25), company (0.15), industry (0.20), description quality (0.05).

## Safety Rules (Non-Negotiable)

1. **No automated applications.** Never fill or submit a job application form. The user applies manually outside JobBot; JobBot may only track the result afterward.
2. **Never invent data.** Resume tailoring may ONLY reorder, select, or lightly rephrase **true experience** from the active profile revision. Never fabricate employers, dates, skills, or claims.
3. **Profile data stays local.** Candidate data and preferences are stored in the local SQLite DB.
4. **AI fills the profile, not the user.** Interview the user and write to the DB. Never tell them to manually edit the profile unless they explicitly ask. They can review at the `/profile` web UI.

## Git Discipline

- **Do NOT commit early.** Wait for the user to explicitly request a commit.
- **One commit per version.** Squash work into a single clean commit per version number.
- **Never push without approval.** Always ask before pushing to origin.
- **No personal data.** `local/` is gitignored. Audit notes and job data stay on disk only.
- **Clean messages.** Format: `vX.Y: Short description` with `Co-Authored-By` trailer.

## Configuration

This repo separates **project code** (public, committed) from **personal data** (local, gitignored):

| Directory | Visibility | Contents |
|---|---|---|
| `local/` | **gitignored — NEVER commit** | Your profile, database, and generated resumes |
| `local.example/` | Committed to git | Template showing the structure |
| Everything else | Committed to git | Source code, prompts, tests, docs |

On first run, `pnpm jobbot init-db` copies `local.example/` → `local/`.

## Architecture

```
CLI (src/cli.ts → tsx src/cli.ts)
  ├── db/          SQLite via better-sqlite3 (schema, init, client)
  ├── jobs/        Pipeline: extract, score, compose (tailor+render+fix-latex), audit, cover-letter
  │   ├── extractors/   LLM-based job detail extraction (DeepSeek)
  │   └── scorers/      LLM + deterministic scoring (DeepSeek flash)
  ├── resume/      LaTeX rendering, LLM template fixing, validation
  ├── ui/          Express web server + EJS views (primary interface)
  └── utils/       Profile store, config, logger, AI logger, paths, user context
```

## Key Commands

```bash
pnpm jobbot init-db          # Create local/ + initialize SQLite schema
pnpm jobbot add-url <url>    # Add a job posting (ATS-detected, placeholder row)
pnpm jobbot score            # Score all jobs against the active profile preferences
pnpm jobbot list             # List all jobs
pnpm jobbot list --tier A    # List tier-A jobs only
pnpm test                    # Run vitest
pnpm typecheck               # tsc --noEmit
```

## Scoring System

Jobs are scored 0.0–1.0 against preferences. Dimensions (configurable via `weights`):

| Dimension | Weight | Description |
|---|---|---|
| Title match | 0.35 | How well the job title matches preferred titles |
| Location match | 0.25 | Remote? Preferred city? |
| Company match | 0.15 | Is this a preferred company? |
| Industry match | 0.20 | Does the description mention preferred industries? |
| Description quality | 0.05 | Length/detail of the posting |

Tier thresholds: **A** ≥ 0.80, **B** ≥ 0.65, **C** ≥ 0.50, **D** < 0.50.

**Pipeline gating:** The automatic pipeline only processes A and B tier jobs. C-tier jobs remain in `scored` status and require manual action (click "▶ Resume" on the job detail page). D-tier jobs (deal-breakers) are skipped entirely.

Deal-breakers (e.g., crypto/web3 keywords) force score = 0 and tier = D.

## ATS Detection (src/jobs/detect-ats.ts)

| Pattern | ATS |
|---|---|
| `boards.greenhouse.io`, `job-boards.greenhouse.io` | greenhouse |
| `jobs.lever.co` | lever |
| `jobs.ashbyhq.com` | ashby |
| `*.myworkdayjobs.com` | workday |
| `linkedin.com/jobs` | linkedin |
| Everything else | generic |

## Resume Rendering (LaTeX)

Resumes and cover letters are written in **LaTeX** and compiled to PDF with `pdflatex`.

- Template: `resumes/master.tex` — uses `{{placeholders}}` that the CLI injects with real data.
- Generated files go to `local/resumes/<jobId>/` (gitignored, per-job directories).
- Compile: `pdflatex -output-directory=local/resumes/54 local/resumes/54/resume.tex`

LaTeX must be installed on the system:
```bash
sudo apt update && sudo apt install -y \
  texlive-latex-base texlive-latex-recommended \
  texlive-latex-extra texlive-fonts-recommended
```

### Experience Ordering

Work experience MUST be reverse-chronological (most recent first). Three layers enforce this:

1. **Prompt** (`tailor-resume.md`) — explicit instruction
2. **Code** (`tailor.ts`) — deterministic sort by start date after LLM returns
3. **Audit** (`audit-format.md`) — format reviewer deducts 20 points for wrong order

### Audit Committee

Three independent reviewers score each resume, with weighted averaging:

| Reviewer | Weight | Focus |
|---|---|---|
| ATS Screener | 30% | Keyword match, ATS readability, requirements alignment |
| Hiring Manager | 40% | Experience quality, impact quantification, narrative |
| Format Reviewer | 30% | 1-page check, structure, experience order, consistency |

Content audit + visual audit (Claude Vision / GPT-5.5). Overall = content × 0.6 + visual × 0.4. PASS threshold: 70/100. Max 3 retries per compose→audit loop.

## Environment: WSL2

This project runs on **WSL2 (Ubuntu)** on a Windows host.

- **Node.js and pnpm** run natively in WSL.
- **LaTeX** runs natively in WSL (pdflatex).

## Self-Evolving Data (Architecture)

As JobBot processes real job postings and the user records application outcomes, the system accumulates market intelligence. This data lives in the `job_market_data` table and makes scoring/tailoring more accurate over time.

### What gets learned

| Data | Source | Example key |
|---|---|---|
| Salary ranges | Scraped job postings | `salary_range.backend.seattle` → "$110k–$160k" |
| Common requirements | Aggregated job descriptions | `common_req.aws` → `0.68` (68% of jobs) |
| Title frequency | Scraped titles | `title_freq.backend_engineer` → `0.35` |
| Company response rates | Application outcomes | `response_rate.stripe` → `0.12` |

### How it works

1. **Scraping** — `extract` parses job descriptions and writes structured observations to `job_market_data`.
2. **Outcome tracking** — The user records replies, interviews, offers, and rejections after applying manually.
3. **Cross-referencing** — The scoring engine queries `job_market_data` to adjust scores based on real market data (e.g., "this job's salary range is below market average → reduce score").

### Key principle

The `job_market_data` table is **anonymized observations**, not personal data. It's safe to commit. Personal application outcomes and email contents stay in `local/`.

## TypeScript Guidelines

- Strict mode. No `any` without justification.
- Use `import type` for type-only imports.
- One concern per file.
- Tests in `tests/` with Vitest globals.

## Development Notes

- `tsx` runs TypeScript directly — no build step needed.
- SQLite WAL mode for concurrent read performance.
- `pnpm jobbot` runs `tsx src/cli.ts`.
