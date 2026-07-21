# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot, etc.) working in this repository.

---

## Project: JobBot

AI-native personal job-search assistant. **Quality over quantity.** Not a commercial SaaS, not a mass-apply bot. Designed to work with AI coding agents — the user talks to the AI, the AI does the work.

## Onboarding: Profile Creation

When profile files are empty (first run), the AI MUST interview the user through conversation. Do NOT ask the user to edit YAML manually.

1. Ask about work history, education, skills → save the candidate profile through the profile store
2. Ask about job preferences, deal-breakers → save preferences through the profile store

Profiles are stored in the local SQLite database as immutable revisions. YAML is
an import/export compatibility format; do not ask the user to edit it manually.

**Hard rule:** Only write what the user tells you. Never invent or embellish.

## Personal Data vs. Project Code

- `local/` — **gitignored.** Database and generated resumes. NEVER commit.
- `local.example/` — Committed template. Shows the structure.
- Everything else — Committed. Safe for public GitHub.

## Safety Constraints (Hard Rules)

1. **No automated applications.** JobBot must never fill or submit job application forms. Applications happen outside JobBot and may only be tracked manually afterward.
2. **Never invent personal data.** Resumes and cover letters may only select or
   truthfully rephrase claims from their bound canonical profile revision, with
   explicit provenance and fail-closed truth validation.
3. **AI fills profiles.** Interview the user and create profile revisions. Do not tell them to manually edit files.

## Dependencies

- Node.js ≥ 20, pnpm
- **LaTeX** (texlive) — for resume/cover-letter PDF generation

## Commands

### Implemented core

```bash
pnpm jobbot init-db           # Create local/ + initialize SQLite
pnpm jobbot add-url <url>     # Add a job URL (ATS-detected)
pnpm jobbot score             # Score all jobs
pnpm jobbot list [--tier X]   # List jobs
pnpm test                     # Run tests (vitest)
pnpm typecheck                # TypeScript check
```

### Implemented pipeline

```bash
pnpm jobbot discover --query "..."    # Search job boards
pnpm jobbot extract --job <id>        # Scrape and parse job posting
pnpm jobbot tailor --job <id>         # Generate tailored resume data
pnpm jobbot render --job <id>         # Render LaTeX → PDF
pnpm jobbot cover-letter --job <id>   # Generate cover letter (LaTeX)
```

## Code Style

- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess`, `noUnusedLocals`)
- ESM (`"type": "module"`)
- One concern per file
- No `any` without justification
