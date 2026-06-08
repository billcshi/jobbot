Read docs/handoff-v0.4.md first. Then read CLAUDE.md and the key source files to understand the project.

I'm continuing work on JobBot, a personal job-search assistant. We just finished v0.3 (web UI + pipeline visualization) and are starting v0.4.

v0.4 has three goals (see handoff for details):

1. **Pipeline Automation** — `pnpm jobbot run` command that extracts and scores all queued jobs automatically. Run extract on jobs with `title IS NULL` (skipping failed ones unless retry), then score on jobs with `score IS NULL OR score = 0`. Serial execution, logging progress.

2. **Delete Functionality** — `pnpm jobbot delete --job <id>` CLI command, plus delete buttons in the web UI (dashboard rows, job detail page, pipeline audit queues). Bulk delete for D-tier. Confirmation dialogs.

3. **Resume Composition** — `pnpm jobbot tailor --job <id>` (LLM tailors resume to job), `pnpm jobbot render --job <id>` (LaTeX → PDF), `pnpm jobbot compose --job <id>` (both).

The web UI is at `pnpm jobbot ui` → http://localhost:3000. The database has 11 real jobs, 3 extracted+scored.

Start by reading the handoff, then explore the existing code, then start building. Don't commit until I ask. Don't push without approval.
