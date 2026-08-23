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
    expect(readView('add-urls.ejs')).toContain('<td data-i18n-skip>${esc(r.workMode');
  });

  it('offers working public discovery sources and localized diagnostics', () => {
    const addUrls = readView('add-urls.ejs');
    const i18n = readView('_i18n.ejs');
    expect(addUrls).toContain('<option value="jobicy">Jobicy</option>');
    expect(addUrls).toContain('<option value="remotive">Remotive</option>');
    expect(addUrls).toContain('<option value="themuse">The Muse (international)</option>');
    expect(addUrls).toContain('id="discover-work-mode"');
    expect(addUrls).toContain('id="discover-depth"');
    expect(addUrls).toContain('<option value="quick">Quick search</option>');
    expect(addUrls).toContain('<option value="deep">Deep search</option>');
    expect(addUrls).toContain('within a fixed request and time budget');
    expect(addUrls).toContain('<option value="">All available sources</option>');
    expect(addUrls).toContain("params.set('searchDepth', searchDepth)");
    expect(addUrls).toContain('e.g. Seattle');
    expect(addUrls).toContain('Use English only for job keywords and city names');
    expect(addUrls).not.toContain('e.g. Seattle or 西雅图');
    expect(addUrls).not.toContain('Chinese and English city names are supported.');
    expect(addUrls).not.toContain('<option value="linkedin">');
    expect(addUrls).not.toContain('discover-market');
    expect(addUrls).toContain('renderDiagnostics');
    expect(addUrls).not.toContain("onclick=\"addOne(decodeURIComponent");
    expect(addUrls).toContain("button.addEventListener('click'");
    expect(addUrls).toContain('safeHttpUrl(r.url)');
    expect(addUrls).toContain('DISCOVER_QUERY_REQUIRED');
    expect(addUrls).toContain('未知的职位来源。');
    expect(addUrls).not.toContain('renderManualSearches');
    expect(addUrls).not.toContain('renderChinaNotice');
    expect(i18n).toContain("'Source status': '来源状态'");
    expect(i18n).toContain("'Work location': '工作地点'");
    expect(i18n).toContain("'On-site / hybrid': '线下／混合办公'");
    expect(i18n).toContain("'Quick search': '简易搜索'");
    expect(i18n).toContain("'Deep search': '深度搜索'");
    expect(i18n).toContain("'All available sources': '全部可用来源'");
    expect(i18n).toContain("'Use English only for job keywords and city names (for example: backend engineer, Seattle). Do not enter Chinese.': '请不要输入中文；职位关键词和城市名称均请使用英文（例如 backend engineer、Seattle）。'");
    expect(i18n).toContain("'e.g. backend engineer': '例如：backend engineer（请使用英文）'");
    expect(i18n).toContain("'Enter the city name in English.': '请使用英文城市名。'");
    expect(i18n).toContain("'No matching jobs found.': '来源可用，但没有找到匹配的职位。'");
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
