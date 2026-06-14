# JobBot v0.8 — Handoff & Goals

## What We Learned in v0.7

- **Silent failures are the worst bugs.** The pipeline running but UI showing "Idle" went unnoticed. Every background process needs visible state. The task pool auto-cleanup (5s fade) makes the pipeline page much more usable.
- **LLMs don't follow ordering instructions reliably.** Deterministic post-processing (sort by date) is necessary for structural constraints like experience ordering.
- **Tier is metadata, not a gate.** Filtering in the automatic pipeline makes sense; blocking manual user actions based on tier does not.
- **DB records ≠ filesystem reality.** Always verify file existence before showing download UI.
- **The audit committee provides strong signal.** 3 reviewers × weighted averaging catches issues the tailor misses. Visual audit (when API keys work) catches LaTeX rendering problems.
- **1-page constraint is better as a scoring criterion than a hard limit.** Let the LLM produce the best content; let the audit judge whether it fits.

## v0.8 Focus: Browser Automation (Playwright)

### Core: Job Application Automation

Use Playwright to fill and submit job applications:

- `pnpm jobbot apply --job 123 --dry-run` — fill form, take screenshot, STOP before submit
- `pnpm jobbot apply --job 123 --submit` — fill AND submit (explicit confirmation required)
- **ATS adapters** — detect form type and use the right strategy:
  - **Greenhouse**: Standardized form fields, file upload widgets
  - **Lever**: Similar to Greenhouse, different selectors
  - **Ashby**: Modern form patterns, custom file uploads
  - **Workday**: Complex multi-page forms, dropdown-heavy
  - **LinkedIn Easy Apply**: Lightweight popup forms
  - **Generic**: Best-effort form detection for unknown ATS
- **Profile-based auto-fill** — read from `user_preferences.candidate` and `user_preferences.answers`:
  - Name, email, phone, location
  - Work authorization, sponsorship (respect `ask_every_time`)
  - Education history
  - Work experience (from tailored resume, not raw profile)
  - Skills, links (GitHub, LinkedIn, website)
  - Demographic questions (gender, race, veteran, disability — respect `ask_every_time`)
- **Resume + cover letter upload** — attach the generated PDFs
- **Screenshot at each step** — save to `local/resumes/<jobId>/apply-screenshots/` for verification
- **Failure recovery** — if a field can't be found, save a screenshot and report which field was missed

### Safety Rules (Non-Negotiable)

1. **Default to dry-run.** `pnpm jobbot apply --job 123` must NOT submit. Only `--submit` sends.
2. **Never auto-submit.** No scenario where the system submits without explicit user confirmation.
3. **Respect `ask_every_time`.** If answers profile has `ask_every_time: true`, stop and prompt the user before filling that field.
4. **Screenshots for every step.** Every page/form state is captured for user verification.
5. **Browser profile isolation.** Use `local/browser-data/` — never the user's main Chrome profile.

### Implementation Plan

1. **Playwright setup** — persistent browser context, WSL2 config, viewport sizing
2. **Field mapping** — map `user_preferences` fields to common ATS form field names/labels
3. **ATS detection** — determine form type from URL patterns (already done in `detect-ats.ts`)
4. **Greenhouse adapter first** — most common, well-structured forms
5. **Lever adapter second** — similar patterns, good ROI
6. **Ashby adapter third** — growing in popularity among tech companies
7. **Workday adapter** — complex but necessary (many enterprise companies)
8. **LinkedIn Easy Apply** — high volume, simple forms
9. **Generic adapter** — heuristic-based for unknown forms
10. **CLI integration** — `pnpm jobbot apply` command in `cli.ts`

### Secondary: Job Discovery v2 (if time permits)

- Multi-source search (LinkedIn, Greenhouse careers pages, Lever careers pages, Indeed)
- Scheduled discovery via cron (`pnpm jobbot schedule --discover --interval 360`)
- Duplicate detection across sources
- Company-specific searches

### Pre-Flight Checks Before Starting v0.8

- [ ] Playwright installed and working in WSL2 (test: `pnpm exec playwright install chromium`)
- [ ] WSLg working (test: `echo $DISPLAY` — should not be empty)
- [ ] Browser profile directory exists: `local/browser-data/`
- [ ] ATS detection working correctly for all 5 known patterns
- [ ] At least 3 composed + audited jobs ready for test application
- [ ] `user_preferences.candidate` fully populated with real data
- [ ] `user_preferences.answers` populated with work authorization, demographics
