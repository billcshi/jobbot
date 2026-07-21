/**
 * Profile store — reads and writes candidate data and job preferences from
 * the SQLite database.
 *
 * The canonical form is an immutable JSON profile revision. YAML is accepted
 * and returned only as the Web editor interchange format; it is not stored.
 */

import { getDb } from '../db/client.js';
import yaml from 'js-yaml';
import { ProfileRepository } from '../repositories/profile-repository.js';
import { toJsonObject, type JsonObject } from '../domain/shared/json.js';

type ProfileSection = 'candidate' | 'preferences';

// ----- public API ------------------------------------------------------------

/** Read the candidate profile YAML for a user. */
export function readCandidate(userId: number): string {
  return readCanonicalSection(userId, 'candidate');
}

/** Read the preferences YAML for a user. */
export function readPreferences(userId: number): string {
  return readCanonicalSection(userId, 'preferences');
}

/** Write a profile section for a user. */
export function writeProfile(
  userId: number,
  type: ProfileSection,
  yamlContent: string,
): void {
  const db = getDb();
  const repository = new ProfileRepository(db);
  const active = repository.getActiveRevision(userId);
  const sections = active ? {
    candidate: active.candidate,
    preferences: active.preferences,
  } : {
    candidate: {},
    preferences: {},
  };
  sections[type] = parseProfileYaml(yamlContent, type);

  repository.createRevision({
    userId,
    candidate: sections.candidate,
    preferences: sections.preferences,
    source: 'editor',
  });
}

function readCanonicalSection(userId: number, section: ProfileSection): string {
  const revision = new ProfileRepository(getDb()).getActiveRevision(userId);
  if (!revision) return '';
  return dumpProfileYaml(revision[section]);
}

function parseProfileYaml(content: string, section: ProfileSection): JsonObject {
  if (content.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = yaml.load(content) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Invalid ${section} YAML${detail}`);
  }
  // js-yaml may produce Date values for timestamps. Convert those through its
  // JSON representation, then enforce an object root and JSON-safe values.
  const jsonCompatible = JSON.parse(JSON.stringify(parsed)) as unknown;
  return toJsonObject(jsonCompatible, section);
}

function dumpProfileYaml(section: JsonObject): string {
  if (Object.keys(section).length === 0) return '';
  return yaml.dump(section, { noRefs: true, lineWidth: -1, sortKeys: false });
}
