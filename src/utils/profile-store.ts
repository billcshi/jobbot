/**
 * Profile store — reads and writes user profile data (candidate,
 * preferences, answers) from the SQLite database.
 *
 * Each user has one row in `user_preferences`. The YAML content is
 * stored as TEXT columns. The web UI profile editor reads/writes
 * directly to the database.
 */

import { getDb } from '../db/client.js';

// ----- DB helpers ------------------------------------------------------------

function ensureRow(userId: number): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO user_preferences (user_id, candidate, preferences, answers)
     VALUES (?, '', '', '')`,
  ).run(userId);
}

function readColumn(userId: number, column: string): string {
  const db = getDb();
  ensureRow(userId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = db.prepare(
    `SELECT ${column} FROM user_preferences WHERE user_id = ?`,
  ).get(userId) as Record<string, string> | undefined;

  return row?.[column] ?? '';
}

// ----- public API ------------------------------------------------------------

/** Read the candidate profile YAML for a user. */
export function readCandidate(userId: number): string {
  return readColumn(userId, 'candidate');
}

/** Read the preferences YAML for a user. */
export function readPreferences(userId: number): string {
  return readColumn(userId, 'preferences');
}

/** Read the answers YAML for a user. */
export function readAnswers(userId: number): string {
  return readColumn(userId, 'answers');
}

/** Write a profile section for a user. */
export function writeProfile(
  userId: number,
  type: 'candidate' | 'preferences' | 'answers',
  yaml: string,
): void {
  const db = getDb();
  ensureRow(userId);
  db.prepare(
    `UPDATE user_preferences SET ${type} = ?, updated_at = datetime('now') WHERE user_id = ?`,
  ).run(yaml, userId);
}
