import { describe, it, expect } from 'vitest';
import { scoreJobDeterministic as scoreJob } from '../src/jobs/scorers/deterministic.js';
import type { Preferences } from '../src/jobs/score.js';

const DEFAULT_PREFS: Preferences = {
  preferred_titles: [
    'senior software engineer',
    'staff software engineer',
    'backend engineer',
    'platform engineer',
  ],
  preferred_locations: {
    remote: true,
    cities: ['san francisco', 'new york', 'seattle'],
  },
  preferred_companies: ['stripe', 'figma'],
  preferred_industries: ['developer tools', 'cloud infrastructure'],
  deal_breakers: {
    description: 'No crypto/web3',
    keywords: ['crypto', 'web3', 'nft', 'blockchain'],
  },
  weights: {
    title_match: 0.35,
    location_match: 0.25,
    company_match: 0.15,
    industry_match: 0.2,
    description_quality: 0.05,
  },
  tiers: { A: 0.8, B: 0.65, C: 0.5, D: 0.0 },
};

function makeJob(overrides: Partial<{
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
}> = {}) {
  return {
    id: 1,
    title: null,
    company: null,
    location: null,
    description: null,
    ...overrides,
  };
}

describe('scoreJob', () => {
  // ---- empty / placeholder jobs --------------------------------------------

  it('returns a neutral score for a fully empty placeholder job', () => {
    const result = scoreJob(makeJob(), DEFAULT_PREFS);
    expect(result.score).toBe(0);
    expect(result.tier).toBe('D');
    expect(result.reason).toContain('insufficient data');
  });

  // ---- title scoring -------------------------------------------------------

  it('gives a high score for an exact title match', () => {
    const result = scoreJob(
      makeJob({ title: 'Senior Software Engineer' }),
      DEFAULT_PREFS,
    );
    expect(result.score).toBeGreaterThan(0.2);
  });

  it('gives a partial score for partial title match', () => {
    const result = scoreJob(
      makeJob({ title: 'Senior Software Engineer - Backend' }),
      DEFAULT_PREFS,
    );
    expect(result.score).toBeGreaterThan(0.15);
  });

  it('gives zero for an unrelated title', () => {
    const result = scoreJob(
      makeJob({ title: 'Barista' }),
      DEFAULT_PREFS,
    );
    // Title doesn't match, and nothing else matches either
    expect(result.tier).toBe('D');
  });

  // ---- location scoring ----------------------------------------------------

  it('gives a high score for a fully remote position', () => {
    const result = scoreJob(
      makeJob({ location: 'Remote (US)' }),
      DEFAULT_PREFS,
    );
    // remote = 1.0 * 0.25 = 0.25
    expect(result.score).toBeGreaterThanOrEqual(0.2);
    expect(result.reason).toContain('location');
  });

  it('gives a score for a preferred city', () => {
    const result = scoreJob(
      makeJob({ location: 'San Francisco, CA' }),
      DEFAULT_PREFS,
    );
    expect(result.score).toBeGreaterThanOrEqual(0.2);
    expect(result.reason).toContain('location');
  });

  it('gives zero location score for non-preferred city when not remote', () => {
    const prefs: Preferences = {
      ...DEFAULT_PREFS,
      preferred_locations: { remote: false, cities: ['san francisco'] },
    };
    const result = scoreJob(makeJob({ location: 'Omaha, NE' }), prefs);
    expect(result.score).toBe(0);
  });

  // ---- company scoring -----------------------------------------------------

  it('gives a boost for a preferred company', () => {
    const result = scoreJob(
      makeJob({ company: 'Stripe' }),
      DEFAULT_PREFS,
    );
    expect(result.score).toBeGreaterThan(0.1);
    expect(result.reason).toContain('company');
  });

  it('gives no company boost for an unknown company', () => {
    const result = scoreJob(
      makeJob({ company: 'RandomCorp' }),
      DEFAULT_PREFS,
    );
    expect(result.reason).not.toContain('company');
  });

  // ---- industry scoring ----------------------------------------------------

  it('detects preferred industry in description', () => {
    const result = scoreJob(
      makeJob({
        description: 'We build developer tools for cloud infrastructure teams...',
      }),
      DEFAULT_PREFS,
    );
    expect(result.reason).toContain('industry');
  });

  // ---- deal-breakers -------------------------------------------------------

  it('returns tier D and score 0 when a deal-breaker keyword is found', () => {
    const result = scoreJob(
      makeJob({
        title: 'Senior Engineer',
        description: 'Join our web3 crypto startup...',
      }),
      DEFAULT_PREFS,
    );
    expect(result.score).toBe(0);
    expect(result.tier).toBe('D');
    expect(result.reason).toContain('Deal-breaker');
  });

  it('detects deal-breaker in company name', () => {
    const result = scoreJob(
      makeJob({ company: 'Blockchain Innovations LLC' }),
      DEFAULT_PREFS,
    );
    expect(result.score).toBe(0);
    expect(result.tier).toBe('D');
  });

  // ---- tier assignment -----------------------------------------------------

  it('assigns tier A for a very strong match', () => {
    const result = scoreJob(
      makeJob({
        title: 'Senior Software Engineer',
        company: 'Figma',
        location: 'San Francisco, CA',
        description: 'Join our developer tools platform team building cloud infrastructure...',
      }),
      DEFAULT_PREFS,
    );
    expect(result.tier).toBe('A');
    expect(result.score).toBeGreaterThanOrEqual(0.8);
  });

  it('assigns tier C for a moderately matching placeholder', () => {
    const result = scoreJob(
      makeJob({ title: 'Junior Frontend Developer' }),
      DEFAULT_PREFS,
    );
    // "junior" and "frontend" don't match senior/backend/platform
    expect(['C', 'D']).toContain(result.tier);
  });

  // ---- returned shape -------------------------------------------------------

  it('returns all required fields', () => {
    const result = scoreJob(makeJob({ title: 'Staff Software Engineer' }), DEFAULT_PREFS);
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('tier');
    expect(result).toHaveProperty('reason');
    expect(typeof result.score).toBe('number');
    expect(typeof result.tier).toBe('string');
    expect(typeof result.reason).toBe('string');
  });

  // ---- custom tiers --------------------------------------------------------

  it('respects custom tier thresholds', () => {
    const prefs: Preferences = {
      ...DEFAULT_PREFS,
      tiers: { S: 0.9, A: 0.7, B: 0.4, C: 0.0 },
    };
    const result = scoreJob(
      makeJob({ title: 'Senior Software Engineer' }),
      prefs,
    );
    expect(['A', 'B', 'C']).toContain(result.tier);
  });
});
