# JobBot Data Pipeline

## Overview

```
                         ┌─────────────────────────────────────────┐
                         │              JOB BOARDS                   │
                         │  Greenhouse · Lever · Ashby · LinkedIn    │
                         └────────────────┬────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: INGEST                                                              │
│                                                                              │
│  pnpm jobbot add-url <url>                                                   │
│                                                                              │
│  ┌─────────────┐     ┌─────────────────┐     ┌──────────────────────┐       │
│  │  parse URL   │────▶│  detect-ats.ts  │────▶│  INSERT INTO jobs     │       │
│  │  (validate)  │     │  greenhouse     │     │  url, ats_type,        │       │
│  └─────────────┘     │  lever          │     │  status='new'          │       │
│                       │  ashby          │     └──────────────────────┘       │
│                       │  workday        │                                     │
│                       │  linkedin       │                                     │
│                       │  generic        │                                     │
│                       └─────────────────┘                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: EXTRACT                                                             │
│                                                                              │
│  pnpm jobbot extract [--job <id>]                                            │
│                                                                              │
│  ┌──────────────┐    ┌──────────────────┐    ┌─────────────────────┐        │
│  │  fetch(url)   │───▶│  htmlToText()    │───▶│  DeepSeek LLM        │        │
│  │  HTTP GET     │    │  strip scripts,  │    │  prompts/extract-    │        │
│  │               │    │  nav, styles     │    │  job.md              │        │
│  └──────────────┘    └──────────────────┘    └────────┬────────────┘        │
│                                                        │                      │
│                                                        ▼                      │
│                                          ┌─────────────────────────┐         │
│                                          │  Structured JSON:        │         │
│                                          │  { title, company,       │         │
│                                          │    location, description,│         │
│                                          │    applyUrl }            │         │
│                                          └───────────┬─────────────┘         │
│                                                      │                        │
│                                                      ▼                        │
│                                          ┌─────────────────────────┐         │
│                                          │  UPDATE jobs SET         │         │
│                                          │  title, company,         │         │
│                                          │  location, description,  │         │
│                                          │  apply_url               │         │
│                                          └─────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: SCORE                                                               │
│                                                                              │
│  pnpm jobbot score                                                           │
│                                                                              │
│  ┌─────────────────────┐                                                     │
│  │  For each job in     │                                                     │
│  │  jobs table:         │                                                     │
│  └────────┬────────────┘                                                     │
│           │                                                                    │
│           ▼                                                                    │
│  ┌──────────────────────────────────────────────────────────────────┐       │
│  │                        DeepSeek LLM                                │       │
│  │                                                                   │       │
│  │  INPUT:                                                           │       │
│  │    · Job description, title, company, location                    │       │
│  │    · Candidate: work_experience, education, skills                │       │
│  │    · Preferences: titles, locations, industries, deal-breakers    │       │
│  │    · Prompt: prompts/score-job.md                                 │       │
│  │                                                                   │       │
│  │  OUTPUT (JSON):                                                   │       │
│  │    · score (0.0 - 1.0)                                            │       │
│  │    · tier (A/B/C/D)                                               │       │
│  │    · reason (explanation)                                         │       │
│  │    · deal_breakers_triggered                                      │       │
│  │    · highlights / concerns                                        │       │
│  └──────────────────────────────────────────────────────────────────┘       │
│           │                                                                    │
│           ▼                                                                    │
│  ┌─────────────────────────┐                                                 │
│  │  UPDATE jobs SET         │                                                 │
│  │  score, tier,            │                                                 │
│  │  score_reason             │                                                 │
│  └─────────────────────────┘                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: LIST & FILTER                                                       │
│                                                                              │
│  pnpm jobbot list [--tier A]                                                 │
│                                                                              │
│  ┌──────────────────────┐                                                    │
│  │  SELECT from jobs     │                                                    │
│  │  ORDER BY score DESC  │                                                    │
│  │  [WHERE tier = ?]     │                                                    │
│  └──────────────────────┘                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 5: TAILOR (v0.3 — planned)                                             │
│                                                                              │
│  pnpm jobbot tailor --job <id>                                               │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────┐       │
│  │                        DeepSeek LLM                                │       │
│  │                                                                   │       │
│  │  INPUT:                                                           │       │
│  │    · Job description, title, company                              │       │
│  │    · Candidate: full profile                                      │       │
│  │    · Prompt: prompts/tailor-resume.md                             │       │
│  │                                                                   │       │
│  │  OUTPUT (YAML):                                                   │       │
│  │    · Selected experience entries (reordered for relevance)        │       │
│  │    · Tailored highlights (lightly rephrased, NOT fabricated)      │       │
│  │    · Keyword adjustments                                          │       │
│  │    · Professional summary                                         │       │
│  └──────────────────────────────────────────────────────────────────┘       │
│           │                                                                    │
│           ▼                                                                    │
│  ┌─────────────────────────┐                                                 │
│  │  INSERT INTO             │                                                 │
│  │  resume_versions         │                                                 │
│  └─────────────────────────┘                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 6: RENDER (v0.4 — planned)                                             │
│                                                                              │
│  pnpm jobbot render --job <id>                                               │
│                                                                              │
│  ┌──────────────────────┐    ┌───────────────┐    ┌────────────────┐        │
│  │  Inject tailored      │───▶│  pdflatex      │───▶│  resume.pdf     │        │
│  │  data into            │    │  compile       │    │  in local/      │        │
│  │  resumes/master.tex   │    │                │    │  resumes/       │        │
│  └──────────────────────┘    └───────────────┘    └────────────────┘        │
└─────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 7: APPLY (v1.0 — planned)                                              │
│                                                                              │
│  pnpm jobbot apply --job <id> --dry-run    (default: stop before submit)     │
│  pnpm jobbot apply --job <id> --submit     (explicit submit)                 │
│                                                                              │
│  ┌────────────────┐    ┌─────────────────┐    ┌───────────────────┐         │
│  │  Playwright     │    │  ATS Adapter     │    │  Stagehand          │         │
│  │  (deterministic)│    │  Greenhouse     │    │  (ambiguous forms)  │         │
│  │                 │    │  Lever          │    │  AI-driven fill     │         │
│  │                 │    │  Ashby          │    │                     │         │
│  └────────────────┘    └─────────────────┘    └───────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Agent Responsibilities

| Agent | Trigger | Input | Output | Model |
|---|---|---|---|---|
| **Extract Agent** | `pnpm jobbot extract` | HTML text | JSON: {title, company, location, description, applyUrl} | deepseek-chat |
| **Score Agent** | `pnpm jobbot score` | Job desc + candidate + preferences | JSON: {score, tier, reason, highlights} | deepseek-chat |
| **Tailor Agent** | `pnpm jobbot tailor` | Job desc + candidate | YAML: tailored resume data | deepseek-chat (planned) |
| **Apply Agent** | `pnpm jobbot apply` | Form HTML + answers | Browser actions | Stagehand (planned) |

## Data Storage

```
local/                          (gitignored — personal data)
  profile/
    candidate.yaml                  Candidate background
    preferences.yaml                Scoring preferences
    answers.yaml                    Sensitive answers
  data/
    jobbot.sqlite
      ├── jobs                      All job postings
      ├── resume_versions           Generated tailored resumes
      ├── applications              Application tracking
      ├── events                    Timeline events
      └── job_market_data           Self-evolving market intelligence
  resumes/
    versions/                       Generated .tex files
    output/                         Compiled PDFs
  browser-data/                     Playwright profile
```
