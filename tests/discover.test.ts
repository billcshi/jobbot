import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverJobsDetailed,
  getDiscoveryCacheSizeForTests,
  normalizeDiscoveryLocation,
  normalizeDiscoveryQuery,
  resetDiscoveryCacheForTests,
} from '../src/jobs/discover.js';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  resetDiscoveryCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('job discovery', () => {
  it('normalizes whitespace without translating unsupported query languages', () => {
    expect(normalizeDiscoveryQuery('  Java   backend internship ')).toBe('Java backend internship');
    expect(normalizeDiscoveryQuery('AI agent')).toBe('AI agent');
  });

  it('rejects a whitespace-only query before contacting any source', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverJobsDetailed({ query: ' \t\r\n ', sources: ['jobicy'] }))
      .rejects.toThrow('Discovery query is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown sources and unsafe result limits before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverJobsDetailed({
      query: 'backend', sources: ['unknown' as never],
    })).rejects.toThrow('Unknown discovery source');
    await expect(discoverJobsDetailed({
      query: 'backend', sources: ['jobicy'], maxResults: 0,
    })).rejects.toThrow('maxResults must be an integer from 1 to 100');
    await expect(discoverJobsDetailed({
      query: 'backend', sources: ['jobicy'], maxResults: 101,
    })).rejects.toThrow('maxResults must be an integer from 1 to 100');
    await expect(discoverJobsDetailed({
      query: 'backend', sources: ['jobicy'], workMode: 'invalid' as 'remote',
    })).rejects.toThrow('Unknown work mode');
    await expect(discoverJobsDetailed({
      query: 'backend', sources: ['jobicy'], searchDepth: 'invalid' as 'quick',
    })).rejects.toThrow('Unknown search depth');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes supported English locations and unrestricted values', () => {
    expect(normalizeDiscoveryLocation('Remote')).toBeUndefined();
    expect(normalizeDiscoveryLocation('Anywhere')).toBeUndefined();
    expect(normalizeDiscoveryLocation('Any')).toBeUndefined();
    expect(normalizeDiscoveryLocation('Seattle')).toBe('Seattle, WA');
    expect(normalizeDiscoveryLocation('London')).toBe('London, United Kingdom');
  });

  it('uses every cross-company source when work mode is unrestricted', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === 'www.themuse.com') {
        return jsonResponse({
          results: url.searchParams.get('page') === '0' ? [
            {
              name: 'Java Backend Developer Intern',
              company: { name: 'Example Office' },
              locations: [{ name: 'Berlin, Germany' }],
              refs: { landing_page: 'https://www.themuse.com/jobs/example/java-backend-test' },
              publication_date: '2026-08-20',
            },
            {
              name: 'Product Integration Engineering Internship',
              company: { name: 'Unrelated Office' },
              locations: [{ name: 'Paris, France' }],
              refs: { landing_page: 'https://www.themuse.com/jobs/example/unrelated-internship-test' },
            },
          ] : [],
        });
      }
      if (url.hostname === 'jobicy.com') {
        expect(url.searchParams.get('tag')).toBe('java');
        return jsonResponse({
          jobs: [{
            jobTitle: 'Java Backend Engineer Intern',
            companyName: 'Example One',
            jobGeo: 'Anywhere',
            url: 'https://jobicy.com/jobs/example-one-java',
            jobExcerpt: 'Java and Spring Boot internship',
            pubDate: '2026-08-20',
          }],
        });
      }
      if (url.hostname === 'remotive.com') {
        expect(url.searchParams.get('search')).toBe('java');
        return jsonResponse({
          jobs: [{
            title: 'Junior Java Developer Intern',
            company_name: 'Example Two',
            candidate_required_location: 'Worldwide',
            url: 'https://remotive.com/remote-jobs/software-dev/example-two-java',
            description: '<p>Java backend role</p>',
            publication_date: '2026-08-19',
          }],
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await discoverJobsDetailed({ query: 'Java backend internship' });

    expect(discovery.results.map(result => result.source)).toEqual(['themuse', 'jobicy', 'remotive']);
    expect(discovery.results.map(result => result.workMode)).toEqual(['onsite', 'remote', 'remote']);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({ source: 'themuse', status: 'ok', resultCount: 1 }),
      expect.objectContaining({ source: 'jobicy', status: 'ok', resultCount: 1 }),
      expect.objectContaining({ source: 'remotive', status: 'ok', resultCount: 1 }),
      expect.objectContaining({ source: 'greenhouse', status: 'skipped' }),
      expect.objectContaining({ source: 'lever', status: 'skipped' }),
      expect.objectContaining({ source: 'ashby', status: 'skipped' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(7);

    const onsiteDiscovery = await discoverJobsDetailed({ query: 'Java backend internship', workMode: 'onsite' });
    expect(onsiteDiscovery.results.map(result => result.source)).toEqual(['themuse']);
    expect(onsiteDiscovery.diagnostics).toEqual([
      expect.objectContaining({ source: 'themuse', status: 'ok' }),
      expect.objectContaining({ source: 'jobicy', status: 'skipped' }),
      expect.objectContaining({ source: 'remotive', status: 'skipped' }),
      expect.objectContaining({ source: 'greenhouse', status: 'skipped' }),
      expect.objectContaining({ source: 'lever', status: 'skipped' }),
      expect.objectContaining({ source: 'ashby', status: 'skipped' }),
    ]);
  });

  it('rejects Chinese keywords and locations to match the UI contract', async () => {
    await expect(discoverJobsDetailed({ query: 'Java后端', sources: ['jobicy'] }))
      .rejects.toThrow('must be entered in English');
    await expect(discoverJobsDetailed({ query: 'backend', location: '西雅图', sources: ['jobicy'] }))
      .rejects.toThrow('must be entered in English');
  });

  it('keeps remote jobs that are eligible from the selected city in any mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ jobs: [
      {
        jobTitle: 'Backend Engineer',
        companyName: 'Worldwide Company',
        jobGeo: 'Worldwide',
        url: 'https://jobicy.com/jobs/worldwide-backend-test',
      },
      {
        jobTitle: 'Backend Engineer',
        companyName: 'US Company',
        jobGeo: 'United States',
        url: 'https://jobicy.com/jobs/us-backend-test',
      },
      {
        jobTitle: 'Backend Engineer',
        companyName: 'APAC Company',
        jobGeo: 'APAC',
        url: 'https://jobicy.com/jobs/apac-backend-test',
      },
    ] })));

    const discovery = await discoverJobsDetailed({
      query: 'backend engineer',
      location: 'Seattle',
      workMode: 'any',
      sources: ['jobicy'],
    });

    expect(discovery.results.map(result => result.company)).toEqual(['Worldwide Company', 'US Company']);
  });

  it('does not confuse AI Agent roles with customer service agents', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === 'jobicy.com') {
        return jsonResponse({ jobs: [
          {
            jobTitle: 'Customer Care Agent',
            companyName: 'Example Support',
            jobGeo: 'Anywhere',
            url: 'https://jobicy.com/jobs/customer-agent-filter-test',
          },
          {
            jobTitle: 'Software Engineer, AI Agent Platform',
            companyName: 'Example AI',
            jobGeo: 'Anywhere',
            url: 'https://jobicy.com/jobs/ai-agent-filter-test',
          },
        ] });
      }
      return jsonResponse({ jobs: [] });
    }));

    const discovery = await discoverJobsDetailed({ query: 'AI agent', sources: ['jobicy'] });

    expect(discovery.results).toHaveLength(1);
    expect(discovery.results[0]?.title).toBe('Software Engineer, AI Agent Platform');
  });

  it('preserves internship and seniority constraints for AI agent searches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ jobs: [
      {
        jobTitle: 'AI Agent Engineer',
        companyName: 'General AI',
        jobGeo: 'Anywhere',
        url: 'https://example.com/general-ai-agent',
      },
      {
        jobTitle: 'AI Agent Engineer Intern',
        companyName: 'Intern AI',
        jobGeo: 'Anywhere',
        url: 'https://example.com/intern-ai-agent',
      },
      {
        jobTitle: 'Senior AI Agent Engineer',
        companyName: 'Senior AI',
        jobGeo: 'Anywhere',
        url: 'https://example.com/senior-ai-agent',
      },
    ] })));

    const internship = await discoverJobsDetailed({
      query: 'AI agent internship', sources: ['jobicy'],
    });
    expect(internship.results.map(job => job.company)).toEqual(['Intern AI']);

    resetDiscoveryCacheForTests();
    const senior = await discoverJobsDetailed({
      query: 'senior AI agent engineer', sources: ['jobicy'],
    });
    expect(senior.results.map(job => job.company)).toEqual(['Senior AI']);
  });

  it('accepts technical agent-runtime titles without matching customer agents', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return jsonResponse({ results: url.searchParams.get('page') === '0' ? [
        {
          name: 'Customer Support Agent',
          company: { name: 'Support Company' },
          locations: [{ name: 'London' }],
          refs: { landing_page: 'https://www.themuse.com/jobs/example/customer-agent-test' },
        },
        {
          name: 'Agent Runtime & Systems Engineer',
          company: { name: 'Agent Company' },
          locations: [{ name: 'London' }],
          refs: { landing_page: 'https://www.themuse.com/jobs/example/agent-runtime-test' },
        },
      ] : [] });
    }));

    const discovery = await discoverJobsDetailed({
      query: 'AI agent',
      sources: ['themuse'],
      location: 'London',
    });

    expect(discovery.results.map(result => result.title)).toEqual(['Agent Runtime & Systems Engineer']);
  });

  it('keeps The Muse remote matches selected by its upstream location filter', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('location')).toBe('Seattle, WA');
      return jsonResponse({ results: url.searchParams.get('page') === '0' ? [
        {
          name: 'Backend Software Engineer',
          company: { name: 'Seattle Company' },
          locations: [{ name: 'Seattle, WA' }],
          refs: { landing_page: 'https://www.themuse.com/jobs/example/seattle-backend-test' },
        },
        {
          name: 'Backend Software Engineer',
          company: { name: 'Remote Company' },
          locations: [{ name: 'Flexible / Remote' }],
          refs: { landing_page: 'https://www.themuse.com/jobs/example/remote-backend-test' },
        },
      ] : [] });
    }));

    const discovery = await discoverJobsDetailed({
      query: 'backend engineer',
      location: 'Seattle',
      sources: ['themuse'],
    });

    expect(discovery.results.map(result => result.company)).toEqual([
      'Seattle Company', 'Remote Company',
    ]);
  });

  it('searches deep The Muse pages up to the discovery cap', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get('page'));
      return jsonResponse({
        page_count: 50,
        results: page === 35 ? [{
          name: 'Backend Software Engineer',
          company: { name: 'Later Page Company' },
          locations: [{ name: 'Seattle, WA' }],
          refs: { landing_page: 'https://www.themuse.com/jobs/example/later-page-backend-test' },
        }] : [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await discoverJobsDetailed({
      query: 'backend engineer',
      location: 'Seattle',
      sources: ['themuse'],
      workMode: 'onsite',
    });

    expect(discovery.results.map(result => result.company)).toEqual(['Later Page Company']);
    expect(fetchMock).toHaveBeenCalledTimes(40);
  });

  it('searches every reported The Muse page in deep mode', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      return jsonResponse({
        page_count: 45,
        results: page === 44 ? [{
          name: 'Backend Software Engineer Graduate',
          company: { name: 'Deep Search Company' },
          locations: [{ name: 'Seattle, WA' }],
          refs: { landing_page: 'https://www.themuse.com/jobs/example/deep-backend-test' },
        }] : [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await discoverJobsDetailed({
      query: 'backend engineer',
      location: 'Seattle',
      sources: ['themuse'],
      workMode: 'any',
      searchDepth: 'deep',
    });

    expect(discovery.results.map(result => result.company)).toEqual(['Deep Search Company']);
    expect(fetchMock).toHaveBeenCalledTimes(45);
  });

  it('requires a location for a deep The Muse search', async () => {
    await expect(discoverJobsDetailed({
      query: 'backend engineer',
      sources: ['themuse'],
      searchDepth: 'deep',
    })).rejects.toThrow('Deep search requires a work location');
    await expect(discoverJobsDetailed({
      query: 'backend engineer',
      location: 'Remote',
      sources: ['themuse'],
      searchDepth: 'deep',
    })).rejects.toThrow('Deep search requires a work location');
  });

  it('uses The Muse descriptions to find backend work under generic titles', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const page = new URL(String(input)).searchParams.get('page');
      return jsonResponse({
        page_count: 1,
        results: page === '0' ? [
          {
            name: 'Software Engineer II',
            contents: '<p>Build Java backend APIs and distributed services.</p>',
            company: { name: 'Backend Platform Company' },
            locations: [{ name: 'Seattle, WA' }],
            refs: { landing_page: 'https://www.themuse.com/jobs/example/generic-backend-test' },
          },
          {
            name: 'Frontend Engineer',
            contents: '<p>Collaborate with the backend API team.</p>',
            company: { name: 'Frontend Company' },
            locations: [{ name: 'Seattle, WA' }],
            refs: { landing_page: 'https://www.themuse.com/jobs/example/frontend-test' },
          },
          {
            name: 'Machine Learning Engineer',
            contents: '<p>Use a backend API maintained by another team.</p>',
            company: { name: 'ML Company' },
            locations: [{ name: 'Seattle, WA' }],
            refs: { landing_page: 'https://www.themuse.com/jobs/example/ml-test' },
          },
        ] : [],
      });
    }));

    const discovery = await discoverJobsDetailed({
      query: 'backend engineer',
      location: 'Seattle',
      sources: ['themuse'],
    });

    expect(discovery.results.map(result => result.company)).toEqual(['Backend Platform Company']);
  });

  it('does not let unrelated titles match only because role words appear in descriptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ jobs: [
      {
        title: 'Senior Product Designer',
        company_name: 'Design Company',
        candidate_required_location: 'Worldwide',
        description: 'Partner closely with the engineering manager on product quality.',
        url: 'https://example.com/product-designer',
      },
      {
        title: 'Staff Design Engineer',
        company_name: 'Design Company',
        candidate_required_location: 'Worldwide',
        description: 'Partner with the engineering manager on cross-functional work.',
        url: 'https://example.com/staff-design-engineer',
      },
    ] })));

    const discovery = await discoverJobsDetailed({
      query: 'engineering manager', sources: ['remotive'],
    });

    expect(discovery.results).toEqual([]);
  });

  it('explains why LinkedIn automation is unavailable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await discoverJobsDetailed({ query: 'backend', sources: ['linkedin'] });

    expect(discovery.results).toEqual([]);
    expect(discovery.diagnostics[0]).toEqual(expect.objectContaining({
      source: 'linkedin',
      status: 'unavailable',
      httpStatus: 451,
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains when an ATS source needs a company board name', async () => {
    const discovery = await discoverJobsDetailed({ query: 'backend', sources: ['greenhouse'] });

    expect(discovery.results).toEqual([]);
    expect(discovery.diagnostics[0]).toEqual(expect.objectContaining({
      source: 'greenhouse',
      status: 'skipped',
      message: 'greenhouse requires a company board name.',
    }));
  });

  it('matches a canonical city against a shorter ATS location', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).searchParams.get('content')).toBe('true');
      return jsonResponse({ jobs: [{
        title: 'Backend Engineer',
        absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
        location: { name: 'Seattle' },
        updated_at: '2026-08-25',
      }] });
    }));

    const discovery = await discoverJobsDetailed({
      query: 'backend', location: 'Seattle', company: 'acme', sources: ['greenhouse'],
    });

    expect(discovery.results).toHaveLength(1);
    expect(discovery.diagnostics[0]).toEqual(expect.objectContaining({ status: 'ok' }));
  });

  it('requests Greenhouse content so generic titles can match descriptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).searchParams.get('content')).toBe('true');
      return jsonResponse({ jobs: [{
        title: 'Software Engineer II',
        content: 'Build backend APIs and distributed services.',
        absolute_url: 'https://boards.greenhouse.io/acme/jobs/description-match',
        location: { name: 'Seattle, WA' },
        updated_at: '2026-08-25',
        company_name: 'Acme Incorporated',
      }] });
    }));

    const discovery = await discoverJobsDetailed({
      query: 'backend engineer', location: 'Seattle', company: 'acme', sources: ['greenhouse'],
    });

    expect(discovery.results[0]).toEqual(expect.objectContaining({
      title: 'Software Engineer II', company: 'Acme Incorporated',
    }));
  });

  it('parses the current Lever postings schema and explicit work mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).hostname).toBe('api.lever.co');
      return jsonResponse([{
        text: 'Software Engineer II',
        hostedUrl: 'https://jobs.lever.co/acme/current-schema',
        applyUrl: 'https://jobs.lever.co/acme/current-schema/apply',
        workplaceType: 'remote',
        categories: { location: 'Remote - United States', allLocations: ['United States'] },
        createdAt: 1_787_529_600_000,
        descriptionPlain: 'Build backend APIs and distributed services.',
      }]);
    }));

    const discovery = await discoverJobsDetailed({
      query: 'backend engineer', location: 'Seattle', company: 'acme',
      sources: ['lever'], workMode: 'remote',
    });

    expect(discovery.results[0]).toEqual(expect.objectContaining({
      url: 'https://jobs.lever.co/acme/current-schema', workMode: 'remote', company: 'acme',
    }));
  });

  it('falls back to the Lever EU postings endpoint after a global 404', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const hostname = new URL(String(input)).hostname;
      if (hostname === 'api.lever.co') return new Response('missing', { status: 404 });
      return jsonResponse([{
        text: 'Backend Engineer',
        hostedUrl: 'https://jobs.eu.lever.co/acme-eu/role',
        workplaceType: 'on-site',
        categories: { location: 'Berlin, Germany' },
        createdAt: 1_787_529_600_000,
      }]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await discoverJobsDetailed({
      query: 'backend', location: 'Berlin', company: 'acme-eu', sources: ['lever'],
    });

    expect(discovery.results[0]?.url).toBe('https://jobs.eu.lever.co/acme-eu/role');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the documented Ashby endpoint and keeps the board as company', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.href).toBe('https://api.ashbyhq.com/posting-api/job-board/acme');
      expect(init?.method).toBeUndefined();
      return jsonResponse({ apiVersion: '1', jobs: [{
        title: 'Software Engineer II',
        department: 'Engineering',
        location: 'Remote - European Union',
        secondaryLocations: [{ location: 'Berlin' }],
        workplaceType: 'Remote',
        isRemote: true,
        isListed: true,
        jobUrl: 'https://jobs.ashbyhq.com/acme/role',
        publishedAt: '2026-08-25',
        descriptionPlain: 'Build backend APIs and distributed services.',
      }] });
    }));

    const discovery = await discoverJobsDetailed({
      query: 'backend engineer', location: 'Berlin', company: 'acme',
      sources: ['ashby'], workMode: 'remote',
    });

    expect(discovery.results[0]).toEqual(expect.objectContaining({
      company: 'acme', url: 'https://jobs.ashbyhq.com/acme/role', workMode: 'remote',
    }));
  });

  it('reports ATS outages and malformed responses instead of empty results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    const outage = await discoverJobsDetailed({
      query: 'backend', company: 'acme', sources: ['greenhouse'],
    });
    expect(outage.diagnostics[0]).toEqual(expect.objectContaining({
      status: 'unavailable', httpStatus: 503,
    }));

    resetDiscoveryCacheForTests();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not-json', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    const malformed = await discoverJobsDetailed({
      query: 'backend', company: 'acme', sources: ['greenhouse'],
    });
    expect(malformed.diagnostics[0]).toEqual(expect.objectContaining({
      status: 'error', httpStatus: 200,
    }));
  });

  it('reports an ATS hard timeout as source unavailability', async () => {
    const aborted = AbortSignal.abort(new Error('deadline'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(aborted);
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      throw init?.signal?.reason ?? new Error('aborted');
    }));

    const discovery = await discoverJobsDetailed({
      query: 'backend', company: 'acme', sources: ['greenhouse'],
    });

    expect(AbortSignal.timeout).toHaveBeenCalledWith(20_000);
    expect(discovery.diagnostics[0]).toEqual(expect.objectContaining({
      status: 'unavailable', message: expect.stringContaining('timed out after 20000ms'),
    }));
  });

  it('requires discriminating query terms and preserves seniority constraints', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      page_count: 1,
      results: [
        {
          name: 'Java Frontend Developer Intern',
          contents: 'Works with a backend API team.',
          company: { name: 'Frontend Company' },
          locations: [{ name: 'Seattle, WA' }],
          refs: { landing_page: 'https://example.com/frontend' },
        },
        {
          name: 'Senior Java Backend Engineer',
          contents: 'Builds backend services.',
          company: { name: 'Senior Company' },
          locations: [{ name: 'Seattle, WA' }],
          refs: { landing_page: 'https://example.com/senior' },
        },
        {
          name: 'Junior Java Backend Engineer',
          contents: 'Builds backend services.',
          company: { name: 'Junior Company' },
          locations: [{ name: 'Seattle, WA' }],
          refs: { landing_page: 'https://example.com/junior' },
        },
      ],
    })));

    const internship = await discoverJobsDetailed({
      query: 'Java backend internship', location: 'Seattle, WA', sources: ['themuse'],
    });
    expect(internship.results).toEqual([]);

    resetDiscoveryCacheForTests();
    const senior = await discoverJobsDetailed({
      query: 'senior Java backend engineer', location: 'Seattle, WA', sources: ['themuse'],
    });
    expect(senior.results.map(result => result.company)).toEqual(['Senior Company']);
  });

  it('matches remote-source descriptions when the title is generic', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const host = new URL(String(input)).hostname;
      if (host === 'jobicy.com') {
        return jsonResponse({ jobs: [{
          jobTitle: 'Software Engineer Intern',
          companyName: 'Jobicy Description Match',
          jobGeo: 'Worldwide',
          jobExcerpt: 'Build Java backend services.',
          url: 'https://example.com/jobicy-description',
        }] });
      }
      return jsonResponse({ jobs: [{
        title: 'Software Engineer Intern',
        company_name: 'Remotive Description Match',
        candidate_required_location: 'Worldwide',
        description: '<p>Build Java backend services.</p>',
        url: 'https://example.com/remotive-description',
      }] });
    }));

    const result = await discoverJobsDetailed({
      query: 'Java backend internship', sources: ['jobicy', 'remotive'],
    });
    expect(result.results.map(job => job.company)).toEqual([
      'Jobicy Description Match', 'Remotive Description Match',
    ]);
  });

  it('round-robins sources before applying the global result cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === 'www.themuse.com') {
        return jsonResponse({ page_count: 1, results: Array.from({ length: 5 }, (_, index) => ({
          name: `Backend Engineer ${index}`,
          company: { name: `Muse ${index}` },
          locations: [{ name: 'Seattle, WA' }],
          refs: { landing_page: `https://example.com/muse-${index}` },
        })) });
      }
      if (url.hostname === 'jobicy.com') {
        return jsonResponse({ jobs: [{
          jobTitle: 'Backend Engineer', companyName: 'Jobicy', jobGeo: 'Worldwide',
          url: 'https://example.com/jobicy-round-robin',
        }] });
      }
      return jsonResponse({ jobs: [{
        title: 'Backend Engineer', company_name: 'Remotive', candidate_required_location: 'Worldwide',
        url: 'https://example.com/remotive-round-robin',
      }] });
    }));

    const result = await discoverJobsDetailed({
      query: 'backend engineer', location: 'Seattle, WA',
      sources: ['themuse', 'jobicy', 'remotive'], maxResults: 5,
    });
    expect(result.results.map(job => job.source)).toEqual([
      'themuse', 'jobicy', 'remotive', 'themuse', 'themuse',
    ]);
  });

  it('does not conflate case-sensitive paths or distinct query-based job IDs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ jobs: [
      {
        jobTitle: 'Backend Engineer', companyName: 'Upper', jobGeo: 'Worldwide',
        url: 'https://jobs.example.com/Role?id=ABC',
      },
      {
        jobTitle: 'Backend Engineer', companyName: 'Lower', jobGeo: 'Worldwide',
        url: 'https://jobs.example.com/role?id=abc',
      },
    ] })));

    const discovery = await discoverJobsDetailed({
      query: 'backend', sources: ['jobicy'],
    });

    expect(discovery.results.map(result => result.company)).toEqual(['Upper', 'Lower']);
  });

  it('enforces remote work mode for company ATS sources', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ jobs: [{
      title: 'Backend Engineer',
      absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
      location: { name: 'New York, NY' },
      updated_at: '2026-08-20',
    }] })));

    const remote = await discoverJobsDetailed({
      query: 'backend', company: 'acme', sources: ['greenhouse'], workMode: 'remote',
    });
    expect(remote.results).toEqual([]);

    resetDiscoveryCacheForTests();
    const anyMode = await discoverJobsDetailed({
      query: 'backend', company: 'acme', sources: ['greenhouse'], workMode: 'any',
    });
    expect(anyMode.results[0]).toEqual(expect.objectContaining({ workMode: 'onsite' }));
  });

  it('stops paging as soon as the requested result count is reached', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      page_count: 100,
      results: [{
        name: 'Backend Engineer', company: { name: 'First Page' },
        locations: [{ name: 'Seattle, WA' }],
        refs: { landing_page: 'https://example.com/first-page' },
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverJobsDetailed({
      query: 'backend', location: 'Seattle, WA', sources: ['themuse'], maxResults: 1,
    });
    expect(result.results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a partial diagnostic at the deep-search page safety limit', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      page_count: 200,
      results: [],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverJobsDetailed({
      query: 'backend', location: 'Seattle, WA', sources: ['themuse'], searchDepth: 'deep',
    });

    expect(fetchMock).toHaveBeenCalledTimes(120);
    expect(result.diagnostics[0]).toEqual(expect.objectContaining({
      source: 'themuse',
      status: 'empty',
      partial: true,
      message: expect.stringContaining('120-page request safety limit'),
    }));
  });

  it('returns existing results with a partial diagnostic when the time budget expires', async () => {
    let clockReads = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      clockReads += 1;
      return clockReads >= 5 ? 30_001 : 0;
    });
    const fetchMock = vi.fn(async () => jsonResponse({
      page_count: 100,
      results: [],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverJobsDetailed({
      query: 'backend', location: 'Seattle, WA', sources: ['themuse'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.diagnostics[0]).toEqual(expect.objectContaining({
      source: 'themuse',
      status: 'empty',
      partial: true,
      message: expect.stringContaining('time budget was exhausted'),
    }));
  });

  it('bounds and evicts the public response cache', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ jobs: [] }));
    vi.stubGlobal('fetch', fetchMock);
    for (let index = 0; index < 140; index++) {
      await discoverJobsDetailed({ query: `unique-${index}`, sources: ['jobicy'] });
    }
    expect(getDiscoveryCacheSizeForTests()).toBeLessThanOrEqual(128);
    await discoverJobsDetailed({ query: 'unique-0', sources: ['jobicy'] });
    expect(fetchMock).toHaveBeenCalledTimes(141);
  });
});
