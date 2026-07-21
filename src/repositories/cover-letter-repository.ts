import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { getDb } from '../db/client.js';
import type { ProvenancedCoverLetter } from '../domain/cover-letter/contract.js';
import type { CoverLetterEntailmentAssessment } from '../cover-letter/entailment.js';
import { parseJsonObject, parseJsonValue, stringifyJson, type JsonObject } from '../domain/shared/json.js';

export interface CanonicalCoverLetterContext {
  resumeVersionId: number;
  resumeVersionName: string;
  profileRevisionId: number;
  jobSnapshotId: number;
  candidate: JsonObject;
  resumeContent: JsonObject;
  job: {
    title: string | null;
    company: string | null;
    location: string | null;
    description: string;
  };
  resumeClaims: Array<{ text: string; sourceClaimIds: string[] }>;
  requirements: Array<{ id: string; text: string }>;
}

export interface RegisterCoverLetterInput {
  context: CanonicalCoverLetterContext;
  userId: number;
  tone: string;
  letter: ProvenancedCoverLetter;
  assessments: CoverLetterEntailmentAssessment[];
  pdfPath: string;
  sha256: string;
  byteSize: number;
  promptVersion: string;
  model: string;
}

export class CoverLetterRepository {
  public constructor(private readonly db: Database.Database = getDb()) {}

  /** Resolve every generation input through the exact rendered resume version. */
  public loadCanonicalContext(jobId: number, userId: number): CanonicalCoverLetterContext {
    assertId(jobId, 'jobId');
    assertId(userId, 'userId');
    const row = this.db.prepare(`
      SELECT rv.id AS resume_version_id, rv.version_name, rv.profile_revision_id,
             rv.job_snapshot_id, rv.content_json, pr.candidate_json,
             js.title, js.company, js.location, js.description,
             (SELECT COUNT(*) FROM resume_claims rc WHERE rc.resume_version_id = rv.id) AS claim_count,
             (SELECT COUNT(*) FROM resume_claims rc
              WHERE rc.resume_version_id = rv.id AND rc.validation_status != 'valid') AS invalid_claims,
             (SELECT COUNT(*) FROM artifacts a
              WHERE a.resume_version_id = rv.id AND a.artifact_type = 'pdf'
                AND a.path = rv.pdf_path AND a.sha256 IS NOT NULL) AS pdf_artifacts
      FROM resume_versions rv
      JOIN resume_drafts rd ON rd.id = rv.draft_id AND rd.status = 'rendered'
      JOIN profile_revisions pr ON pr.id = rv.profile_revision_id
      JOIN profiles p ON p.id = pr.profile_id AND p.user_id = rv.user_id
      JOIN job_snapshots js ON js.id = rv.job_snapshot_id
        AND js.job_id = rv.job_id AND js.user_id = rv.user_id
      JOIN jobs j ON j.id = rv.job_id AND j.user_id = rv.user_id
      WHERE rv.job_id = ? AND rv.user_id = ? AND rv.content_json IS NOT NULL
        AND rv.pdf_path IS NOT NULL
      ORDER BY rv.id DESC LIMIT 1
    `).get(jobId, userId) as Record<string, unknown> | undefined;
    if (!row || number(row, 'claim_count') === 0 || number(row, 'invalid_claims') !== 0
      || number(row, 'pdf_artifacts') === 0) {
      throw new Error('No rendered, truth-validated canonical resume version is available for cover-letter generation.');
    }
    const resumeVersionId = number(row, 'resume_version_id');
    const claimRows = this.db.prepare(`
      SELECT rendered_text, source_claim_ids_json
      FROM resume_claims WHERE resume_version_id = ? AND validation_status = 'valid'
      ORDER BY section, ordinal
    `).all(resumeVersionId) as Array<Record<string, unknown>>;
    const requirementRows = this.db.prepare(`
      SELECT requirement_key, requirement_text FROM job_requirements
      WHERE snapshot_id = ? ORDER BY ordinal, id
    `).all(number(row, 'job_snapshot_id')) as Array<Record<string, unknown>>;
    return {
      resumeVersionId,
      resumeVersionName: string(row, 'version_name'),
      profileRevisionId: number(row, 'profile_revision_id'),
      jobSnapshotId: number(row, 'job_snapshot_id'),
      candidate: parseJsonObject(string(row, 'candidate_json'), 'candidate_json'),
      resumeContent: parseJsonObject(string(row, 'content_json'), 'content_json'),
      job: {
        title: nullableString(row, 'title'),
        company: nullableString(row, 'company'),
        location: nullableString(row, 'location'),
        description: string(row, 'description'),
      },
      resumeClaims: claimRows.map((claim) => ({
        text: string(claim, 'rendered_text'),
        sourceClaimIds: stringArray(string(claim, 'source_claim_ids_json')),
      })),
      requirements: requirementRows.map((requirement) => ({
        id: string(requirement, 'requirement_key'),
        text: string(requirement, 'requirement_text'),
      })),
    };
  }

