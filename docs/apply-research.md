# Apply Step Research — v1.0 Groundwork

## Overview

This document catalogs ATS form structures and informs the adapter interface design for the Apply step (v1.0). No executable code — just research, field maps, and an interface blueprint.

## ATS Form Structures

### Greenhouse

- **Form URL pattern:** `https://boards.greenhouse.io/{company}/jobs/{job_id}#app`
- **Form rendering:** JavaScript-rendered multi-page form. Fields load dynamically via their internal API.
- **Public API:** `https://boards.greenhouse.io/{company}/jobs/{job_id}?gh_src=...`
  - Returns JSON with job details, questions, and form configuration.
- **Key fields:**
  - `first_name`, `last_name` — text inputs
  - `email` — text input (validated)
  - `phone` — text input
  - `resume` — file upload (`.pdf`, `.docx`)
  - `cover_letter` — textarea or file upload (varies by company)
  - `linkedin_profile` — URL input (optional)
  - `website` — URL input (optional)
  - Custom questions — text, single-select, multi-select, boolean (varies per job)
- **Education / Experience sections:** Often present, with fields for school/degree/field of study, or past employment.
- **EEO/Demographics:** Standard US EEO questions (race, gender, veteran, disability). Usually optional with "I don't wish to answer" defaults.
- **Work authorization:** Usually a yes/no or multi-select dropdown.
- **Submission:** POST to `https://boards.greenhouse.io/{company}/jobs/{job_id}/applications`

### Lever

- **Form URL pattern:** `https://jobs.lever.co/{company}/{job_id}/apply`
- **Form rendering:** Single-page form with all fields visible. Server-rendered HTML with progressive enhancement.
- **Public API:** `https://api.lever.co/v0/postings/{company}/{job_id}`
  - Returns JSON with job details including application questions.
- **Key fields:**
  - `name` — single full-name field (not split)
  - `email` — text input
  - `phone` — text input
  - `resume` — file upload
  - `cover_letter` — textarea
  - `linkedin` — URL input (optional)
  - `website` / `portfolio` — URL input (optional)
  - Custom questions — text, dropdown, boolean
- **EEO/Demographics:** Standard set, varies by company/role/location.
- **Work authorization:** Typically a "Will you now or in the future require sponsorship?" yes/no.
- **Submission:** POST to `https://jobs.lever.co/{company}/{job_id}/apply`

### Ashby

- **Form URL pattern:** `https://jobs.ashbyhq.com/{company}/{job_id}/application`
- **Form rendering:** JavaScript SPA. Multi-step form with client-side validation.
- **Public API:** POST `https://jobs.ashbyhq.com/api/nonuser/{company}` returns job listings. Application form config is embedded in the page's initial state.
- **Key fields:**
  - `firstName`, `lastName` — text inputs
  - `email` — text input
  - `phone` — text input
  - `resume` — file upload
  - `linkedinUrl` — URL input (optional)
  - `website` — URL input (optional)
  - Custom questions — various types, defined per job
- **EEO/Demographics:** Standard US set, company-configurable.
- **Work authorization:** Dropdown (varies by company).
- **Submission:** POST to `https://jobs.ashbyhq.com/api/nonuser/{company}/application`

### Workday

- **Form URL pattern:** `https://{company}.myworkdayjobs.com/{career_site}/job/{location}/{job_id}/apply`
- **Form rendering:** Workday's proprietary UI framework. Heavy JavaScript, multi-step wizard.
- **Public API:** No public API. All interactions go through their UI framework.
- **Key fields:** (varies significantly by company configuration)
  - First/Last name, email, phone
  - Resume/CV upload
  - Work history (manual entry — often the biggest pain point)
  - Education history
  - EEO/Demographics
  - Work authorization
- **Notable challenges:**
  - CAPTCHA on submission
  - Session timeouts
  - Heavy client-side state management
  - No stable DOM selectors (auto-generated class names)
- **Recommendation:** Use Stagehand/Playwright with AI-assisted field detection for Workday. Deterministic selectors are not reliable.

### LinkedIn (Easy Apply)

