import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const views = path.join(process.cwd(), 'src', 'ui', 'views');
const readView = (name: string): string => readFileSync(path.join(views, name), 'utf8');

describe('UI localization', () => {
  it('offers a language switch before and after authentication', () => {
    expect(readView('login.ejs')).toContain('data-language-toggle');
    expect(readView('_head.ejs')).toContain('data-language-toggle');
  });

  it('loads the shared localization layer on every page shell', () => {
    expect(readView('login.ejs')).toContain("include('_i18n')");
    expect(readView('_foot.ejs')).toContain("include('_i18n')");
  });

  it('persists locale choice and translates dynamic UI updates', () => {
    const i18n = readView('_i18n.ejs');
    expect(i18n).toContain("const STORAGE_KEY = 'jobbot-locale'");
    expect(i18n).toContain("'Dashboard': '仪表盘'");
    expect(i18n).toContain('new MutationObserver');
    expect(i18n).toContain('window.alert =');
    expect(i18n).toContain('window.confirm =');
    expect(i18n).toContain("closest?.('[data-i18n-skip]')");
    expect(i18n).toContain("title[data-i18n-skip]");
    expect(readView('job-detail.ejs')).toContain('localizeTitle: false');
    expect(readView('job-detail.ejs')).toContain('data-i18n-skip><%= job.discovered_at %>');
    expect(readView('events.ejs')).toContain('<option data-i18n-skip value="<%= e.job_id %>"');
  });

  it('switches both ways and remembers the selected locale', () => {
    const source = readView('_i18n.ejs')
      .replace(/^<script>\s*/, '')
      .replace(/\s*<\/script>\s*$/, '');
    const stored = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    };
    const skippedBusinessText = {
      nodeType: 3,
      nodeValue: 'Dashboard',
      parentElement: {
        closest: (selector: string) => selector === '[data-i18n-skip]' ? {} : null,
      },
    };
    const body = {
      nodeType: 1,
      childNodes: [skippedBusinessText] as unknown[],
      matches: () => false,
      hasAttribute: () => false,
      getAttribute: () => null,
      setAttribute: () => undefined,
    };
    const document = {
      title: 'JobBot — Dashboard',
      body,
      documentElement: { lang: 'en' },
      addEventListener: () => undefined,
      querySelectorAll: () => [] as unknown[],
    };
    interface TestI18n {
      locale: string;
      setLocale(locale: string): void;
      translate(value: string): string;
    }
    const browserWindow: {
      alert(message: string): void;
      confirm(message: string): boolean;
      dispatchEvent(event: unknown): void;
      jobbotI18n?: TestI18n;
    } = {
      alert: () => undefined,
      confirm: () => true,
      dispatchEvent: () => undefined,
    };
    class FakeMutationObserver {
      public constructor(_callback: (mutations: unknown[]) => void) {}
      public observe(): void {}
    }
    class FakeCustomEvent {
      public constructor(public readonly type: string, public readonly init?: unknown) {}
    }

    const execute = new Function(
      'window', 'document', 'localStorage', 'Node', 'MutationObserver', 'CustomEvent', source,
    );
    execute(
      browserWindow,
      document,
      localStorage,
      { TEXT_NODE: 3, ELEMENT_NODE: 1 },
      FakeMutationObserver,
      FakeCustomEvent,
    );

    const i18n = browserWindow.jobbotI18n;
    expect(i18n).toBeDefined();
    i18n?.setLocale('zh-CN');
    expect(i18n?.translate('Dashboard')).toBe('仪表盘');
    expect(document.title).toBe('JobBot — 仪表盘');
    expect(skippedBusinessText.nodeValue).toBe('Dashboard');
    expect(stored.get('jobbot-locale')).toBe('zh-CN');

    i18n?.setLocale('en');
    expect(i18n?.translate('Dashboard')).toBe('Dashboard');
    expect(document.title).toBe('JobBot — Dashboard');
  });
});
