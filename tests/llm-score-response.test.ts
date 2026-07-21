import { describe, expect, it } from 'vitest';
import { parseScoreResponse } from '../src/jobs/scorers/llm.js';

describe('LLM score response validation', () => {
  it.each([
    ['missing fields', {}],
    ['string score', { score: '0.8', tier: 'A', reason: 'Strong match' }],
    ['non-finite score', { score: Number.NaN, tier: 'D', reason: 'Invalid number' }],
    ['score below range', { score: -0.1, tier: 'D', reason: 'Below range' }],
    ['score above range', { score: 1.1, tier: 'A', reason: 'Above range' }],
    ['unknown tier', { score: 0.8, tier: 'S', reason: 'Unknown tier' }],
    ['empty reason', { score: 0.8, tier: 'A', reason: '   ' }],
    ['inconsistent tier', { score: 0.79, tier: 'A', reason: 'Wrong threshold' }],
    ['unknown field', { score: 0.8, tier: 'A', reason: 'Match', confidence: 1 }],
  ])('rejects %s', (_label, response) => {
    expect(() => parseScoreResponse(response)).toThrow('Invalid score response');
  });

  it.each([
    [0.8, 'A'],
    [0.65, 'B'],
    [0.5, 'C'],
    [0.49, 'D'],
  ])('accepts score %s as tier %s', (score, tier) => {
    expect(parseScoreResponse({ score, tier, reason: '  Valid match  ' })).toEqual({
      score,
      tier,
      reason: 'Valid match',
    });
  });
});
