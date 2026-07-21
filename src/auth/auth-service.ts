import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';

const SALT_BYTES = 16;
const HASH_BYTES = 64;
const SESSION_BYTES = 32;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SETUP_TOKEN_TTL_MS = 15 * 60 * 1000;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,31}$/;

export interface AuthenticatedUser {
  id: number;
  username: string;
}

export interface CreatedSession {
  token: string;
  expiresAt: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'invalid_input' | 'username_taken' | 'invalid_credentials' | 'invalid_setup',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function validateUsername(username: unknown): string {
  if (typeof username !== 'string') {
    throw new AuthError('Username and password are required.', 400, 'invalid_input');
  }
  const normalized = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new AuthError(
      'Username must be 3–32 characters and use only letters, numbers, ., _, or -.',
      400,
      'invalid_input',
    );
  }
  return normalized;
}

function validatePassword(password: unknown): string {
  if (typeof password !== 'string') {
    throw new AuthError('Username and password are required.', 400, 'invalid_input');
  }
  if (password.length < 10 || password.length > 256) {
    throw new AuthError('Password must be between 10 and 256 characters.', 400, 'invalid_input');
  }
  return password;
}

function validateExistingUsername(username: unknown): string {
  if (typeof username !== 'string') {
    throw new AuthError('An existing username is required.', 400, 'invalid_setup');
  }
  const trimmed = username.trim();
  if (trimmed.length < 1 || trimmed.length > 128 || trimmed.includes('\0')) {
    throw new AuthError('An existing username is required.', 400, 'invalid_setup');
  }
  return trimmed;
}

export function validateRegistrationInput(username: unknown, password: unknown): {
  username: string;
  password: string;
} {
  const normalized = validateUsername(username);
  return { username: normalized, password: validatePassword(password) };
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, HASH_BYTES, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  constructor(
    private readonly db: Database.Database,
    private readonly sessionTtlMs: number = DEFAULT_SESSION_TTL_MS,
  ) {}

  async register(usernameInput: unknown, passwordInput: unknown): Promise<AuthenticatedUser> {
    const { username, password } = validateRegistrationInput(usernameInput, passwordInput);
    const salt = randomBytes(SALT_BYTES);
    const passwordHash = await deriveKey(password, salt);
    const now = Date.now();

    try {
      return this.db.transaction(() => {
        const result = this.db.prepare('INSERT INTO users (name) VALUES (?)').run(username);
        const userId = Number(result.lastInsertRowid);
        this.db.prepare(`
          INSERT INTO user_credentials (user_id, password_salt, password_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(userId, salt.toString('base64'), passwordHash.toString('base64'), now, now);
        return { id: userId, username };
      })();
    } catch (error: unknown) {
      if (error instanceof AuthError) throw error;
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new AuthError('That username is already registered.', 409, 'username_taken');
      }
      throw error;
    }
  }

  /** CLI-only setup capability for an existing user without Web credentials. */
  createSetupToken(usernameInput: unknown): { username: string; token: string; expiresAt: number } {
    const username = validateExistingUsername(usernameInput);
    const user = this.db.prepare(`
      SELECT u.id
      FROM users u
      LEFT JOIN user_credentials c ON c.user_id = u.id
      WHERE u.name = ? AND u.active = 1 AND c.user_id IS NULL
    `).get(username) as { id: number } | undefined;
    if (!user) {
      throw new AuthError('No active account without a password was found.', 400, 'invalid_setup');
    }

    const token = randomBytes(SESSION_BYTES).toString('base64url');
    const now = Date.now();
    const expiresAt = now + SETUP_TOKEN_TTL_MS;
    this.db.prepare(`
      INSERT INTO auth_setup_tokens (user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `).run(user.id, hashToken(token), expiresAt, now);
    return { username, token, expiresAt };
  }

  async claimWithSetupToken(
    usernameInput: unknown,
    passwordInput: unknown,
    tokenInput: unknown,
  ): Promise<AuthenticatedUser> {
    const username = validateExistingUsername(usernameInput);
    const password = validatePassword(passwordInput);
    if (typeof tokenInput !== 'string' || tokenInput.length < 32 || tokenInput.length > 256) {
      throw new AuthError('The setup link is invalid or expired.', 400, 'invalid_setup');
    }
    const salt = randomBytes(SALT_BYTES);
    const passwordHash = await deriveKey(password, salt);
    const now = Date.now();

    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM auth_setup_tokens WHERE expires_at <= ?').run(now);
      const user = this.db.prepare(`
        SELECT u.id, u.name
        FROM users u
        JOIN auth_setup_tokens t ON t.user_id = u.id
        LEFT JOIN user_credentials c ON c.user_id = u.id
        WHERE u.name = ? AND u.active = 1 AND c.user_id IS NULL
          AND t.token_hash = ? AND t.expires_at > ?
      `).get(username, hashToken(tokenInput), now) as { id: number; name: string } | undefined;
      if (!user) {
        throw new AuthError('The setup link is invalid or expired.', 400, 'invalid_setup');
      }
      this.db.prepare(`
        INSERT INTO user_credentials (user_id, password_salt, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(user.id, salt.toString('base64'), passwordHash.toString('base64'), now, now);
      this.db.prepare('DELETE FROM auth_setup_tokens WHERE user_id = ?').run(user.id);
      return { id: user.id, username: user.name };
    })();
  }

  async authenticate(usernameInput: unknown, passwordInput: unknown): Promise<AuthenticatedUser> {
    if (typeof usernameInput !== 'string' || typeof passwordInput !== 'string'
      || usernameInput.length > 256 || passwordInput.length > 256) {
      throw new AuthError('Invalid username or password.', 401, 'invalid_credentials');
    }
    const suppliedUsername = usernameInput.trim();
    const normalizedUsername = normalizeUsername(usernameInput);
    const findCredential = this.db.prepare(`
      SELECT u.id, u.name, c.password_salt, c.password_hash
      FROM users u
      JOIN user_credentials c ON c.user_id = u.id
      WHERE u.name = ? AND u.active = 1
    `);
    const row = (findCredential.get(suppliedUsername)
      ?? (normalizedUsername === suppliedUsername ? undefined : findCredential.get(normalizedUsername))) as {
      id: number;
      name: string;
      password_salt: string;
      password_hash: string;
    } | undefined;

    // Derive a key even for an unknown user so misses are not a cheap username oracle.
    const salt = row ? Buffer.from(row.password_salt, 'base64') : Buffer.alloc(SALT_BYTES);
    const actual = await deriveKey(passwordInput, salt);
    const expected = row ? Buffer.from(row.password_hash, 'base64') : Buffer.alloc(HASH_BYTES);
    if (!row || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AuthError('Invalid username or password.', 401, 'invalid_credentials');
    }
    return { id: row.id, username: row.name };
  }

  createSession(userId: number): CreatedSession {
    const token = randomBytes(SESSION_BYTES).toString('base64url');
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs;
    this.db.prepare(`
      INSERT INTO auth_sessions (user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, hashToken(token), expiresAt, now);
    return { token, expiresAt };
  }

  resolveSession(token: string | undefined): AuthenticatedUser | null {
    if (!token || token.length > 256) return null;
    const now = Date.now();
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
    const row = this.db.prepare(`
      SELECT u.id, u.name
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
    `).get(hashToken(token), now) as { id: number; name: string } | undefined;
    return row ? { id: row.id, username: row.name } : null;
  }

  revokeSession(token: string | undefined): void {
    if (!token || token.length > 256) return;
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
  }
}
