import { describe, it, expect } from 'vitest';
import { detectAts, type AtsType } from '../src/jobs/detect-ats';

describe('detectAts', () => {
  // ---- greenhouse ----------------------------------------------------------

  it('detects boards.greenhouse.io', () => {
    expect(detectAts('https://boards.greenhouse.io/example/jobs/12345')).toBe('greenhouse');
  });

  it('detects job-boards.greenhouse.io', () => {
    expect(detectAts('https://job-boards.greenhouse.io/example/jobs/67890')).toBe('greenhouse');
  });

  it('detects greenhouse with query params', () => {
    expect(
      detectAts('https://boards.greenhouse.io/example/jobs/123?utm_source=linkedin'),
    ).toBe('greenhouse');
  });

  // ---- lever ----------------------------------------------------------------

  it('detects jobs.lever.co', () => {
    expect(detectAts('https://jobs.lever.co/example/abc123')).toBe('lever');
  });

  it('detects lever with trailing slash and query', () => {
    expect(detectAts('https://jobs.lever.co/example/abc123/apply?ref=home')).toBe('lever');
  });

  // ---- ashby -----------------------------------------------------------------

  it('detects jobs.ashbyhq.com', () => {
    expect(detectAts('https://jobs.ashbyhq.com/example/abc-def-123')).toBe('ashby');
  });

  it('detects ashby with www subdomain-like path', () => {
    expect(detectAts('https://jobs.ashbyhq.com/acme/engineering/backend')).toBe('ashby');
  });

  // ---- workday ---------------------------------------------------------------

  it('detects myworkdayjobs.com subdomain', () => {
    expect(
      detectAts('https://acme.wd5.myworkdayjobs.com/en-US/Acme_Careers/job/SF/Engineer_123'),
    ).toBe('workday');
  });

  it('detects myworkdayjobs.com any subdomain depth', () => {
    expect(
      detectAts('https://a.b.myworkdayjobs.com/Careers/job/New-York/Staff-Eng'),
    ).toBe('workday');
  });

  // ---- linkedin --------------------------------------------------------------

  it('detects linkedin.com/jobs', () => {
    expect(detectAts('https://www.linkedin.com/jobs/view/1234567890/')).toBe('linkedin');
  });

  it('does not match linkedin.com non-jobs pages', () => {
    expect(detectAts('https://www.linkedin.com/in/janedoe/')).toBe('generic');
    expect(detectAts('https://www.linkedin.com/company/acme/')).toBe('generic');
  });

  // ---- generic ---------------------------------------------------------------

  it('returns generic for unknown domains', () => {
    expect(detectAts('https://example.com/careers/software-engineer')).toBe('generic');
  });

  it('returns generic for greenhouse.io without boards subdomain', () => {
    expect(detectAts('https://greenhouse.io/something')).toBe('generic');
  });

  it('returns generic for lever.co without jobs subdomain', () => {
    expect(detectAts('https://lever.co/something')).toBe('generic');
  });

  // ---- edge cases -----------------------------------------------------------

  it('returns generic for invalid URLs', () => {
    expect(detectAts('not-a-url')).toBe('generic');
  });

  it('returns generic for empty string', () => {
    expect(detectAts('')).toBe('generic');
  });

  it('is case-insensitive for hostnames', () => {
    expect(detectAts('HTTPS://JOBS.LEVER.CO/Example/abc')).toBe('lever');
  });

  it('is case-insensitive for linkedin path', () => {
    expect(detectAts('https://www.linkedin.com/JOBS/view/123')).toBe('linkedin');
  });

  // ---- type exhaustiveness check --------------------------------------------

  it('returns a valid AtsType value', () => {
    const valid: AtsType[] = ['greenhouse', 'lever', 'ashby', 'workday', 'linkedin', 'generic'];
    const result = detectAts('https://jobs.lever.co/foo/bar');
    expect(valid).toContain(result);
  });
});
