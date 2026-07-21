import {
  getActiveUserId,
  resolveUserId,
  resolveUserName,
} from './user-context.js';
import { getDb } from '../db/client.js';

/**
 * Explicit identity carried by application services.
 *
 * `userId` owns jobs and scores. `profileId` identifies the versioned
 * candidate profile. They are intentionally separate because
 * profiles.id is not guaranteed to equal users.id.
 */
export interface AppContext {
  readonly userId: number;
  readonly profileId: number;
  readonly profileName: string;
}

function profileIdForUser(userId: number): number {
  const db = getDb();
  let row = db.prepare('SELECT id FROM profiles WHERE user_id = ?').get(userId) as
    | { id: number }
    | undefined;
  if (row) return row.id;
  db.prepare('INSERT INTO profiles (user_id, name) VALUES (?, ?)')
    .run(userId, resolveUserName(userId));
  row = db.prepare('SELECT id FROM profiles WHERE user_id = ?').get(userId) as { id: number };
  return row.id;
}

/** Create a context for a resolved user id. */
export function appContextForUser(userId: number): AppContext {
  return {
    userId,
    profileId: profileIdForUser(userId),
    profileName: resolveUserName(userId),
  };
}

/** Resolve a context without changing the process-global legacy user. */
export function createAppContext(nameOrId: string | number): AppContext {
  return appContextForUser(resolveUserId(nameOrId));
}

/** Create a context for an already-resolved profile id. */
export function appContextForProfile(profileId: number): AppContext {
  const row = getDb().prepare('SELECT user_id FROM profiles WHERE id = ?').get(profileId) as
    | { user_id: number }
    | undefined;
  if (!row) {
    throw new Error(`Profile ${profileId} not found`);
  }
  return {
    userId: row.user_id,
    profileId,
    profileName: resolveUserName(row.user_id),
  };
}

/**
 * Compatibility adapter for CLI callers that still select a global user.
 * Core application services must receive AppContext explicitly and must not
 * call this function themselves.
 */
export function legacyAppContext(): AppContext {
  return appContextForUser(getActiveUserId());
}