  /** Atomically bind validated sentences and a hashed PDF artifact to their frozen inputs. */
  public registerValidated(input: RegisterCoverLetterInput): number {
    if (!input.pdfPath.trim() || !/^[a-f0-9]{64}$/.test(input.sha256)) {
      throw new Error('A cover-letter artifact needs a path and SHA-256');
    }
    if (!Number.isInteger(input.byteSize) || input.byteSize <= 0) {
      throw new Error('Cover-letter artifact byteSize must be a positive integer');
    }
    if (!existsSync(input.pdfPath)) throw new Error('Cover-letter artifact file does not exist');
    const artifactBytes = readFileSync(input.pdfPath);
    const actualSha256 = createHash('sha256').update(artifactBytes).digest('hex');
    if (actualSha256 !== input.sha256 || artifactBytes.byteLength !== input.byteSize) {
      throw new Error('Cover-letter artifact bytes do not match the supplied hash and size');
    }
    const assessmentBySentence = new Map(input.assessments.map((item) => [item.sentence, item]));
    const sentences = input.letter.paragraphs.flatMap((paragraph) => paragraph.sentences);
    if (assessmentBySentence.size !== sentences.length
      || sentences.some((sentence) => assessmentBySentence.get(sentence.text)?.verdict !== 'entailed')) {
      throw new Error('Only completely entailed cover letters may be registered');
    }
    return this.db.transaction(() => {
      const binding = this.db.prepare(`
        SELECT rv.id FROM resume_versions rv
        JOIN jobs j ON j.id = rv.job_id AND j.user_id = rv.user_id
        WHERE rv.id = ? AND rv.job_id = ? AND rv.user_id = ?
          AND rv.profile_revision_id = ? AND rv.job_snapshot_id = ?
      `).get(
        input.context.resumeVersionId,
        this.jobIdForContext(input.context),
        input.userId,
        input.context.profileRevisionId,
        input.context.jobSnapshotId,
      );
      if (!binding) throw new Error('Cover-letter inputs no longer match the canonical resume binding');
      const version = this.db.prepare(`
        INSERT INTO cover_letter_versions
          (job_id, user_id, resume_version_id, profile_revision_id, job_snapshot_id,
           tone, content_json, validation_status, prompt_version, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?)
      `).run(
        this.jobIdForContext(input.context), input.userId, input.context.resumeVersionId,
        input.context.profileRevisionId, input.context.jobSnapshotId, input.tone,
        stringifyJson(input.letter), input.promptVersion, input.model,
      );
      const coverLetterVersionId = Number(version.lastInsertRowid);
      const insertClaim = this.db.prepare(`
        INSERT INTO cover_letter_claims
          (cover_letter_version_id, paragraph_ordinal, sentence_ordinal, rendered_text,
           source_claim_ids_json, requirement_ids_json, validation_status, validation_notes)
        VALUES (?, ?, ?, ?, ?, ?, 'valid', ?)
      `);
      input.letter.paragraphs.forEach((paragraph, paragraphOrdinal) => {
        paragraph.sentences.forEach((sentence, sentenceOrdinal) => {
          const assessment = assessmentBySentence.get(sentence.text);
          if (!assessment) throw new Error(`Missing semantic assessment for ${JSON.stringify(sentence.text)}`);
          insertClaim.run(
            coverLetterVersionId, paragraphOrdinal, sentenceOrdinal, sentence.text,
            stringifyJson(sentence.source_claim_ids), stringifyJson(sentence.requirement_ids),
            `deterministic truth validation passed; semantic entailment: ${assessment.reason}`,
          );
        });
      });
      const artifact = this.db.prepare(`
        INSERT INTO artifacts
          (resume_version_id, artifact_type, path, sha256, byte_size)
        VALUES (?, 'cover-letter-pdf', ?, ?, ?)
      `).run(input.context.resumeVersionId, input.pdfPath, input.sha256, input.byteSize);
      this.db.prepare('UPDATE cover_letter_versions SET artifact_id = ? WHERE id = ?')
        .run(Number(artifact.lastInsertRowid), coverLetterVersionId);
      return coverLetterVersionId;
    })();
  }

  private jobIdForContext(context: CanonicalCoverLetterContext): number {
    const row = this.db.prepare('SELECT job_id FROM resume_versions WHERE id = ?')
      .get(context.resumeVersionId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Resume version ${context.resumeVersionId} does not exist`);
    return number(row, 'job_id');
  }
}

function string(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return string(row, key);
}

function number(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new Error(`${key} must be a number`);
  return value;
}

function stringArray(raw: string): string[] {
  const value = parseJsonValue(raw, 'source_claim_ids_json');
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    throw new Error('source_claim_ids_json must be a non-empty string array');
  }
  return value.map((item) => String(item));
}

function assertId(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}
