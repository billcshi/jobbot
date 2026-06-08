# Handoff: v0.3 → v0.4

## Status

v0.3 delivers a working web UI for the job-search pipeline:

```
pnpm jobbot ui   →   http://localhost:3000
```

Three pages: Dashboard (job list with tier badges, filters, sorting), Job Detail (score breakdown, LLM reasoning, pipeline tracker), and Pipeline (visual architecture diagram with per-stage succeed/queued/failed counts, expandable job queues).

The database has 11 real job postings from Greenhouse (Reddit, Twilio, GitLab, Cloudflare) + Airbnb/Stripe, with 3 extracted and scored via DeepSeek LLM. Tests: 35 passing, typecheck clean.

## v0.4 Goals

Three pillars, in priority order:

### 1. Pipeline Automation

Today the pipeline is manual — a human (or Claude) runs each step. v0.4 should automate it.

**`pnpm jobbot run`** — a single command that processes all queued jobs:

```
pnpm jobbot run          # extract all queued, then score all queued
pnpm jobbot run --step extract   # extract only
pnpm jobbot run --step score     # score only
pnpm jobbot run --job 25         # run full pipeline for one job
```

The command should:
- Extract all jobs with `title IS NULL` (queued + failed retry)
- Score all extracted jobs with `score IS NULL OR score = 0`
- Log progress and failures
- Respect rate limits (serial execution, small delay between LLM calls)

**Sub-agent architecture** (optional, if complexity warrants):
- Each pipeline step could spawn a Claude Code sub-agent
- The sub-agent receives the job data, runs the LLM call, writes results
- This keeps the main session free for UI/interaction work
- Pattern: `claude --print "extract job 25" --output-format json`

**Cron / scheduled automation** (stretch):
- `pnpm jobbot schedule` — runs the pipeline on a cron
- Wakes up, processes the queue, goes back to sleep
- Reports results (e.g., "3 extracted, 1 failed, 2 scored")

### 2. Delete Functionality

Users need to remove dead jobs from the database.

**From the CLI:**
```
pnpm jobbot delete --job 25          # delete one job
pnpm jobbot delete --tier D          # delete all D-tier
pnpm jobbot delete --status failed   # delete all failed extractions
pnpm jobbot delete --job 25 --force  # skip confirmation
```

**From the Web UI:**
- Delete button on job detail page (with confirmation dialog)
- Delete button on each row in the dashboard (inline, with confirmation)
- Bulk delete: checkboxes + "Delete selected" action
- "Delete all D-tier" quick action on the dashboard stats bar

**Safety:** deletion is permanent (SQLite `DELETE`). Always confirm before deleting. The `applications` and `resume_versions` tables have foreign key references to `jobs(id)`, so cascade or null those first.

### 3. Resume Composition

Tailor a LaTeX resume for a specific job and render it to PDF.

**`pnpm jobbot tailor --job <id>`:**
- Reads job description + candidate profile
- Sends to DeepSeek LLM with `prompts/tailor-resume.md`
- LLM outputs YAML: reordered/selected experience bullets, tailored professional summary, keyword adjustments
- Writes to `resume_versions` table
- **Hard rule (from CLAUDE.md):** never fabricate experience. Only reorder, select, or lightly rephrase true data from `candidate.yaml`.

**`pnpm jobbot render --job <id>`:**
- Takes the tailored YAML from `resume_versions`
- Injects into `resumes/master.tex` template (replaces `{{placeholders}}`)
- Compiles with `pdflatex` → PDF in `local/resumes/output/`
- Validates: PDF exists? Non-zero size? LaTeX didn't error?

**`pnpm jobbot compose --job <id>`:**
- Combined: tailor → render in one command
- Returns path to the generated PDF

**LaTeX template (`resumes/master.tex`):**
- Already exists in the repo
- Uses `{{name}}`, `{{email}}`, `{{phone}}`, `{{location}}`, `{{summary}}`, `{{experience}}`, `{{education}}`, `{{skills}}` placeholders
- CLI reads template, does string replacement, writes to `local/resumes/<job-id>-resume.tex`

### Pipeline Stage Extension

With tailoring and rendering, the pipeline grows to 6 stages:

```
Ingest → Extract → Score → Tailor → Render → Apply
                                              (v1.0)
```

The pipeline web page should show these new stages and count jobs at each one.

### Delete from Pipeline Page

The pipeline page's expandable job queues should have inline delete buttons (✕) on each job row, so users can remove failed/junk jobs directly from the audit view.

## Key Files

```
src/cli.ts                     # Add: run, delete, tailor, render, compose commands
src/ui/server.ts               # Add: DELETE /jobs/:id route, delete buttons in views
src/ui/views/dashboard.ejs     # Add: checkboxes, bulk delete, inline delete
src/ui/views/job-detail.ejs    # Add: delete button with confirmation
src/ui/views/pipeline.ejs      # Add: Tailor + Render stages, inline delete on queue items
src/jobs/extract.ts            # Already has failure tracking (v0.3)
src/jobs/score.ts              # Already scores via LLM (v0.2)
src/jobs/tailor.ts             # NEW: LLM resume tailoring
src/jobs/render.ts             # NEW: LaTeX injection + pdflatex compilation
src/jobs/delete.ts             # NEW: delete job(s) with cascade
src/jobs/run.ts                # NEW: automated pipeline runner
resumes/master.tex             # LaTeX template (exists)
prompts/tailor-resume.md       # NEW: LLM prompt for resume tailoring
```

## Tech Notes

- **LaTeX:** Must be installed (`texlive-latex-base`, `texlive-latex-recommended`). Already done on this machine.
- **Sub-agent pattern:** If using Claude Code agents for pipeline steps, each agent runs `tsx src/cli.ts extract --job N` and returns JSON. The orchestrator (`run.ts`) parses results.
- **Delete cascade:** SQLite foreign keys are ON. Delete from `jobs` → cascade to `applications` and `resume_versions` (or set NULL if ON DELETE SET NULL).
- **Rate limiting:** LLM extraction/scoring is the bottleneck. Serial execution with a 1-2s delay between jobs prevents rate-limit errors.

## Commit Rules (from CLAUDE.md)

- Do NOT commit early — wait for explicit request
- One commit per version
- Never push without approval
- No personal data in commits (`local/` is gitignored)
