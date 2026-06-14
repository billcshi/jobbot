# Starting v0.8 — Prompt for a new Claude Code session

Copy this prompt into a fresh Claude Code session in the jobbot directory.

---

I'm starting JobBot v0.8. The primary goal is **browser automation** — using Playwright to fill and submit job applications.

## Context

Read these files first for full context:
- `CLAUDE.md` — project overview, architecture, safety rules
- `docs/handoff-v0.7.md` — what v0.7 delivered, lessons learned, current system health
- `docs/handoff-v0.8.md` — v0.8 plan and implementation outline
- `docs/v0.7-notes.md` — detailed v0.7 release notes

## What We're Building in v0.8

### Core: Job Application Automation (Playwright)

Two CLI commands:

```
pnpm jobbot apply --job 123 --dry-run   # Fill form, screenshot, STOP before submit
pnpm jobbot apply --job 123 --submit    # Fill AND submit (explicit confirmation)
```

### ATS Adapters (priority order)

1. **Greenhouse** — most common, well-structured forms
2. **Lever** — similar to Greenhouse
3. **Ashby** — growing in popularity
4. **Workday** — complex multi-page forms
5. **LinkedIn Easy Apply** — simple popup forms
6. **Generic** — best-effort heuristic for unknown ATS

### What to Auto-Fill

From `user_preferences.candidate`:
- Name, email, phone, location
- Work experience (from the tailored resume, not raw profile)
- Education
- Skills, links (GitHub, LinkedIn, website)

From `user_preferences.answers`:
- Work authorization, sponsorship
- Demographic questions (gender, race, veteran, disability)
- Respect `ask_every_time: true` — stop and prompt the user

### File Upload
- Resume PDF from `local/resumes/<jobId>/resume.pdf`
- Cover letter PDF from `local/resumes/<jobId>/cover-letter.pdf` (if exists)

### Screenshots
- Save to `local/resumes/<jobId>/apply-screenshots/` at each step

### Safety Rules (Non-Negotiable)

1. Default to dry-run — `--submit` is explicit
2. Never auto-submit
3. Respect `ask_every_time`
4. Screenshots at every step
5. Use `local/browser-data/` — never the user's main browser profile

## Current System State

- Web UI at `http://localhost:3000` (Express + EJS)
- SQLite database at `local/data/jobbot.sqlite`
- Resume PDFs at `local/resumes/<jobId>/resume.pdf`
- Profile in `user_preferences` table (YAML text columns)
- ATS detection already implemented: `src/jobs/detect-ats.ts`
- Playwright config already exists: `playwright.config.ts`
- Browser setup guide: `docs/browser-setup.md`
- WSL2 with WSLg (headed mode works)

## Key Files to Work With

```
src/
  cli.ts                    Add 'apply' command
  apply/
    index.ts                Application orchestrator (create this)
    adapters/
      greenhouse.ts         Greenhouse form filler
      lever.ts              Lever form filler
      ashby.ts              Ashby form filler
      workday.ts            Workday form filler
      linkedin.ts           LinkedIn Easy Apply
      generic.ts            Generic heuristic filler
      field-mapping.ts      Profile → ATS field name mapping
  jobs/detect-ats.ts        ATS detection (already exists)
  utils/profile-store.ts    Read candidate/profile/answers from DB
  utils/config.ts           Config reader

playwright.config.ts        Playwright config (already exists)
docs/browser-setup.md       WSL2 Playwright setup guide
```

## Getting Started

1. Read the context files listed above
2. Verify Playwright works: `pnpm exec playwright install chromium`
3. Verify WSLg: `echo $DISPLAY` (should not be empty)
4. Plan the implementation approach and review with me before writing code
5. Start with the Greenhouse adapter — it's the most common and best-structured
