/**
 * User context — determines which user is "active" for scoring,
 * tailoring, and application tracking.
 *
 * Web UI uses a cookie. CLI uses --user flag or the stored default.
 * Falls back to the 'default' user (id=1) created during migration.
 */

import { getDb } from '../db/client.js';
import { logger } from './logger.js';

let currentUserId: number | null = null;
let currentUserName: string | null = null;

/** Set the active user for the current process/session. */
export function setActiveUser(nameOrId: string | number): void {
  const db = getDb();
  let user: { id: number; name: string } | undefined;

  if (typeof nameOrId === 'number') {
    user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(nameOrId) as
      | { id: number; name: string }
      | undefined;
  } else {
    user = db.prepare('SELECT id, name FROM users WHERE name = ?').get(nameOrId) as
      | { id: number; name: string }
      | undefined;
  }

  if (!user) {
    logger.warn(`User "${nameOrId}" not found — falling back to default`);
    const def = getDefaultUser();
    currentUserId = def.id;
    currentUserName = def.name;
  } else {
    currentUserId = user.id;
    currentUserName = user.name;
  }
}

/** Get the active user ID. Falls back to the default user if none set. */
export function getActiveUserId(): number {
  if (currentUserId) return currentUserId;
  const def = getDefaultUser();
  currentUserId = def.id;
  currentUserName = def.name;
  return currentUserId;
}

/** Get the active user name. */
export function getActiveUserName(): string {
  if (currentUserName) return currentUserName;
  getActiveUserId(); // ensures both are set
  return currentUserName!;
}

/** Get the default user. Returns the first available user, creates 'default' if none exist. */
function getDefaultUser(): { id: number; name: string } {
  const db = getDb();
  // Try any existing user first
  const existing = db.prepare('SELECT id, name FROM users ORDER BY id LIMIT 1').get() as
    | { id: number; name: string }
    | undefined;
  if (existing) return existing;

  // Late creation — should normally be created during migration
  const result = db.prepare(
    "INSERT INTO users (name, active, created_at) VALUES ('default', 1, datetime('now'))",
  ).run();
  return { id: Number(result.lastInsertRowid), name: 'default' };
}

/** List all users. */
export function listUsers(): { id: number; name: string; active: boolean; created_at: string }[] {
  const db = getDb();
  return db.prepare('SELECT id, name, active, created_at FROM users ORDER BY id').all() as {
    id: number; name: string; active: boolean; created_at: string;
  }[];
}

/** Add a new user. Returns the created user or null if already exists. */
export function addUser(name: string): { id: number; name: string } | null {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE name = ?').get(name) as
    | { id: number }
    | undefined;
  if (existing) return null;

  const result = db.prepare(
    "INSERT INTO users (name, active, created_at) VALUES (?, 1, datetime('now'))",
  ).run(name);
  return { id: Number(result.lastInsertRowid), name };
}

/** Reset the active user (clears cached state). */
export function resetActiveUser(): void {
  currentUserId = null;
  currentUserName = null;
}

/**
 * Resolve a user ID by name WITHOUT setting the global active user.
 * Use this in web request handlers to avoid race conditions between
 * concurrent requests from different users.
 *
 * Returns the user's ID, or falls back to the default user.
 */
export function resolveUserId(nameOrId: string | number): number {
  const db = getDb();
  let user: { id: number } | undefined;

  if (typeof nameOrId === 'number') {
    user = db.prepare('SELECT id FROM users WHERE id = ?').get(nameOrId) as
      | { id: number }
      | undefined;
  } else {
    user = db.prepare('SELECT id FROM users WHERE name = ?').get(nameOrId) as
      | { id: number }
      | undefined;
  }

  if (user) return user.id;

  // Fall back to first available user
  const first = db.prepare('SELECT id, name FROM users ORDER BY id LIMIT 1').get() as
    | { id: number; name: string }
    | undefined;
  if (first) return first.id;

  // Late creation (shouldn't normally happen)
  const result = db.prepare(
    "INSERT INTO users (name, active, created_at) VALUES ('default', 1, datetime('now'))",
  ).run();
  return Number(result.lastInsertRowid);
}

/**
 * Resolve a user name by ID. Returns the name, or 'default' if not found.
 */
export function resolveUserName(userId: number): string {
  const db = getDb();
  const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as
    | { name: string }
    | undefined;
  return user?.name ?? 'default';
}
