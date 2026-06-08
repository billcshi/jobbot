# Handoff: v0.4 → v0.5

## Status

v0.4 delivers a complete job-search pipeline with web UI:

```
pnpm jobbot ui   →   http://localhost:3000
```

Six pipeline stages (Ingest → Extract → Score → Compose → Audit → Apply), all functional except Apply (v1.0). The web UI has a dashboard, job detail with interactive pipeline tracker, full event timeline, AI call log, and profile management with AI-assisted editing. `pnpm jobbot run` automates the full pipeline from CLI or web UI. Delete, regenerate, and cover letter generation all work. Database auto-migrates from v0.3.

## v0.5 Goals

### 1. Job Discovery & Batch Add

Today jobs are added one URL at a time via `pnpm jobbot add-url <url>`. v0.5 should make ingestion easier.

**Batch URL input** — a page in the web UI where you can paste multiple URLs (one per line) and add them all at once. Each URL gets ATS-detected and queued for extraction.

**Job board search** — `pnpm jobbot discover --query "backend engineer" --location "Seattle"`:
- Searches Greenhouse, Lever, LinkedIn, etc. job boards
- Returns structured results with titles, companies, locations, and URLs
- Option to auto-ingest results into the pipeline
- Could use a lightweight web scraper or a job board API

**Browser-based discovery** (stretch):
- Open a Playwright browser to a job board search
- User browses and clicks "Save" on interesting jobs
- JobBot captures the URL and adds it to the pipeline

### 2. Pipeline Trigger & Queue Management

**From the web UI:**
- "Add & Run" button — paste URLs, add them, and immediately trigger extraction
- Queue visualization improvements — see which jobs are at which stage with counts
- Retry failed jobs in bulk
- Pause/resume pipeline stages

**Scheduled runs** (stretch):
- `pnpm jobbot schedule` — cron-based pipeline automation
- Wakes up, processes queue, reports results
- Configurable interval (daily, hourly)

### 3. Job Market Intelligence

The `job_market_data` table already exists but is empty. Start populating it:

- **Salary range extraction** — Parse salary info from job descriptions
- **Common requirements** — Track which skills/technologies appear most often
- **Title frequency** — Which titles are most common in the market
- Use this data to adjust scoring weights and suggest resume improvements

### 4. Dashboard & Analytics

**Enhanced dashboard:**
- Tier distribution pie/bar chart
- Pipeline funnel visualization (how many at each stage)
- Recent activity feed (last N events)
- Application deadline tracking

**Search analytics:**
- Which companies post the most relevant jobs
- Which job titles have the best score distribution
- Time-to-fill estimates

### 5. Resume & Cover Letter Improvements

**Resume variants** — Support multiple resume templates (already defined in `candidate.yaml` as `resume_variants`):
- `general`, `full-stack`, `backend` variants
- Auto-select the best variant based on job scoring

**Cover letter customization**:
- Different tones (professional, enthusiastic, concise)
- Company-specific research (auto-fetch company info)

**LaTeX improvements**:
- Better handling of long bullet points that cause overflow
- Automatic font size adjustment to fit 1 page
- Support for 2-page resumes when appropriate (senior roles)

### 6. Apply Step Preparation (v1.0 groundwork)

- Research ATS form structures (Greenhouse, Lever, Ashby, Workday)
- Build field mapping prototypes
- Test Playwright/Stagehand for form filling
- Design the apply adapter interface

## Key Files to Create/Modify

```
src/jobs/discover.ts           # NEW: Job board search
src/jobs/schedule.ts           # NEW: Cron-based pipeline scheduling
src/jobs/market-data.ts        # NEW: Populate job_market_data
src/ui/views/add-urls.ejs      # NEW: Batch URL input page
src/ui/views/analytics.ejs     # NEW: Dashboard analytics
src/apply/adapters/             # NEW: ATS adapters (Greenhouse, Lever, etc.)
tests/                          # Add tests for new modules
```

## Suggested Implementation Order

1. Batch URL add (UI + API) — quick win, immediately useful
2. Job board discover — `pnpm jobbot discover`
3. Market data extraction during scoring
4. Dashboard analytics charts
5. Resume variants + cover letter tones
6. Scheduled pipeline runs
7. Apply step research & prototyping

## Tech Notes

- **Scraping**: Use `cheerio` (already a dependency) for HTML parsing. Avoid heavy browser automation until v1.0.
- **Job board APIs**: Greenhouse, Lever, and Ashby have public JSON APIs. Prefer API over scraping.
- **Charts**: Use a lightweight library like Chart.js or build SVG charts inline. No heavy dashboard framework needed.
- **Scheduling**: `node-cron` or a simple setInterval in the server process.
- **Market data**: Simple SQLite aggregation queries. No ML needed yet.
