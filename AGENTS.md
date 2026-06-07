# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot, etc.) working in this repository.

---

## Project: JobBot

AI-native personal job-search assistant. **Quality over quantity.** Not a commercial SaaS, not a mass-apply bot. Designed to work with AI coding agents — the user talks to the AI, the AI does the work.

## Onboarding: Profile Creation

When profile files are empty (first run), the AI MUST interview the user through conversation. Do NOT ask the user to edit YAML manually.

1. Ask about work history, education, skills → write `local/profile/candidate.yaml`
2. Ask about job preferences, deal-breakers → write `local/profile/preferences.yaml`
3. Ask about sensitive answers (citizenship, sponsorship, etc.) → write `local/profile/answers.yaml`

**Hard rule:** Only write what the user tells you. Never invent or embellish.

## Personal Data vs. Project Code

- `local/` — **gitignored.** Profile, database, resumes, browser sessions. NEVER commit.
- `local.example/` — Committed template. Shows the structure.
- Everything else — Committed. Safe for public GitHub.

## Safety Constraints (Hard Rules)

1. **Dry-run by default.** Application commands default to `--dry-run`. Only `--submit` triggers submission.
2. **Never auto-submit.** Never write code that submits without explicit user confirmation.
3. **Never invent personal data.** Resume tailoring may only reorder, select, or lightly rephrase data from `local/profile/candidate.yaml`.
4. **Respect `ask_every_time`.** Fields with `ask_every_time: true` must stop and prompt.
5. **Sensitive data is local only.** Never share or upload `local/profile/answers.yaml`.
6. **AI fills profiles.** Interview the user; write YAML. Do not tell them to manually edit files.
7. **Dedicated browser profile.** Use `local/browser-data/` — never the user's main profile.

## Dependencies

- Node.js ≥ 20, pnpm
- **LaTeX** (texlive) — for resume/cover-letter PDF generation
- **Playwright** (future) — for browser automation
- **Stagehand** (future) — for ambiguous form filling

## Commands

### Implemented (v0)

```bash
pnpm jobbot init-db           # Create local/ + initialize SQLite
pnpm jobbot add-url <url>     # Add a job URL (ATS-detected)
pnpm jobbot score             # Score all jobs
pnpm jobbot list [--tier X]   # List jobs
pnpm test                     # Run tests (vitest)
pnpm typecheck                # TypeScript check
```

### Planned (implement in order)

```bash
pnpm jobbot discover --query "..."    # Search job boards
pnpm jobbot extract --job <id>        # Scrape and parse job posting
pnpm jobbot tailor --job <id>         # Generate tailored resume data
pnpm jobbot render --job <id>         # Render LaTeX → PDF
pnpm jobbot cover-letter --job <id>   # Generate cover letter (LaTeX)
pnpm jobbot apply --job <id> --dry-run  # Fill form, stop before submit
pnpm jobbot apply --job <id> --submit   # Fill and submit (with confirmation)
pnpm jobbot sync-email                # Sync Gmail, classify messages
pnpm jobbot report                    # Analytics dashboard
```

## Code Style

- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess`, `noUnusedLocals`)
- ESM (`"type": "module"`)
- One concern per file
- No `any` without justification
