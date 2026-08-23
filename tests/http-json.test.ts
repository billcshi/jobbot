import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestJsonWithTimeout } from '../src/utils/http-json.js';

afterEach(() => vi.unstubAllGlobals());

describe('JSON request timeout', () => {
  it('reports a hard timeout separately from caller cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })));

    await expect(requestJsonWithTimeout('https://example.test', {}, {
      timeoutMs: 5,
      label: 'Test request',
    })).rejects.toThrow('Test request timed out after 5ms');
  });
});
