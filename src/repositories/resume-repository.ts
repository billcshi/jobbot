import type Database from 'better-sqlite3';
import { getDb } from '../db/client.js';
import { parseJsonObject, stringifyJson, type JsonObject } from '../domain/shared/json.js';
import { optionalNumber, optionalString, requiredNumber, requiredString } from '../domain/shared/rows.js';

export type ResumeDraftStatus = 'planned' | 'generated' | 'validated' | 'rejected' | 'rendered';
export interface ResumeDraft {
  id: number;
  jobId: number;
  userId: number | null;
  profileRevisionId: number;
  jobSnapshotId: number;
  status: ResumeDraftStatus;
  plan: JsonObject;
  content: JsonObject | null;
  promptVersion: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateResumeDraftInput {
  jobId: number;
  userId?: number | null;
  profileRevisionId: number;
  jobSnapshotId: number;
  plan: JsonObject;
  promptVersion?: string;
  model?: string;
}

export interface CreateResumeVersionInput {
  jobId: number;
  userId?: number | null;
  draftId: number;
  profileRevisionId: number;
  jobSnapshotId: number;
  versionName: string;
  texPath: string;
  pdfPath?: string | null;
  content: JsonObject;
  promptVersion?: string;
  model?: string;
}

export type ClaimTransformation = 'verbatim' | 'rewrite' | 'combine' | 'omit';
export type ClaimValidationStatus = 'pending' | 'valid' | 'invalid' | 'needs_review';
export interface ResumeClaimInput {
  section: string;
  ordinal: number;
  renderedText: string;
  /** Stable evidence IDs (for example `experience:0:highlight:0`). */
  sourceClaimIds: string[];
  transformation: ClaimTransformation;
  validationStatus?: ClaimValidationStatus;
  validationNotes?: string;
}

export interface ArtifactInput {
  draftId?: number;
  resumeVersionId?: number;
  type: string;
  path: string;
  sha256?: string;
  byteSize?: number;
}

export class ResumeRepository {
  public constructor(private readonly db: Database.Database = getDb()) {}

