import Database from 'better-sqlite3';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth/auth-service.js';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { app } from '../src/ui/server.js';

let db: Database.Database;
vi.mock('../src/db/client.js', () => ({ getDb: () => db }));

describe('application notes', () => {
  let server: Server;
  let origin: string;
  let jobId: number;
  let ownerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    const insertUser = db.prepare('INSERT INTO users (name) VALUES (?)');
    const ownerId = Number(insertUser.run('owner').lastInsertRowid);
    const otherId = Number(insertUser.run('other').lastInsertRowid);
    const auth = new AuthService(db);
    ownerToken = auth.createSession(ownerId).token;
    otherToken = auth.createSession(otherId).token;
    jobId = Number(db.prepare('INSERT INTO jobs (url, user_id) VALUES (?, ?)')
      .run('https://example.test/job', ownerId).lastInsertRowid);
  });
  afterEach(() => db.close());

  async function post(route: 'apply' | 'response', body: Record<string, string>, token = ownerToken) {
    const response = await fetch(origin + '/api/jobs/' + jobId + '/' + route, {
      method: 'POST',
      headers: { origin, cookie: 'jobbot_session=' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.status;
  }

  function applications() {
    return db.prepare('SELECT status, notes FROM applications WHERE job_id = ?').all(jobId);
  }

  it('creates a submitted application with null notes when omitted', async () => {
    expect(await post('apply', {})).toBe(200);
    expect(applications()).toEqual([{ status: 'submitted', notes: null }]);
  });

  it('retains the original note on re-application', async () => {
    expect(await post('apply', { notes: 'Referral' })).toBe(200);
    expect(await post('apply', {})).toBe(200);
    expect(applications()).toEqual([{ status: 'submitted', notes: 'Referral' }]);
  });

  it('keeps a response note when changing only the status', async () => {
    expect(await post('response', { responseType: 'interview', notes: 'Call on Friday' })).toBe(200);
    expect(await post('apply', { status: 'withdrawn' })).toBe(200);
    expect(applications()).toEqual([{ status: 'withdrawn', notes: 'Call on Friday' }]);
  });

  it.each(['Updated note', ''])('accepts an explicit replacement %j', async notes => {
    expect(await post('apply', { notes: 'Original' })).toBe(200);
    expect(await post('apply', { notes })).toBe(200);
    expect(applications()).toEqual([{ status: 'submitted', notes }]);
  });

  it('rejects another user attempting to overwrite the application', async () => {
    expect(await post('apply', { notes: 'Private' })).toBe(200);
    expect(await post('apply', { status: 'withdrawn', notes: 'Overwrite' }, otherToken)).toBe(404);
    expect(applications()).toEqual([{ status: 'submitted', notes: 'Private' }]);
  });
});
