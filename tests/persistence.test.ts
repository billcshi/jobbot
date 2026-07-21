import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { reconcileInterruptedRuns } from '../src/db/init.js';
import { ProfileRepository } from '../src/repositories/profile-repository.js';
import { JobKnowledgeRepository } from '../src/repositories/job-knowledge-repository.js';
import { ResumeRepository } from '../src/repositories/resume-repository.js';
import { PipelineRunRepository } from '../src/repositories/pipeline-run-repository.js';
import { SqlitePipelineRepository } from '../src/application/pipeline/sqlite-pipeline-repository.js';

describe('canonical persistence', () => {
  let db: Database.Database;
  let userId: number;
  let jobId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    userId = Number(db.prepare("INSERT INTO users (name) VALUES ('test-user')").run().lastInsertRowid);
    jobId = Number(db.prepare(
      "INSERT INTO jobs (url, user_id, title, description) VALUES ('https://example.test/job', ?, 'Engineer', 'Build systems')",
    ).run(userId).lastInsertRowid);
  });

  afterEach(() => db.close());

  it('creates the complete schema idempotently without migration bookkeeping', () => {
    expect(() => db.exec(SCHEMA_SQL)).not.toThrow();
    expect(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'profiles', 'job_snapshots', 'resume_drafts', 'cover_letter_versions',
        'user_credentials', 'auth_sessions'
      ) ORDER BY name
    `).all()).toEqual([
      { name: 'auth_sessions' },
      { name: 'cover_letter_versions' },
      { name: 'job_snapshots' },
      { name: 'profiles' },
      { name: 'resume_drafts' },
      { name: 'user_credentials' },
    ]);
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get()).toBeUndefined();
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_preferences'",
    ).get()).toBeUndefined();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('persists versioned profile, job, resume, provenance, artifacts, and run state', () => {
    const profiles = new ProfileRepository(db);
    const revision = profiles.createRevision({
      userId,
      candidate: { name: 'Ada', skills: ['TypeScript'] },
      preferences: { remote: true },
      source: 'editor',
      claims: [{ category: 'skill', key: 'typescript', value: 'TypeScript' }],
    });
    const sameRevision = profiles.createRevision({
      userId,
      candidate: { name: 'Ada', skills: ['TypeScript'] },
      preferences: { remote: true },
      source: 'editor',
      claims: [{ category: 'skill', key: 'typescript', value: 'TypeScript' }],
    });
    expect(sameRevision.id).toBe(revision.id);
    expect(profiles.listClaims(revision.id)).toMatchObject([{
      category: 'skill', key: 'typescript', value: 'TypeScript', userConfirmed: true,
    }]);

    const jobs = new JobKnowledgeRepository(db);
    const snapshot = jobs.captureSnapshot({
      jobId,
      userId,
      sourceUrl: 'https://example.test/job',
      title: 'Engineer',
      description: 'Build TypeScript systems',
    });
    expect(jobs.captureSnapshot({
      jobId,
      userId,
      sourceUrl: 'https://example.test/job',
      title: 'Engineer',
      description: 'Build TypeScript systems',
    }).id).toBe(snapshot.id);
    const initializedRequirements = jobs.initializeRequirements(snapshot.id, [{
      category: 'skill', text: 'TypeScript', importance: 'required', keywords: ['TypeScript'],
      sourceSpans: ['Build TypeScript systems'],
    }]);
    expect(initializedRequirements).toHaveLength(1);
    expect(initializedRequirements[0]?.key).toMatch(/^skill:/);
    // Compatibility API is initialize-once; retries cannot mutate evidence.
    expect(jobs.replaceRequirements(snapshot.id, [{
      category: 'skill', text: 'Rust', importance: 'preferred', keywords: ['Rust'],
      sourceSpans: ['Rust is preferred'],
    }])).toEqual(initializedRequirements);
    expect(jobs.getLatestSnapshot(jobId)?.requirementsFrozenAt).not.toBeNull();

    const resumes = new ResumeRepository(db);
    const draft = resumes.createDraft({
      jobId,
      userId,
      profileRevisionId: revision.id,
      jobSnapshotId: snapshot.id,
      plan: { focus: 'TypeScript' },
      promptVersion: 'v1',
    });
    expect(resumes.updateDraft(draft.id, 'validated', { summary: 'Engineer' }).status).toBe('validated');
    const versionId = resumes.createVersion({
      jobId,
      userId,
      draftId: draft.id,
      profileRevisionId: revision.id,
      jobSnapshotId: snapshot.id,
      versionName: 'v1',
      texPath: '/tmp/resume.tex',
      content: { summary: 'Engineer' },
    });
    resumes.replaceClaims(versionId, [{
      section: 'summary', ordinal: 0, renderedText: 'TypeScript engineer',
      sourceClaimIds: ['skill:typescript'], transformation: 'rewrite',
      validationStatus: 'valid',
    }]);
    expect(db.prepare('SELECT validation_status FROM resume_claims WHERE resume_version_id = ?').get(versionId))
      .toEqual({ validation_status: 'valid' });
    resumes.addArtifact({ resumeVersionId: versionId, type: 'tex', path: '/tmp/resume.tex' });

    const runs = new PipelineRunRepository(db);
    const run = runs.start(jobId, userId, 'test');
    const stage = runs.startStage(run.id, 'compose');
    runs.finishStage(stage.id, 'succeeded', { resumeVersionId: versionId });
    expect(runs.finish(run.id, 'succeeded').status).toBe('succeeded');
    expect(() => runs.finish(run.id, 'failed')).toThrow('already terminal');
  });

  it('rejects non-JSON profile values before writing', () => {
    const profiles = new ProfileRepository(db);
    expect(() => profiles.createRevision({
      userId,
      candidate: { invalid: Number.NaN },
      preferences: {},
      source: 'editor',
    })).toThrow('finite number');
  });

  it('rejects cross-user and mismatched resume provenance', () => {
    const profiles = new ProfileRepository(db);
    const ownerRevision = profiles.createRevision({
      userId, candidate: {}, preferences: {}, source: 'editor',
    });
    const otherUserId = Number(db.prepare("INSERT INTO users (name) VALUES ('other')").run().lastInsertRowid);
    const otherRevision = profiles.createRevision({
      userId: otherUserId, candidate: {}, preferences: {}, source: 'editor',
    });
    const jobs = new JobKnowledgeRepository(db);
    const snapshot = jobs.captureSnapshot({
      jobId, userId, sourceUrl: 'https://example.test/job', description: 'Build systems',
    });
    const resumes = new ResumeRepository(db);
    expect(() => resumes.createDraft({
      jobId, userId, profileRevisionId: otherRevision.id, jobSnapshotId: snapshot.id, plan: {},
    })).toThrow('does not belong to job owner');
    expect(() => resumes.createDraft({
      jobId, userId: otherUserId, profileRevisionId: ownerRevision.id, jobSnapshotId: snapshot.id, plan: {},
    })).toThrow('does not belong to user');

    const draft = resumes.createDraft({
      jobId, userId, profileRevisionId: ownerRevision.id, jobSnapshotId: snapshot.id, plan: {},
    });
    expect(() => resumes.createVersion({
      jobId,
      userId,
      draftId: draft.id,
      profileRevisionId: otherRevision.id,
      jobSnapshotId: snapshot.id,
      versionName: 'invalid',
      texPath: '/tmp/invalid.tex',
      content: {},
    })).toThrow('does not match');

    const runs = new PipelineRunRepository(db);
    expect(() => runs.start(jobId, otherUserId, 'cross-user')).toThrow('not owned');
    expect(() => runs.start(jobId, null as unknown as number, 'missing-user'))
      .toThrow('userId must be a positive integer');
  });

  it('reconciles stale running work and rejects terminal transitions', () => {
    const runs = new PipelineRunRepository(db);
    const run = runs.start(jobId, userId, 'interrupted');
    const stage = runs.startStage(run.id, 'extract');

    reconcileInterruptedRuns(db);

    expect(runs.get(run.id)?.status).toBe('cancelled');
    expect(db.prepare('SELECT status FROM stage_runs WHERE id = ?').get(stage.id))
      .toEqual({ status: 'cancelled' });
    expect(() => runs.finish(run.id, 'succeeded')).toThrow('already terminal');
    expect(() => runs.finishStage(stage.id, 'succeeded')).toThrow('already terminal');
  });

  it('atomically excludes active runs across independent SQLite connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jobbot-pipeline-run-'));
    const databasePath = join(directory, 'jobbot.db');
    const firstDb = new Database(databasePath);
    const secondDb = new Database(databasePath);
    try {
      firstDb.pragma('foreign_keys = ON');
      secondDb.pragma('foreign_keys = ON');
      firstDb.exec(SCHEMA_SQL);
      const sharedUserId = Number(firstDb.prepare("INSERT INTO users (name) VALUES ('shared-user')").run().lastInsertRowid);
      const sharedJobId = Number(firstDb.prepare(
        "INSERT INTO jobs (url, user_id, title) VALUES ('https://example.test/shared', ?, 'Engineer')",
      ).run(sharedUserId).lastInsertRowid);
      const firstRuns = new PipelineRunRepository(firstDb);
      const secondRuns = new PipelineRunRepository(secondDb);

      const active = firstRuns.start(sharedJobId, sharedUserId, 'first-connection');
      expect(() => secondRuns.start(sharedJobId, sharedUserId, 'second-connection'))
        .toThrow('already has an active pipeline run');
      expect(firstDb.prepare(
        "SELECT COUNT(*) AS count FROM pipeline_runs WHERE job_id = ? AND user_id = ? AND status = 'running'",
      ).get(sharedJobId, sharedUserId)).toEqual({ count: 1 });

      firstRuns.finish(active.id, 'succeeded');
      expect(secondRuns.start(sharedJobId, sharedUserId, 'after-finish').status).toBe('running');
    } finally {
      secondDb.close();
      firstDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records audit retry compose stages inside the active pipeline run', () => {
    const repository = new SqlitePipelineRepository(db);
    const base = { userId, profileId: 1, jobId };

    repository.recordStage({ ...base, stage: 'audit', outcome: 'started' });
    repository.recordStage({
      ...base,
      stage: 'compose',
      outcome: 'started',
      metadata: { audit_retry: 1 },
    });

    expect(db.prepare("SELECT COUNT(*) AS count FROM pipeline_runs WHERE status = 'running'").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM stage_runs WHERE status = 'running'").get())
      .toEqual({ count: 2 });

    repository.recordStage({
      ...base,
      stage: 'compose',
      outcome: 'succeeded',
      metadata: { audit_retry: 1 },
    });
    repository.recordStage({ ...base, stage: 'audit', outcome: 'failed', error: 'quality gate' });

    expect(db.prepare('SELECT status FROM pipeline_runs').all()).toEqual([{ status: 'failed' }]);
    expect(db.prepare('SELECT stage, status FROM stage_runs ORDER BY id').all()).toEqual([
      { stage: 'audit', status: 'failed' },
      { stage: 'compose', status: 'succeeded' },
    ]);
  });
});
