# CLAUDE.md

Project-level instructions for Claude Code. This file is read automatically when Claude Code is launched in this repository.

---

## Mission

JobBot is an **AI-native personal job-search assistant** for one person. It is designed to work with Claude Code — the user talks to Claude, and Claude populates profiles, scores jobs, tailors resumes, and eventually fills out applications.

It optimizes for **quality over quantity** — surfacing the best matches and giving each genuine attention, not mass-applying to hundreds of jobs.

## Onboarding: Populating the Profile

When the profile is empty or contains only placeholders (first run), Claude MUST **interview the user through conversation**. Do NOT ask the user to edit anything manually — that is Claude's job.

### How to onboard

1. Tell the user: "Let me set up your JobBot profile. I'll ask you a few questions."
2. Ask questions section by section (see below).
3. After each section, write to the SQLite `user_preferences` table via `profile-store.ts`.
4. Confirm with the user before moving on.

### Candidate Profile (stored in `user_preferences.candidate`, editable at `/profile`)

Ask the user about, then write into the DB:

- Name, email, phone, current location
- Work history (for each position): company, title, start/end dates, 2-4 bullet-point highlights, technologies used
- Education: school, degree, graduation year
- Skills broken into: languages, frameworks, infrastructure, databases
- Links: GitHub, LinkedIn, personal website

**Hard rule:** Only write what the user tells you. Never invent or embellish. If the user hasn't mentioned a skill, don't add it. If dates are vague ("around 2020"), keep them vague.

### Preferences (stored in `user_preferences.preferences`, editable at `/profile`)

Ask the user about:

- Preferred job titles (e.g., "Senior Software Engineer", "Staff Engineer", "Backend Engineer")
- Location preferences: remote? which cities?
- Preferred companies (can be empty)
- Preferred industries (e.g., "developer tools", "AI/ML", "cloud infrastructure")
- Deal-breakers — keywords or industries to auto-reject

Tune `weights` based on what matters most to the user. Default: title (0.35), location (0.25), company (0.15), industry (0.20), description quality (0.05).

### Answers (stored in `user_preferences.answers`, editable at `/profile`)

Ask about common application questions:

- Work authorization (citizenship / sponsorship)
- Disability, veteran, gender, race status
- Whether they've applied to this company recently

Set `ask_every_time: true` for anything the user wants to decide per-application. Set `ask_every_time: false` for stable answers (citizenship, sponsorship).

## Safety Rules (Non-Negotiable)

1. **Default to dry-run.** Every application command must default to `--dry-run`. Only `--submit` (explicit) sends the application.
2. **Never auto-submit.** No scenario where the system submits without explicit user confirmation.
3. **Never invent data.** Resume tailoring may ONLY reorder, select, or lightly rephrase **true experience** from the candidate profile (stored in `user_preferences`). Never fabricate employers, dates, skills, or claims.
4. **Respect `ask_every_time`.** If the answers profile has `ask_every_time: true`, stop and ask the user.
5. **Sensitive data stays local.** Profile data (candidate, preferences, answers) is stored in the local SQLite DB and is never shared or uploaded.
6. **AI fills the profile, not the user.** Interview the user and write to the DB. Never tell them to manually edit the profile unless they explicitly ask. They can review at the `/profile` web UI.

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
| `local/` | **gitignored — NEVER commit** | Your profile, database, resumes, browser sessions |
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
  ├── apply/       Application orchestration (future)
  │   └── adapters/  Greenhouse, Lever, Ashby, Stagehand (future)
  ├── email/       Gmail sync + classify (future)
  ├── analytics/   Search reports (future)
  └── utils/       Profile store, config, logger, AI logger, paths, user context
```

## Key Commands

```bash
pnpm jobbot init-db          # Create local/ + initialize SQLite schema
pnpm jobbot add-url <url>    # Add a job posting (ATS-detected, placeholder row)
pnpm jobbot score            # Score all jobs against preferences (from user_preferences table)
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
- Generated files go to `local/resumes/` (gitignored).
- Compile: `pdflatex -output-directory=local/resumes local/resumes/resume-123.tex`

LaTeX must be installed on the system:
```bash
sudo apt update && sudo apt install -y \
  texlive-latex-base texlive-latex-recommended \
  texlive-latex-extra texlive-fonts-recommended
```

## Environment: WSL2

This project runs on **WSL2 (Ubuntu)** on a Windows host.

- **Node.js and pnpm** run natively in WSL.
- **LaTeX** runs natively in WSL (pdflatex).
- **Playwright** runs in WSL with WSLg for headed mode. See `docs/browser-setup.md`.
- **Display**: WSL2 has WSLg (GUI support). `headless: false` browsers render through it.
- **Browser profile**: Always use `local/browser-data/` — never the user's main Windows Chrome profile.

## Browser Automation (Playwright — Future)

Not yet implemented. Infrastructure is ready:

| File | Purpose |
|---|---|
| `playwright.config.ts` | Playwright config — headless, persistent profile in `local/browser-data/` |
| `docs/browser-setup.md` | WSL2-specific Playwright setup |
| `.mcp.json` | Playwright MCP for Claude Code browser control |

Future commands:
```
pnpm jobbot apply --job 123 --dry-run   # Fill form, stop before submit
pnpm jobbot apply --job 123 --submit    # Fill AND submit (explicit, requires confirmation)
```

## Future Commands (Planned)

```
pnpm jobbot apply --job 123 --dry-run # Fill form, stop before submit
pnpm jobbot apply --job 123 --submit  # Fill AND submit (explicit, requires confirmation)
pnpm jobbot sync-email                # Sync Gmail, classify messages
pnpm jobbot report                    # Analytics dashboard
```

## Self-Evolving Data (Architecture)

As JobBot scrapes real job postings and the user fills out applications, the system accumulates market intelligence. This data lives in the `job_market_data` table and makes scoring/tailoring more accurate over time.

### What gets learned

| Data | Source | Example key |
|---|---|---|
| Salary ranges | Scraped job postings | `salary_range.backend.seattle` → "$110k–$160k" |
| Common requirements | Aggregated job descriptions | `common_req.aws` → `0.68` (68% of jobs) |
| Title frequency | Scraped titles | `title_freq.backend_engineer` → `0.35` |
| ATS field patterns | Application form fills | `field_map.greenhouse.gender` → `select.dropdown` |
| Company response rates | Application outcomes | `response_rate.stripe` → `0.12` |

### How it works

1. **Scraping** — `extract` parses job descriptions and writes structured observations to `job_market_data`.
2. **Application filling** — When the browser encounters a field (e.g., salary dropdown), the value is recorded.
3. **Cross-referencing** — The scoring engine queries `job_market_data` to adjust scores based on real market data (e.g., "this job's salary range is below market average → reduce score").
4. **Email classification** — Recruiter emails provide data about which companies respond and at what rate.

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
