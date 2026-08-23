import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildProfileEditPrompt,
  isTrustedMutationRequest,
  profileAllowsExternalAiEdit,
  profileYamlForAiDraft,
} from '../src/ui/server';
import { isHttpUrl, parseHttpUrl } from '../src/utils/url.js';

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

  it('allows only absolute HTTP(S) job links', () => {
    expect(isHttpUrl('https://jobs.example.com/backend?id=1')).toBe(true);
    expect(isHttpUrl('http://jobs.example.com/backend')).toBe(true);
    expect(parseHttpUrl("javascript:alert('xss')")).toBeNull();
    expect(parseHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(parseHttpUrl('/relative/job')).toBeNull();
    expect(parseHttpUrl('https://user:password@example.com/job')).toBeNull();
  });

  it('never interpolates an adversarial HTTP URL into an inline event handler', () => {
    const adversarialUrl = "https://jobs.example.com/x').constructor.constructor('alert(1)')()('";
    expect(isHttpUrl(adversarialUrl)).toBe(true);

    const addUrlsView = readFileSync(
      path.join(process.cwd(), 'src', 'ui', 'views', 'add-urls.ejs'),
      'utf8',
    );
    expect(addUrlsView).not.toContain('onclick="addOne(');
    expect(addUrlsView).toContain("button.addEventListener('click'");
  });

  it('allows review-first AI editing for both profile sections', () => {
    expect(profileAllowsExternalAiEdit('candidate')).toBe(true);
    expect(profileAllowsExternalAiEdit('preferences')).toBe(true);
  });

  it('uses fail-closed truth instructions for candidate AI drafts', () => {
    const prompt = buildProfileEditPrompt('candidate');
    expect(prompt).toContain('NEVER invent, infer, embellish, or assume');
    expect(prompt).toContain('If the current YAML is empty, create a minimal profile');
    expect(prompt).toContain('If the instruction is ambiguous or needs missing facts, leave that content unchanged');
    expect(prompt).not.toContain('make your best guess');
  });

  it('lets a new account create its first reviewable AI profile draft', () => {
    expect(profileYamlForAiDraft('')).toBe('{}\n');
    expect(profileYamlForAiDraft('  \n')).toBe('{}\n');
    expect(profileYamlForAiDraft('name: Ada\n')).toBe('name: Ada\n');
  });
});