  public createDraft(input: CreateResumeDraftInput): ResumeDraft {
    assertId(input.jobId, 'jobId');
    assertId(input.profileRevisionId, 'profileRevisionId');
    assertId(input.jobSnapshotId, 'jobSnapshotId');
    const ownerId = this.validateOwnership(
      input.jobId,
      input.userId,
      input.profileRevisionId,
      input.jobSnapshotId,
    );
    const result = this.db.prepare(`
      INSERT INTO resume_drafts
        (job_id, user_id, profile_revision_id, job_snapshot_id, plan_json, prompt_version, model)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.jobId,
      ownerId,
      input.profileRevisionId,
      input.jobSnapshotId,
      stringifyJson(input.plan),
      input.promptVersion ?? null,
      input.model ?? null,
    );
    return this.requireDraft(Number(result.lastInsertRowid));
  }

  public updateDraft(
    draftId: number,
    status: ResumeDraftStatus,
    content?: JsonObject,
  ): ResumeDraft {
    assertId(draftId, 'draftId');
    const result = this.db.prepare(`
      UPDATE resume_drafts
      SET status = ?, content_json = COALESCE(?, content_json), updated_at = datetime('now')
      WHERE id = ?
    `).run(status, content === undefined ? null : stringifyJson(content), draftId);
    if (result.changes === 0) throw new Error(`Resume draft ${draftId} does not exist`);
    return this.requireDraft(draftId);
  }

  /** Persist version metadata and provenance; file contents remain artifacts. */
  public createVersion(input: CreateResumeVersionInput): number {
    assertId(input.draftId, 'draftId');
    const draft = this.requireDraft(input.draftId);
    if (draft.jobId !== input.jobId
      || draft.profileRevisionId !== input.profileRevisionId
      || draft.jobSnapshotId !== input.jobSnapshotId) {
      throw new Error(`Resume draft ${input.draftId} does not match the requested job/profile/snapshot`);
    }
    const ownerId = this.validateOwnership(
      input.jobId,
      input.userId,
      input.profileRevisionId,
      input.jobSnapshotId,
    );
    if (draft.userId !== ownerId) {
      throw new Error(`Resume draft ${input.draftId} does not belong to user ${ownerId}`);
    }
    if (!input.versionName.trim() || !input.texPath.trim()) {
      throw new Error('versionName and texPath are required');
    }
    const result = this.db.prepare(`
      INSERT INTO resume_versions
        (job_id, user_id, version_name, tex_path, pdf_path, draft_id, profile_revision_id,
         job_snapshot_id, content_json, prompt_version, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.jobId,
      ownerId,
      input.versionName,
      input.texPath,
      input.pdfPath ?? null,
      input.draftId,
      input.profileRevisionId,
      input.jobSnapshotId,
      stringifyJson(input.content),
      input.promptVersion ?? null,
      input.model ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  public replaceClaims(resumeVersionId: number, claims: ResumeClaimInput[]): void {
    assertId(resumeVersionId, 'resumeVersionId');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM resume_claims WHERE resume_version_id = ?').run(resumeVersionId);
      const insert = this.db.prepare(`
        INSERT INTO resume_claims
          (resume_version_id, section, ordinal, rendered_text, source_claim_ids_json,
           transformation, validation_status, validation_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const claim of claims) {
        if (!claim.section.trim() || !claim.renderedText.trim()) {
          throw new Error('Resume claims need section and renderedText');
        }
        if (!Number.isInteger(claim.ordinal) || claim.ordinal < 0) {
          throw new Error('Resume claim ordinal must be a non-negative integer');
        }
        if (!claim.sourceClaimIds.every((id) => id.trim().length > 0)) {
          throw new Error('sourceClaimIds must contain non-empty stable IDs');
        }
        insert.run(
          resumeVersionId,
          claim.section,
          claim.ordinal,
          claim.renderedText,
          stringifyJson(claim.sourceClaimIds),
          claim.transformation,
          claim.validationStatus ?? 'pending',
          claim.validationNotes ?? null,
        );
      }
    })();
  }

  public addArtifact(input: ArtifactInput): number {
    if (input.draftId === undefined && input.resumeVersionId === undefined) {
      throw new Error('An artifact must belong to a draft or resume version');
    }
    if (!input.type.trim() || !input.path.trim()) throw new Error('Artifact type and path are required');
    if (input.byteSize !== undefined && (!Number.isInteger(input.byteSize) || input.byteSize < 0)) {
      throw new Error('byteSize must be a non-negative integer');
    }
    const result = this.db.prepare(`
      INSERT INTO artifacts
        (resume_draft_id, resume_version_id, artifact_type, path, sha256, byte_size)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.draftId ?? null,
      input.resumeVersionId ?? null,
      input.type,
      input.path,
      input.sha256 ?? null,
      input.byteSize ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  public getDraft(draftId: number): ResumeDraft | null {
    assertId(draftId, 'draftId');
    const row = this.db.prepare('SELECT * FROM resume_drafts WHERE id = ?').get(draftId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapDraft(row) : null;
  }

  private requireDraft(draftId: number): ResumeDraft {
    const draft = this.getDraft(draftId);
    if (!draft) throw new Error(`Resume draft ${draftId} does not exist`);
    return draft;
  }

  private validateOwnership(
    jobId: number,
    requestedUserId: number | null | undefined,
    profileRevisionId: number,
    jobSnapshotId: number,
  ): number {
    const row = this.db.prepare(`
      SELECT
        j.user_id AS job_user_id,
        p.user_id AS profile_user_id,
        js.job_id AS snapshot_job_id,
        js.user_id AS snapshot_user_id
      FROM jobs j
      JOIN profile_revisions pr ON pr.id = ?
      JOIN profiles p ON p.id = pr.profile_id
      JOIN job_snapshots js ON js.id = ?
      WHERE j.id = ?
    `).get(profileRevisionId, jobSnapshotId, jobId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Job, profile revision, or job snapshot does not exist');
    const jobOwner = optionalNumber(row, 'job_user_id');
    const profileOwner = requiredNumber(row, 'profile_user_id');
    const snapshotOwner = optionalNumber(row, 'snapshot_user_id');
    if (jobOwner === null) throw new Error(`Job ${jobId} has no owner`);
    if (requestedUserId !== undefined && requestedUserId !== null && requestedUserId !== jobOwner) {
      throw new Error(`Job ${jobId} does not belong to user ${requestedUserId}`);
    }
    if (profileOwner !== jobOwner) {
      throw new Error(`Profile revision ${profileRevisionId} does not belong to job owner ${jobOwner}`);
    }
    if (requiredNumber(row, 'snapshot_job_id') !== jobId || snapshotOwner !== jobOwner) {
      throw new Error(`Job snapshot ${jobSnapshotId} does not belong to job ${jobId} and user ${jobOwner}`);
    }
    return jobOwner;
  }
}

function mapDraft(row: Record<string, unknown>): ResumeDraft {
  const status = requiredString(row, 'status');
  if (!isDraftStatus(status)) throw new Error(`Unknown resume draft status: ${status}`);
  const rawContent = optionalString(row, 'content_json');
  return {
    id: requiredNumber(row, 'id'),
    jobId: requiredNumber(row, 'job_id'),
    userId: optionalNumber(row, 'user_id'),
    profileRevisionId: requiredNumber(row, 'profile_revision_id'),
    jobSnapshotId: requiredNumber(row, 'job_snapshot_id'),
    status,
    plan: parseJsonObject(requiredString(row, 'plan_json'), 'plan_json'),
    content: rawContent === null ? null : parseJsonObject(rawContent, 'content_json'),
    promptVersion: optionalString(row, 'prompt_version'),
    model: optionalString(row, 'model'),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
  };
}

function isDraftStatus(value: string): value is ResumeDraftStatus {
  return value === 'planned' || value === 'generated' || value === 'validated'
    || value === 'rejected' || value === 'rendered';
}

function assertId(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}
