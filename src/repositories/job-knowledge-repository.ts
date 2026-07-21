import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/client.js';
import { parseJsonObject, parseJsonValue, stringifyJson, type JsonObject } from '../domain/shared/json.js';
import { optionalNumber, optionalString, requiredNumber, requiredString } from '../domain/shared/rows.js';

export interface JobSnapshotInput {
  jobId: number;
  userId?: number | null;
  sourceUrl: string;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  description: string;
  applyUrl?: string | null;
  extracted?: JsonObject;
}

export interface JobSnapshot extends JobSnapshotInput {
  id: number;
  userId: number;
  contentHash: string;
  extracted: JsonObject;
  requirementsFrozenAt: string | null;
  createdAt: string;
}

export type RequirementImportance = 'required' | 'preferred' | 'context';
export interface JobRequirementInput {
  key?: string;
  category: string;
  text: string;
  importance: RequirementImportance;
  keywords?: string[];
  ordinal?: number;
  sourceSpans: string[];
}

export interface JobRequirement extends JobRequirementInput {
  id: number;
  snapshotId: number;
  key: string;
  keywords: string[];
  ordinal: number;
}

export class JobKnowledgeRepository {
  public constructor(private readonly db: Database.Database = getDb()) {}

  /** Capture immutable posting content. Identical content is de-duplicated. */
  public captureSnapshot(input: JobSnapshotInput): JobSnapshot {
    assertId(input.jobId, 'jobId');
    if (!input.sourceUrl.trim()) throw new Error('sourceUrl is required');
    if (!input.description.trim()) throw new Error('description is required');
    const owner = this.db.prepare('SELECT user_id FROM jobs WHERE id = ?').get(input.jobId) as
      | Record<string, unknown>
      | undefined;
    if (!owner) throw new Error(`Job ${input.jobId} does not exist`);
    const ownerId = optionalNumber(owner, 'user_id');
    if (ownerId === null) throw new Error(`Job ${input.jobId} has no owner`);
    if (input.userId !== undefined && input.userId !== null && input.userId !== ownerId) {
      throw new Error(`Job ${input.jobId} does not belong to user ${input.userId}`);
    }
    const extractedJson = stringifyJson(input.extracted ?? {});
    const hash = createHash('sha256').update(JSON.stringify({
      sourceUrl: input.sourceUrl,
      title: input.title ?? null,
      company: input.company ?? null,
      location: input.location ?? null,
      description: input.description,
      applyUrl: input.applyUrl ?? null,
      extracted: JSON.parse(extractedJson) as unknown,
    })).digest('hex');
    this.db.prepare(`
      INSERT OR IGNORE INTO job_snapshots
        (job_id, user_id, source_url, title, company, location, description, apply_url, content_hash, extracted_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.jobId, ownerId, input.sourceUrl, input.title ?? null, input.company ?? null,
      input.location ?? null, input.description, input.applyUrl ?? null, hash, extractedJson,
    );
    const row = this.db.prepare(
      'SELECT * FROM job_snapshots WHERE job_id = ? AND content_hash = ?',
    ).get(input.jobId, hash) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Job snapshot could not be persisted');
    return mapSnapshot(row);
  }

  public getLatestSnapshot(jobId: number): JobSnapshot | null {
    assertId(jobId, 'jobId');
    const row = this.db.prepare(`
      SELECT * FROM job_snapshots WHERE job_id = ? ORDER BY id DESC LIMIT 1
    `).get(jobId) as Record<string, unknown> | undefined;
    return row ? mapSnapshot(row) : null;
  }

  /**
   * Initialize immutable requirements for a snapshot. Once frozen, retries
   * return the original requirements instead of changing generation evidence.
   */
  public initializeRequirements(snapshotId: number, requirements: JobRequirementInput[]): JobRequirement[] {
    assertId(snapshotId, 'snapshotId');
    this.db.transaction(() => {
      const snapshot = this.db.prepare(
        'SELECT requirements_frozen_at FROM job_snapshots WHERE id = ?',
      ).get(snapshotId) as Record<string, unknown> | undefined;
      if (!snapshot) throw new Error(`Job snapshot ${snapshotId} does not exist`);
      if (optionalString(snapshot, 'requirements_frozen_at') !== null) return;
      const insert = this.db.prepare(`
        INSERT INTO job_requirements
          (snapshot_id, requirement_key, category, requirement_text, importance, keywords_json, ordinal,
           source_spans_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      requirements.forEach((requirement, index) => {
        if (!requirement.category.trim() || !requirement.text.trim()) {
          throw new Error('Requirements need category and text');
        }
        if (requirement.sourceSpans.length === 0
            || !requirement.sourceSpans.every((span) => span.trim().length > 0)) {
          throw new Error('Requirements need at least one independently verified JD source span');
        }
        insert.run(
          snapshotId,
          requirement.key?.trim() || stableRequirementKey(requirement.category, requirement.text),
          requirement.category,
          requirement.text,
          requirement.importance,
          stringifyJson(requirement.keywords ?? []),
          requirement.ordinal ?? index,
          stringifyJson(requirement.sourceSpans),
        );
      });
      this.db.prepare(`
        UPDATE job_snapshots SET requirements_frozen_at = datetime('now') WHERE id = ?
      `).run(snapshotId);
    })();
    return this.listRequirements(snapshotId);
  }

