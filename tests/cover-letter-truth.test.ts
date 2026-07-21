import { describe, expect, it } from 'vitest';
import { parseCoverLetterAssessments } from '../src/cover-letter/entailment.js';
import { parseProvenancedCoverLetter } from '../src/domain/cover-letter/contract.js';
import { validateCoverLetterTruth } from '../src/domain/cover-letter/truth.js';

function letter(text: string, sourceIds = ['experience:0:highlight:0']) {
  return parseProvenancedCoverLetter({
    contract_version: 1,
    greeting: 'Dear Hiring Manager,',
    paragraphs: [{ sentences: [{
      text,
      source_claim_ids: sourceIds,
      requirement_ids: ['skill:backend'],
    }] }],
    closing: 'Sincerely,',
  });
}

const context = {
  candidateSources: [
    { id: 'experience:0:highlight:0', text: 'Reduced API latency by 35% using query optimization.' },
    { id: 'experience:1:highlight:0', text: 'Served as an engineering manager.' },
  ],
  allowedSourceClaimIds: new Set(['experience:0:highlight:0']),
  requirements: [{ id: 'skill:backend', text: 'Build reliable backend services.' }],
};

describe('cover-letter truth contract', () => {
  it('accepts sentence-level provenance and a metric present in linked evidence', () => {
    const result = validateCoverLetterTruth(
      letter('I reduced API latency by 35% while building backend services.'),
      context,
    );
    expect(result).toEqual({ valid: true, issues: [] });
  });

  it('fails closed on an unsupported metric', () => {
    const result = validateCoverLetterTruth(
      letter('I reduced API latency by 80% while building backend services.'),
      context,
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ message: 'unsupported metric "80%"' }));
  });

  it('rejects evidence that exists in the profile but is not bound to this resume version', () => {
    const result = validateCoverLetterTruth(
      letter('I served as an engineering manager.', ['experience:1:highlight:0']),
      context,
    );
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toContain('not evidence bound to the canonical resume version');
  });

  it('rejects uncited sentences at runtime', () => {
    expect(() => parseProvenancedCoverLetter({
      contract_version: 1,
      greeting: 'Dear Hiring Manager,',
      paragraphs: [{ sentences: [{ text: 'I led the team.', source_claim_ids: [], requirement_ids: [] }] }],
      closing: 'Sincerely,',
    })).toThrow('must cite candidate evidence or a job requirement');
  });

  it('rejects model-controlled greeting and closing text outside the safe contract', () => {
    expect(() => parseProvenancedCoverLetter({
      contract_version: 1,
      greeting: 'Dear Ada Lovelace,',
      paragraphs: [{ sentences: [{
        text: 'I build reliable backend services.',
        source_claim_ids: ['experience:0:highlight:0'],
        requirement_ids: ['skill:backend'],
      }] }],
      closing: 'Sincerely,',
    })).toThrow('$.greeting: expected "Dear Hiring Manager,"');

    expect(() => parseProvenancedCoverLetter({
      contract_version: 1,
      greeting: 'Dear Hiring Manager,',
      paragraphs: [{ sentences: [{
        text: 'I build reliable backend services.',
        source_claim_ids: ['experience:0:highlight:0'],
        requirement_ids: ['skill:backend'],
      }] }],
      closing: 'Sincerely, Senior Platform Engineer',
    })).toThrow('$.closing: expected "Sincerely,"');
  });

  it('requires an exact fail-closed semantic assessment for every sentence', () => {
    expect(() => parseCoverLetterAssessments({ assessments: [{
      sentence: 'Changed sentence', verdict: 'entailed', reason: 'supported',
    }] }, ['Original sentence'])).toThrow('exact sentence once');
    expect(parseCoverLetterAssessments({ assessments: [{
      sentence: 'Original sentence', verdict: 'unsupported', reason: 'new scope',
    }] }, ['Original sentence'])[0]?.verdict).toBe('unsupported');
  });
});
