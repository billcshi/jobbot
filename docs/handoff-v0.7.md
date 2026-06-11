# JobBot v0.7 — Handoff & Goals

## What We Learned in v0.6

- **Committee audit works** — 3 reviewers (ATS/HM/Format) give better signal than 1, but DeepSeek occasionally returns empty responses (handled by `Promise.allSettled`)
- **Customize LLM needs guardrails** — 3×3 bullets + 1 project + 1 page is a tight constraint. The LLM sometimes merges bullets or drops projects to fit. The "previous output" feedback loop helps but isn't perfect
- **Experience gap is the #1 audit failure** — the committee correctly identifies qualification mismatches no amount of resume rewriting can fix
- **Visual audit needs a working API key** — Anthropic 401 errors on every run. Without it, the visual score is skipped and the overall score is just content
- **Versioned output is extremely useful** — comparing v1→v2→v3 shows exactly what the LLM changed. Prompt logging makes debugging easy
- **The 1-page constraint is the hardest problem** — rich bullets + 3 positions + projects + education + skills doesn't always fit

## Proposed v0.7 Goals (Pick What Matters)

### A. Job Application Automation (Browser)

Use Playwright to fill and submit job applications:

- `pnpm jobbot apply --job 123 --dry-run` — fill form, take screenshot, STOP before submit
- `pnpm jobbot apply --job 123 --submit` — fill AND submit (explicit confirmation required)
- ATS adapters: Greenhouse, Lever, Ashby, Workday form detection
- Auto-fill from candidate profile + tailored resume data
- Screenshot capture at each step for verification
- **Why**: The pipeline ends at "audited." The next logical step is actually applying.

### B. Job Discovery v2

Smarter, broader job search:

- Multi-source search (LinkedIn, Greenhouse, Lever, Ashby, Indeed)
- Scheduled discovery (cron-style: "search every morning at 8am")
- Duplicate detection across sources (same job posted on multiple boards)
- Company-specific searches ("find all Stripe backend roles")
- **Why**: Currently manual URL entry. Discovery exists but is basic.

### C. Visual Audit Fix + Enhancement

Get the visual audit working properly:

- Fix Anthropic API key configuration
- Use Claude Vision to actually review rendered PDF pages
- Check for: text overflow, spacing issues, font consistency, margin problems
- Flag pages that would look unprofessional when printed
- **Why**: Currently skipped on every run. Visual quality matters for FAANG applications.

### D. Interview Preparation

Generate interview prep materials from job descriptions:

- Extract key topics from JD (technologies, concepts, system design themes)
- Generate practice questions based on the role
- Link to candidate's experience for STAR-method answers
- "Why this company" talking points from company research
- **Why**: Resume gets you the interview. Prep helps you pass it.

### E. Email Integration

Sync Gmail to track application outcomes:

- `pnpm jobbot sync-email` — fetch and classify recruiter emails
- Auto-detect: rejection, interview invite, offer, follow-up
- Link emails to jobs in the database
- Response rate tracking per company
- **Why**: Closes the loop — what happened after applying?

### F. Analytics Dashboard

Track your job search metrics:

- Funnel: discovered → applied → phone screen → onsite → offer
- Response rate by company, role, resume version
- Time-to-response tracking
- Which resume versions perform best?
- **Why**: Data-driven job search optimization.

### G. Prompt Engineering v2

Deeper prompt optimization based on what we learned:

- A/B test different customize prompts against the same job
- Track which prompt produces higher committee scores
- Per-job-type prompt variants (backend vs full-stack vs ML)
- Reduce token usage by trimming prompt verbosity
- **Why**: The prompt IS the product. Better prompts = better resumes.

### H. Multi-Resume Variants

Let the candidate maintain multiple resume "angles":

- Backend engineer variant (emphasizes APIs, databases, distributed systems)
- Full-stack variant (emphasizes frontend + backend balance)
- ML/Data variant (emphasizes data pipelines, Spark, NLP)
- Auto-select variant based on job title keywords (already partially implemented)
- **Why**: One resume can't be optimal for every type of role.

## v0.7 Focus: A (Browser Automation) + Bug Bash

### Browser Automation

Use Playwright to fill and submit job applications:

- `pnpm jobbot apply --job 123 --dry-run` — fill form, take screenshot, STOP before submit
- `pnpm jobbot apply --job 123 --submit` — fill AND submit (explicit confirmation required)
- ATS adapters: Greenhouse, Lever, Ashby, Workday form detection
- Auto-fill from candidate profile + tailored resume data
- Screenshot capture at each step for verification
- Resume PDF upload, cover letter upload
- Handle common form fields: name, email, phone, location, work authorization, education, experience, skills, links, demographic questions
- Respect `ask_every_time: true` from profile/answers.yaml — stop and prompt

### Bug Bash

Known issues to fix:

- DeepSeek occasionally returns empty responses (1 in ~5 calls) — add retry with exponential backoff
- `parseLLMJson` fails on truncated JSON (token limit exceeded) — add truncation recovery
- Committee issue descriptions sometimes empty — standardize LLM output format validation
- LaTeX compilation can fail silently — check exit code and surface errors
- Page count check kills audit before committee runs — run committee even on 2-page failures for richer feedback
- `audit-feedback.json` attempt counter resets on fresh compose — persist across pipeline runs
- Server `EADDRINUSE` error handling — graceful message instead of silent crash
- Cover letter `\\[\\baselineskip]` should be `\\par` for proper paragraph spacing
- Skills section sometimes omits `data_processing` category — LLM format compliance
- Education coursework still too verbose on some renders — tighter truncation
