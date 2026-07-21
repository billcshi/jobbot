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
│  STEP 5: TAILOR (implemented)                                                │
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
│  │  OUTPUT (canonical JSON + YAML artifact):                         │       │
│  │    · Frozen requirements and evidence match plan                  │       │
│  │    · Reworded claims with source-claim provenance                 │       │
│  │    · Deterministic and semantic truth validation                  │       │
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
│  STEP 6: RENDER (implemented)                                                │
│                                                                              │
│  pnpm jobbot render --job <id>                                               │
│                                                                              │
│  ┌──────────────────────┐    ┌───────────────┐    ┌────────────────┐        │
│  │  Inject tailored      │───▶│  pdflatex      │───▶│  resume.pdf     │        │
│  │  data into            │    │  compile       │    │  in local/      │        │
│  │  resumes/master.tex   │    │                │    │  resumes/       │        │
│  └──────────────────────┘    └───────────────┘    └────────────────┘        │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Agent Responsibilities

| Agent | Trigger | Input | Output | Model |
|---|---|---|---|---|
| **Extract Agent** | `pnpm jobbot extract` | HTML text | JSON: {title, company, location, description, applyUrl} | deepseek-chat |
| **Score Agent** | `pnpm jobbot score` | Job desc + candidate + preferences | JSON: {score, tier, reason, highlights} | deepseek-chat |
| **Tailor Agent** | `pnpm jobbot tailor` | Frozen job snapshot + profile revision | Provenanced resume version | DeepSeek |

## Data Storage

```
local/                          (gitignored — personal data)
  data/jobbot.sqlite            Canonical profiles, jobs, runs, and provenance
  resumes/<job-id>/             Generated YAML/TeX/PDF artifacts for one job
```

JobBot stops after generating and auditing application materials. Users submit
applications themselves outside the project and may record outcomes manually in
the Web UI.
