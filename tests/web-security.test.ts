import { describe, expect, it } from 'vitest';
import {
  buildProfileEditPrompt,
  isTrustedMutationRequest,
  profileAllowsExternalAiEdit,
} from '../src/ui/server';

describe('web mutation security', () => {
  it('accepts a localhost same-origin browser mutation', () => {
    expect(isTrustedMutationRequest({
      method: 'POST',
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      secFetchSite: 'same-origin',
    })).toBe(true);
  });

  it('rejects cross-origin, cross-site, and origin-less mutations', () => {
    expect(isTrustedMutationRequest({
      method: 'POST', host: 'localhost:3000', origin: 'http://evil.test', secFetchSite: 'cross-site',
    })).toBe(false);
    expect(isTrustedMutationRequest({
      method: 'PUT', host: 'localhost:3000', origin: 'http://localhost:3000', secFetchSite: 'cross-site',
    })).toBe(false);
    expect(isTrustedMutationRequest({
      method: 'POST', protocol: 'http', host: 'localhost:3000', origin: 'https://localhost:3000', secFetchSite: 'same-origin',
    })).toBe(false);
    expect(isTrustedMutationRequest({ method: 'DELETE', host: 'localhost:3000' })).toBe(false);
  });

  it('does not restrict read-only requests', () => {
    expect(isTrustedMutationRequest({ method: 'GET' })).toBe(true);
  });

  it('allows review-first AI editing for both profile sections', () => {
    expect(profileAllowsExternalAiEdit('candidate')).toBe(true);
    expect(profileAllowsExternalAiEdit('preferences')).toBe(true);
  });

  it('uses fail-closed truth instructions for candidate AI drafts', () => {
    const prompt = buildProfileEditPrompt('candidate');
    expect(prompt).toContain('NEVER invent, infer, embellish, or assume');
    expect(prompt).toContain('If the instruction is ambiguous or needs missing facts, leave that content unchanged');
    expect(prompt).not.toContain('make your best guess');
  });
});
