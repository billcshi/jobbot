import { readFileSync } from 'node:fs';
import path from 'node:path';
import ejs from 'ejs';
import { describe, expect, it } from 'vitest';

const headTemplate = readFileSync(
  path.join(process.cwd(), 'src', 'ui', 'views', '_head.ejs'),
  'utf8',
);

function renderNavigation(activeNav: string): string {
  return ejs.render(headTemplate, {
    title: 'Navigation test',
    activeNav,
    userName: 'test-user',
  });
}

describe('UI navigation', () => {
  it.each([
    ['dashboard', 'Dashboard'],
    ['add-urls', 'Add URLs'],
    ['pipeline', 'Pipeline'],
    ['events', 'Events'],
    ['profile', 'Profile'],
    ['ai-log', 'AI Log'],
  ])('marks the %s section as current', (activeNav, label) => {
    const html = renderNavigation(activeNav);
    expect(html).toContain(`class="nav-link active" aria-current="page">${label}</a>`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it('keeps the JobBot brand separate from the active navigation state', () => {
    const html = renderNavigation('dashboard');
    expect(html).toContain('<a href="/" class="logo">JobBot</a>');
    expect(html).not.toContain('class="logo active"');
    expect(headTemplate).toMatch(/nav \.logo \{[\s\S]*font-weight: 400;[\s\S]*color: var\(--text-muted\);/);
    expect(headTemplate).toMatch(/nav \.nav-link\.active \{[\s\S]*color: var\(--accent\);[\s\S]*font-weight: 700;[\s\S]*border-bottom-color: var\(--accent\);/);
  });

  it.each([
    ['dashboard.ejs', 'dashboard'],
    ['job-detail.ejs', 'dashboard'],
    ['add-urls.ejs', 'add-urls'],
    ['pipeline.ejs', 'pipeline'],
    ['events.ejs', 'events'],
    ['profile.ejs', 'profile'],
    ['profile-edit.ejs', 'profile'],
    ['ai-log.ejs', 'ai-log'],
  ])('%s explicitly selects its navigation section', (view, activeNav) => {
    const source = readFileSync(path.join(process.cwd(), 'src', 'ui', 'views', view), 'utf8');
    expect(source).toContain(`activeNav: '${activeNav}'`);
  });
});