- **Form URL pattern:** Inline overlay on LinkedIn job pages — no dedicated URL.
- **Form rendering:** LinkedIn's internal framework. Modal/overlay with pre-filled fields from the user's LinkedIn profile.
- **Key challenge:** Requires being logged into a LinkedIn account. Anti-bot detection is aggressive.
- **Recommendation:** Not worth automating at this stage. Easy Apply is already fast for humans. Focus on ATS forms first.

## Adapter Interface Design

```typescript
// src/apply/adapters/types.ts (proposed)

export interface AtsFormField {
  /** Human-readable label (e.g., "First Name") */
  label: string;
  /** Normalized field type */
  type: 'text' | 'email' | 'phone' | 'url' | 'textarea' | 'select' | 'multiselect' | 'checkbox' | 'file' | 'date' | 'boolean';
  /** Whether the field is required */
  required: boolean;
  /** For select/multiselect: available options */
  options?: { label: string; value: string }[];
  /** DOM selector or locator */
  selector?: string;
  /** Field ID if deterministically detectable */
  fieldId?: string;
}

export interface AtsForm {
  /** Which ATS this form belongs to */
  atsType: 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'generic';
  /** All detected fields */
  fields: AtsFormField[];
  /** The form action URL for submission */
  submitUrl: string;
  /** Any anti-bot measures detected (captcha, honeypot, etc.) */
  antiBotMeasures: string[];
}

export interface AtsAdapter {
  /** Adapter name */
  readonly name: string;

  /** Detect whether this adapter can handle the given URL */
  canHandle(url: string): boolean;

  /** Detect and parse the form on the page */
  detectForm(page: unknown /* Playwright Page */): Promise<AtsForm>;

  /** Fill a single field with the given value */
  fillField(page: unknown, field: AtsFormField, value: string): Promise<void>;

  /** Upload a resume file */
  uploadResume(page: unknown, filePath: string): Promise<void>;

  /** Submit the application. Should NOT submit if dryRun is true. */
  submit(page: unknown, dryRun: boolean): Promise<{ success: boolean; confirmationMessage?: string }>;
}
```

## Implementation Priority for v1.0

1. **Lever** — Simplest form (single page, server-rendered, stable selectors). Best to prototype first.
2. **Greenhouse** — Public API for form config makes field mapping easy. JS-rendered but well-structured.
3. **Ashby** — SPA with embedded initial state. Parsable but needs JS execution.
4. **Workday** — Most complex. Requires Stagehand/AI-assisted approach. Save for last.

## Field Mapping from Profile

| Profile Field (`answers.yaml`) | Greenhouse        | Lever      | Ashby         | Workday     |
|------------------|-------------------|------------|---------------|-------------|
| `work_auth`      | Custom question   | Custom Q   | Custom Q      | Custom Q    |
| `disability`     | EEO section       | Custom Q   | EEO section   | EEO section |
| `veteran`        | EEO section       | Custom Q   | EEO section   | EEO section |
| `gender`         | EEO section       | Custom Q   | EEO section   | EEO section |
| `race`           | EEO section       | Custom Q   | EEO section   | EEO section |
| `applied_before` | Custom question   | Custom Q   | Custom Q      | Custom Q    |

**Note:** EEO questions usually have "I don't wish to answer" options that can be safely selected by default.

## Browser Automation Notes

- **Playwright** is already set up in the project (`playwright.config.ts`).
- **Stagehand** is designed for AI-assisted browser automation and is well-suited for Workday's dynamic forms. It could serve as a fallback for any ATS when deterministic selectors fail.
- **Browser profile:** Always use `local/browser-data/` — never the user's main Chrome profile.
- **Anti-bot measures:** Some ATSes (especially Workday and LinkedIn) use CAPTCHA, invisible honeypots, or behavior analysis. The adapter interface's `antiBotMeasures` field helps track these so we can route to Stagehand or manual intervention.

## Open Questions

1. Should we pre-fill EEO fields with "Decline to answer" by default, or ask the user per-application?
2. For file upload fields — do we need to handle different file picker implementations?
3. Should the apply step integrate with the `ask_every_time` mechanism in `answers.yaml`?
4. How to handle "Add another job" (multi-position) forms in Workday and Greenhouse?
