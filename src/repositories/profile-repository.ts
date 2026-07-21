import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/client.js';
import { parseJsonObject, parseJsonValue, stringifyJson } from '../domain/shared/json.js';
import { optionalNumber, optionalString, requiredNumber, requiredString } from '../domain/shared/rows.js';
import type {
  CreateProfileRevisionInput,
  Profile,
  ProfileClaim,
  ProfileRevision,
} from '../domain/profile/types.js';

export class ProfileRepository {
  public constructor(private readonly db: Database.Database = getDb()) {}

  public getByUserId(userId: number): Profile | null {
    assertPositiveInteger(userId, 'userId');
    const row = this.db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapProfile(row) : null;
  }

  public getById(profileId: number): Profile | null {
    assertPositiveInteger(profileId, 'profileId');
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapProfile(row) : null;
  }

  /** Resolve users.id to the separate profiles.id namespace. */
  public ensureForUser(userId: number, name = 'Primary'): Profile {
    assertPositiveInteger(userId, 'userId');
    this.db.prepare('INSERT OR IGNORE INTO profiles (user_id, name) VALUES (?, ?)')
      .run(userId, name.trim() || 'Primary');
    const profile = this.getByUserId(userId);
    if (!profile) throw new Error(`Profile for user ${userId} could not be created`);
    return profile;
  }

  public getActiveRevision(userId: number): ProfileRevision | null {
    assertPositiveInteger(userId, 'userId');
    const row = this.db.prepare(`
      SELECT pr.*
      FROM profiles p
      JOIN profile_revisions pr ON pr.id = p.active_revision_id
      WHERE p.user_id = ?
    `).get(userId) as Record<string, unknown> | undefined;
    return row ? mapRevision(row) : null;
  }

  public getRevision(revisionId: number): ProfileRevision | null {
    assertPositiveInteger(revisionId, 'revisionId');
    const row = this.db.prepare('SELECT * FROM profile_revisions WHERE id = ?').get(revisionId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRevision(row) : null;
  }

  public listClaims(revisionId: number): ProfileClaim[] {
    assertPositiveInteger(revisionId, 'revisionId');
    const rows = this.db.prepare(`
      SELECT * FROM profile_claims WHERE revision_id = ? ORDER BY category, claim_key
    `).all(revisionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: requiredNumber(row, 'id'),
      revisionId: requiredNumber(row, 'revision_id'),
      category: requiredString(row, 'category'),
      key: requiredString(row, 'claim_key'),
      value: parseJsonValue(requiredString(row, 'value_json'), 'value_json'),
      sourcePath: optionalString(row, 'source_path'),
      sensitive: requiredNumber(row, 'sensitive') === 1,
      userConfirmed: requiredNumber(row, 'user_confirmed') === 1,
    }));
  }

  /** Create an immutable revision and atomically make it active. */
  public createRevision(input: CreateProfileRevisionInput): ProfileRevision {
    assertPositiveInteger(input.userId, 'userId');
    const candidateJson = stringifyJson(input.candidate);
    const preferencesJson = stringifyJson(input.preferences);
    const claimsJson = stringifyJson((input.claims ?? []).map((claim) => ({
      category: claim.category,
      key: claim.key,
      value: claim.value,
      sourcePath: claim.sourcePath ?? null,
      sensitive: claim.sensitive ?? false,
      userConfirmed: claim.userConfirmed ?? true,
    })));
    const digest = createHash('sha256')
      .update(String(input.schemaVersion ?? 1)).update('\0')
      .update(candidateJson).update('\0').update(preferencesJson)
      .update('\0').update(claimsJson)
      .digest('hex');

    const revisionId = this.db.transaction(() => {
      const profileId = this.ensureForUser(input.userId, input.name).id;

      const existing = this.db.prepare(
        'SELECT id FROM profile_revisions WHERE profile_id = ? AND source_digest = ?',
      ).get(profileId, digest) as Record<string, unknown> | undefined;
      let id: number;
      if (existing) {
        id = requiredNumber(existing, 'id');
      } else {
        const nextRow = this.db.prepare(
          'SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM profile_revisions WHERE profile_id = ?',
        ).get(profileId) as Record<string, unknown>;
        const result = this.db.prepare(`
          INSERT INTO profile_revisions
            (profile_id, revision, schema_version, candidate_json, preferences_json, source, source_digest)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          profileId,
          requiredNumber(nextRow, 'revision'),
          input.schemaVersion ?? 1,
          candidateJson,
          preferencesJson,
          input.source,
          digest,
        );
        id = Number(result.lastInsertRowid);
        const insertClaim = this.db.prepare(`
          INSERT INTO profile_claims
            (revision_id, category, claim_key, value_json, source_path, sensitive, user_confirmed)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const claim of input.claims ?? []) {
          if (!claim.category.trim() || !claim.key.trim()) throw new Error('Profile claims need category and key');
          insertClaim.run(
            id,
            claim.category,
            claim.key,
            stringifyJson(claim.value),
            claim.sourcePath ?? null,
            claim.sensitive ? 1 : 0,
            claim.userConfirmed === false ? 0 : 1,
          );
        }
      }
      this.db.prepare(`
        UPDATE profiles SET active_revision_id = ?, updated_at = datetime('now') WHERE id = ?
      `).run(id, profileId);
      return id;
    })();

    const revision = this.getRevision(revisionId);
    if (!revision) throw new Error(`Profile revision ${revisionId} disappeared after creation`);
    return revision;
  }
}

function mapProfile(row: Record<string, unknown>): Profile {
  return {
    id: requiredNumber(row, 'id'),
    userId: requiredNumber(row, 'user_id'),
    name: requiredString(row, 'name'),
    activeRevisionId: optionalNumber(row, 'active_revision_id'),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
  };
}

function mapRevision(row: Record<string, unknown>): ProfileRevision {
  return {
    id: requiredNumber(row, 'id'),
    profileId: requiredNumber(row, 'profile_id'),
    revision: requiredNumber(row, 'revision'),
    schemaVersion: requiredNumber(row, 'schema_version'),
    candidate: parseJsonObject(requiredString(row, 'candidate_json'), 'candidate_json'),
    preferences: parseJsonObject(requiredString(row, 'preferences_json'), 'preferences_json'),
    source: requiredString(row, 'source'),
    sourceDigest: requiredString(row, 'source_digest'),
    createdAt: requiredString(row, 'created_at'),
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}
