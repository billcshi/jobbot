# JobBot v0.7 — Handoff (Actual: Bug Bash + Visual Audit)

## What v0.7 Actually Delivered

v0.7 shipped as a **quality and polish** release. Browser automation was deferred to v0.8. Instead we focused on:

### Visual Audit System (early v0.7 commits)

- **Multi-provider visual audit** — Claude Vision → OpenAI GPT-5.5 fallback → graceful skip
- **LLM LaTeX template fixing** — audit visual issues feed back into LaTeX template adjustments before pdflatex
- **Re-compose with Feedback** buttons — "Re-compose with TeX Fix" and "Re-compose (Content Only)" on job detail page
- **Audit attempt tracking** — `audit_failed` terminal status after 3 failed retries

### Bug Bash + Polish (this session)

- **Tier gating** — auto-pipeline only processes A/B tier; C tier requires manual action
- **Descriptive PDF download filenames** — `Name_Company_Date_v{id}.pdf` instead of `resume.pdf`
- **Experience ordering** — reverse-chronological enforcement (prompt + deterministic sort + audit committee)
- **Pipeline UI fixes** — web UI no longer shows "Idle" while pipeline runs; task pool auto-cleanup
- **Dashboard sort fix** — COALESCE fallback to `jobs.score` for legacy jobs; tier derived from score
- **LaTeX fix opt-in** — only runs when user explicitly clicks "Re-compose with TeX Fix"
- **Resume / Restart buttons** — two distinct pipeline actions on job detail page
- **1-page limit softened** — audit committee judges instead of hard constraint

## What We Learned

- **Silent failures are the worst bugs.** The pipeline running but UI showing "Idle" went unnoticed for weeks. Every background process needs visible state.
- **LLMs don't follow ordering instructions reliably.** Even with explicit prompt instructions, DeepSeek reorders experience by relevance. Deterministic post-processing is necessary for structural constraints.
- **Tier is metadata, not a gate for manual actions.** Filtering tiers in the automatic pipeline makes sense, but blocking manual user actions based on tier is wrong.
- **DB records ≠ filesystem reality.** Stale `pdf_path` entries in `resume_versions` that point to deleted files cause broken download links. Always verify file existence before showing download UI.
- **`COALESCE` in SQL needs to cover all fallbacks.** `COALESCE(us.score, -1)` sorts jobs without `user_scores` to the bottom — but those jobs have valid `jobs.score` values. Fall back to `j.score` before `-1`.

## What's Deferred to v0.8

All of the original v0.7 plan that wasn't done:

- **Browser automation** (Playwright + Stagehand) — the top priority for v0.8
- Job Discovery v2 (multi-source, scheduled, dedup)
- Interview preparation
- Email integration
- Analytics dashboard
- Prompt engineering v2 (A/B testing)
- Multi-resume variants (partially implemented — variant selection exists but prompt variants don't)

## Current System Health

| Area | Status |
|---|---|
| Pipeline reliability | ✅ Concurrent, per-user, cancelable, state tracked correctly |
| Scoring accuracy | ✅ LLM + deterministic fallback, tier from score |
| Resume quality | ✅ Committee audit (3 reviewers), visual + content scoring |
| UI completeness | ✅ Dashboard, pipeline, job detail, profile editor, AI log |
| Download UX | ✅ Descriptive filenames, file existence verified |
| Error handling | ✅ Empty response retry, JSON parsing recovery, stale file detection |
| Known gaps | Browser automation (v0.8), email sync (v1.5), analytics (v2.0) |

## v0.8 Handoff

See `docs/handoff-v0.8.md` for the v0.8 plan.
