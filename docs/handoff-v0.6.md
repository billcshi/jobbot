# Handoff: v0.5 → v0.6

## Current State (end of v0.5)

v0.5 is complete and ready to commit. All features implemented:

- Job board discovery (LinkedIn, Greenhouse, Lever, Ashby)
- Batch URL add with "Add & Run Pipeline"
- Market intelligence (salary, skills, title frequency)
- Dashboard SVG analytics (tier bars, pipeline funnel, top companies)
- Resume variant auto-detection
- Cover letter tones (professional, enthusiastic, concise)
- Scheduled pipeline runs
- Apply research doc (ATS forms, adapter interface)
- Profile AI-edit with **side-by-side diff view** (v0.5 polish)
- **Salary display on job detail page** (v0.5 polish)
- **Delete FK constraint fix** (v0.5 polish)

## v0.6 Goal: Multi-User + Application Tracking

### Primary: Multi-User Mode

Jobs are **shared** across users. Scoring, tailoring, and application status are **per-user**.

**Schema changes needed:**

1. `users` table — user accounts (id, name, active)
2. `user_scores` table — per-user job scores (job_id, user_id, score, tier, score_reason)
3. `user_applications` table — per-user application tracking (job_id, user_id, status, submitted_at, responded_at)
4. `resume_versions` add `user_id` column
5. Migrate existing `jobs.score`/`jobs.tier`/`jobs.score_reason` to `user_scores` for a `default` user
6. Move profile files: `local/profile/*.yaml` → `local/profile/default/*.yaml`

**Files to create/modify:**

- `src/db/schema.ts` — new tables
- `src/db/migrate.ts` — v0.5→v0.6 migration (or add to init.ts migrations)
- `src/jobs/score.ts` — score per user, write to `user_scores`
- `src/jobs/run.ts` — scoring paths use active user
- `src/jobs/compose.ts` — compose per user
- `src/ui/server.ts` — user switcher UI, per-user score display, per-user profile paths
- `src/ui/views/_head.ejs` — user switcher in nav
- `src/ui/views/dashboard.ejs` — per-user scores, user-aware filters
- `src/ui/views/job-detail.ejs` — per-user score, per-user actions
- `src/cli.ts` — `--user` flag, `user-list`/`user-add`/`user-switch` commands
- `local.example/users.yaml` — example user list
- `local.example/profile/default/` — move templates here

### Secondary: Application Lifecycle

Track applications through the full lifecycle.

**Application status flow:**
```
draft → submitted → replied → interview → offer → accepted/rejected
                     ↘ rejected / ghosted
```

**Implementation:**
- `POST /api/jobs/:id/apply` — mark as submitted
- `POST /api/jobs/:id/response` — record response (replied, rejected, interview, offer)
- Dashboard filter: "Active | Applied | All" — default hides applied
- Reminder for jobs with no response after N days

### Parallel Pipeline

**Current state (v0.5):** The pipeline processes jobs sequentially — one extract at a time with 1.5s delays, one score at a time with 1s delays, one compose at a time with 2s delays. For 16 jobs, extraction alone takes ~2 minutes of wall-clock time, most of it waiting.

**Goal:** Process jobs concurrently within each pipeline stage, bounded by a configurable concurrency limit.

**Approach:**

- Add a generic `asyncPool(concurrency, items, fn)` helper — runs up to N async tasks in parallel, starts a new one each time one finishes
- Replace sequential `for` loops in `runExtract()`, `runScore()`, `runCompose()`, `runAudit()` with the pool
- Remove artificial `delay()` calls — the pool's concurrency limit naturally rate-limits
- Default concurrency: **3** (configurable in `preferences.yaml`)
- Per-stage concurrency overrides: `extract: 5`, `score: 3`, `compose: 2`, `audit: 2`

**Files to modify:**
- `src/jobs/run.ts` — replace sequential loops with `asyncPool()`
- `src/utils/async-pool.ts` — new: `asyncPool` helper
- `local.example/preferences.yaml` — add `pipeline_concurrency` config

**Expected impact:**
- 16-job extract: ~2 min → ~30 sec (5 concurrent)
- 16-job score: ~45 sec → ~20 sec (3 concurrent)
- Full pipeline: ~5 min → ~2 min wall-clock time

**Safety:** LLM API rate limits are the natural backpressure — if DeepSeek returns 429, individual tasks retry without affecting others. The pool size should be tuned to stay under rate limits.

### Implementation Order

1. **Parallel pipeline** — concurrent job processing (see below)
2. **Users table + migration** — foundation
3. **Per-user scoring** (`user_scores` + scoring paths)
4. **User switcher in Web UI** — makes multi-user visible
5. **Per-user profiles** — directory restructuring
6. **Apply/response tracking** — `user_applications` + UI
7. **Per-user resumes** — `resume_versions.user_id`

### Key Files to Start With

```
src/db/schema.ts         ← Add users, user_scores, user_applications tables
src/db/init.ts           ← Add migration logic
src/jobs/score.ts        ← Write scores to user_scores instead of jobs table
src/ui/server.ts         ← User context, switcher API endpoints
src/ui/views/_head.ejs   ← User switcher dropdown
local.example/           ← Restructure profile templates
```

### Design Decisions to Make

1. Single shared DeepSeek key per instance, or per-user keys?
2. Can users see each other's scores? Default: no.
3. Default view: hide applied jobs? Default: yes.
4. Profile editing — per-user or only for active user?

### Non-Breaking v0.5 Baseline

All v0.5 commands and APIs continue to work. The migration auto-creates a `default` user so existing single-user setups just work. The v0.5 `jobs.score` column is kept for backward compatibility but new scores go to `user_scores`.

See also: `docs/v0.6-notes.md` and `docs/v0.6-notes_zh.md` for the full feature spec.
