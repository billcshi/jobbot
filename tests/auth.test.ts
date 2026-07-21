import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthError, AuthService, validateRegistrationInput } from '../src/auth/auth-service.js';
import { SCHEMA_SQL } from '../src/db/schema.js';

describe('local authentication', () => {
  let db: Database.Database;
  let auth: AuthService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    auth = new AuthService(db);
  });

  afterEach(() => db.close());

  it('registers normalized users without storing the plaintext password', async () => {
    const user = await auth.register('  Ada.Lovelace  ', 'correct horse battery staple');
    expect(user).toMatchObject({ username: 'ada.lovelace' });

    const credential = db.prepare(`
      SELECT password_salt, password_hash FROM user_credentials WHERE user_id = ?
    `).get(user.id) as { password_salt: string; password_hash: string };
    expect(credential.password_salt).not.toContain('correct horse');
    expect(credential.password_hash).not.toContain('correct horse');
    await expect(auth.authenticate('ADA.LOVELACE', 'correct horse battery staple'))
      .resolves.toEqual(user);
  });

  it('rejects duplicate usernames and invalid credentials', async () => {
    await auth.register('engineer', 'a sufficiently long password');
    await expect(auth.register('ENGINEER', 'another sufficiently long password'))
      .rejects.toMatchObject({ status: 409, code: 'username_taken' });
    await expect(auth.authenticate('engineer', 'wrong password'))
      .rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    await expect(auth.authenticate('missing', 'a sufficiently long password'))
      .rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
  });

  it('requires a CLI-issued one-time token to claim an existing passwordless user', async () => {
    const unclaimedDefaultId = Number(db.prepare("INSERT INTO users (name) VALUES ('default')")
      .run().lastInsertRowid);
    await expect(auth.register('default', 'public claim attempt'))
      .rejects.toMatchObject({ status: 409, code: 'username_taken' });
    expect(db.prepare('SELECT 1 FROM user_credentials WHERE user_id = ?').get(unclaimedDefaultId))
      .toBeUndefined();

    const existingUserId = Number(db.prepare("INSERT INTO users (name) VALUES ('CLI User')")
      .run().lastInsertRowid);
    const existingJobId = Number(db.prepare(`
      INSERT INTO jobs (url, user_id, title) VALUES ('https://example.test/existing', ?, 'Existing role')
    `).run(existingUserId).lastInsertRowid);

    await expect(auth.claimWithSetupToken('CLI User', 'claim existing account', 'not-a-real-token'))
      .rejects.toMatchObject({ status: 400, code: 'invalid_setup' });

    const setup = auth.createSetupToken('CLI User');
    await expect(auth.claimWithSetupToken('CLI User', 'claim existing account', setup.token))
      .resolves.toEqual({ id: existingUserId, username: 'CLI User' });
    await expect(auth.authenticate('CLI User', 'claim existing account'))
      .resolves.toEqual({ id: existingUserId, username: 'CLI User' });
    expect(db.prepare('SELECT user_id FROM jobs WHERE id = ?').get(existingJobId))
      .toEqual({ user_id: existingUserId });
    await expect(auth.claimWithSetupToken('CLI User', 'a replacement password', setup.token))
      .rejects.toMatchObject({ status: 400, code: 'invalid_setup' });
    expect(() => auth.createSetupToken('CLI User'))
      .toThrow('No active account without a password');
  });

  it('creates hashed, revocable sessions and rejects expired sessions', async () => {
    const user = await auth.register('session-user', 'a sufficiently long password');
    const session = auth.createSession(user.id);
    const stored = db.prepare('SELECT token_hash FROM auth_sessions WHERE user_id = ?')
      .get(user.id) as { token_hash: string };
    expect(stored.token_hash).not.toBe(session.token);
    expect(auth.resolveSession(session.token)).toEqual(user);
    auth.revokeSession(session.token);
    expect(auth.resolveSession(session.token)).toBeNull();

    const expiringAuth = new AuthService(db, -1);
    const expired = expiringAuth.createSession(user.id);
    expect(expiringAuth.resolveSession(expired.token)).toBeNull();
  });

  it('validates registration input without silently rewriting unsupported names', () => {
    expect(validateRegistrationInput('valid_user', '0123456789')).toEqual({
      username: 'valid_user',
      password: '0123456789',
    });
    expect(() => validateRegistrationInput('a b', '0123456789')).toThrow(AuthError);
    expect(() => validateRegistrationInput('valid-user', 'short')).toThrow('between 10 and 256');
  });
});