  /** @deprecated Requirements are immutable; this now initializes once. */
  public replaceRequirements(snapshotId: number, requirements: JobRequirementInput[]): JobRequirement[] {
    return this.initializeRequirements(snapshotId, requirements);
  }

  public listRequirements(snapshotId: number): JobRequirement[] {
    assertId(snapshotId, 'snapshotId');
    const rows = this.db.prepare(`
      SELECT * FROM job_requirements WHERE snapshot_id = ? ORDER BY ordinal, id
    `).all(snapshotId) as Array<Record<string, unknown>>;
    return rows.map(mapRequirement);
  }
}

function mapSnapshot(row: Record<string, unknown>): JobSnapshot {
  return {
    id: requiredNumber(row, 'id'),
    jobId: requiredNumber(row, 'job_id'),
    userId: requiredNumber(row, 'user_id'),
    sourceUrl: requiredString(row, 'source_url'),
    title: optionalString(row, 'title'),
    company: optionalString(row, 'company'),
    location: optionalString(row, 'location'),
    description: requiredString(row, 'description'),
    applyUrl: optionalString(row, 'apply_url'),
    contentHash: requiredString(row, 'content_hash'),
    extracted: parseJsonObject(requiredString(row, 'extracted_json'), 'extracted_json'),
    requirementsFrozenAt: optionalString(row, 'requirements_frozen_at'),
    createdAt: requiredString(row, 'created_at'),
  };
}

function mapRequirement(row: Record<string, unknown>): JobRequirement {
  const importance = requiredString(row, 'importance');
  if (!isImportance(importance)) throw new Error(`Unknown requirement importance: ${importance}`);
  const keywordsJson = parseJsonValue(requiredString(row, 'keywords_json'), 'keywords_json');
  if (!Array.isArray(keywordsJson) || !keywordsJson.every((value) => typeof value === 'string')) {
    throw new Error('keywords_json must be a string array');
  }
  const sourceSpansJson = parseJsonValue(requiredString(row, 'source_spans_json'), 'source_spans_json');
  if (!Array.isArray(sourceSpansJson) || !sourceSpansJson.every((value) => typeof value === 'string')) {
    throw new Error('source_spans_json must be a string array');
  }
  return {
    id: requiredNumber(row, 'id'),
    snapshotId: requiredNumber(row, 'snapshot_id'),
    key: requiredString(row, 'requirement_key'),
    category: requiredString(row, 'category'),
    text: requiredString(row, 'requirement_text'),
    importance,
    keywords: keywordsJson,
    ordinal: requiredNumber(row, 'ordinal'),
    sourceSpans: sourceSpansJson,
  };
}

function stableRequirementKey(category: string, text: string): string {
  const normalizedCategory = category.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    || 'requirement';
  const digest = createHash('sha256')
    .update(`${category.trim().toLowerCase()}\0${text.trim().replace(/\s+/g, ' ').toLowerCase()}`)
    .digest('hex')
    .slice(0, 20);
  return `${normalizedCategory}:${digest}`;
}

function isImportance(value: string): value is RequirementImportance {
  return value === 'required' || value === 'preferred' || value === 'context';
}

function assertId(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}
