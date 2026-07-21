# JobBot Architecture

JobBot is a local-first, personal job-search assistant. SQLite is the canonical
business data store. YAML, TeX, PDF, and audit JSON are import,
export, or generated artifacts; they are not independent sources of truth.

## Core invariants

1. `users.id`, `profiles.id`, and `profile_revisions.id` are distinct IDs.
2. Jobs are always accessed through their owning `user_id`.
3. Profile revisions are immutable. Editing creates and activates a revision.
4. A generated resume records its profile revision and immutable job snapshot.
5. Every emitted resume claim has source claim IDs. Unsupported identity,
   numeric, skill, project, or provenance changes block rendering.
6. Pipeline failures remain failures; they are never persisted as placeholder
   scores.
7. JobBot never fills or submits application forms; users apply manually and
   may record outcomes afterward.
8. LLM score responses, content audits, and visual audits are strict runtime
   contracts. Missing or malformed results fail; they never become defaults.
9. Active pipeline work has a database-level per-user/job lease. Scheduled
    work captures an explicit user context and cannot overlap for that user.
10. Cover letters use the same frozen evidence chain as resumes, with sentence
    provenance, semantic validation, versioned artifacts, and SHA-256 checks.

## Data flow

```text
profile revision ──→ candidate evidence ──┐
                                          ├─→ match plan ─→ provenanced claims
job snapshot ──────→ independently covered requirements ───────┘
                                                               ↓
                                                    truth validation
                                                               │
                                                               ↓
                                                    TeX/PDF artifacts
```

Profile data is stored only in immutable JSON revisions. The Web editor accepts
and displays YAML as an interchange format, but YAML is not persisted. Generated
`tailored.yaml` files remain artifacts rather than sources of truth.

## Layers

- `src/domain/` — runtime contracts and deterministic domain rules.
- `src/application/` — use-case orchestration with explicit `AppContext`.
- `src/repositories/` — typed SQLite persistence.
- `src/jobs/` — legacy-compatible job adapters and generation/rendering steps.
- `src/ui/` and `src/cli.ts` — interface adapters.

## Schema lifecycle

`src/db/schema.ts` is the single authoritative schema. JobBot currently assumes
a fresh local database and intentionally has no historical migration chain.
Schema changes during this development phase require recreating `local/`.

Requirement extraction is followed by a separate coverage decision over every
deterministically identified normative JD span. Source spans are persisted with
the frozen requirements; uncovered or untraceable spans block tailoring.

## Generated artifacts

Artifacts remain under `local/` and are registered with path, SHA-256, byte
size, draft, and resume version where applicable. They can be regenerated from
canonical inputs; deleting an artifact must not silently delete its provenance.
Audits read hash-verified bytes for an exact version.
Visual audit failure or unavailable vision configuration requires review and
cannot be treated as a content-only pass.
