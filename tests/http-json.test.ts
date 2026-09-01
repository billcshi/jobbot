import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AI_REQUEST_TIMEOUT_MS, requestAiJson, requestJsonWithTimeout } from '../src/utils/http-json.js';

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

  it('applies one hard deadline to AI requests', async () => {
    const aborted = AbortSignal.abort(new Error('deadline'));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(aborted);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      throw init?.signal?.reason ?? new Error('aborted');
    }) as typeof fetch;

    await expect(requestAiJson('https://provider.test', {}, {
      label: 'Provider stage', fetchImpl,
    })).rejects.toThrow(`Provider stage timed out after ${AI_REQUEST_TIMEOUT_MS}ms`);
    expect(timeoutSpy).toHaveBeenCalledWith(AI_REQUEST_TIMEOUT_MS);
  });

  it('routes every external model stage through the shared transport and logger', () => {
    const modelStages = [
      'src/jobs/extractors/llm.ts', 'src/jobs/scorers/llm.ts',
      'src/jobs/requirements.ts', 'src/jobs/tailor.ts', 'src/jobs/audit.ts',
      'src/jobs/cover-letter.ts', 'src/resume/entailment.ts',
      'src/cover-letter/entailment.ts', 'src/ui/server.ts',
    ];
    for (const path of modelStages) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      expect(source, path).toContain('requestAiJson');
      expect(source, path).toContain('logAiCall');
      expect(source, path).not.toMatch(/await\s+fetch\s*\(/);
    }

    const logger = readFileSync(new URL('../src/utils/ai-logger.ts', import.meta.url), 'utf8');
    expect(logger).toContain('timeoutMs: entry.timeoutMs ?? AI_REQUEST_TIMEOUT_MS');
  });
});
