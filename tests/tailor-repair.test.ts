import { describe, expect, it } from 'vitest';
import { parseTailorResponseForRepair } from '../src/jobs/tailor.js';

describe('tailor response repair boundary', () => {
  it('passes malformed JSON to the repair path as raw model output', () => {
    const malformed = '{"summary": "unterminated"';
    const attempt = parseTailorResponseForRepair(malformed, 'test tailor', value => value);

    expect(attempt).toEqual(expect.objectContaining({ ok: false, repairInput: malformed }));
  });

  it('passes parsed contract failures to repair as formatted JSON', () => {
    const attempt = parseTailorResponseForRepair('{"summary":"valid json"}', 'test tailor', () => {
      throw new Error('contract failed');
    });

    expect(attempt).toEqual(expect.objectContaining({
      ok: false,
      repairInput: '{\n  "summary": "valid json"\n}',
    }));
  });
});
