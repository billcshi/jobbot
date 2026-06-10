/**
 * Job Board Discovery — v0.5
 *
 * Searches job boards for postings matching a query. Supports:
 *   - LinkedIn: HTML scraping via cheerio
 *   - Greenhouse: Public board API (per-company)
 *   - Lever: Public postings API (per-company)
 *   - Ashby: Public API (per-company)
 *
 * For cross-company discovery, LinkedIn is the primary source.
 * Greenhouse/Lever/Ashby can search when a specific company is given.
 */

import * as cheerio from 'cheerio';
import type { AtsType } from './detect-ats.js';
import { logger } from '../utils/logger.js';

// ----- types ------------------------------------------------------------------

export interface DiscoverOptions {
  query: string;
  location?: string;
  sources?: AtsType[];
  maxResults?: number;
  /** Optional company name for per-company board APIs. */
  company?: string;
}

export interface DiscoverResult {
  title: string;
  company: string;
  location: string;
  url: string;
  source: AtsType;
  postedAt?: string;
}

const USER_AGENT = 'JobBot/0.5 (personal job-search assistant)';

const DEFAULT_MAX_RESULTS = 20;
const ALL_SOURCES: AtsType[] = ['greenhouse', 'lever', 'ashby', 'linkedin'];

// ----- LinkedIn scraper -------------------------------------------------------

/**
 * Scrape LinkedIn job search results.
 *
 * LinkedIn's job search page returns server-rendered HTML that cheerio can parse.
 * We look for job cards in the HTML which contain title, company, location, and
 * the job link.
 */
async function searchLinkedIn(
  query: string,
  location?: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
  _company?: string,
): Promise<DiscoverResult[]> {
  const params = new URLSearchParams({ keywords: query });
  if (location) params.set('location', location);
  params.set('f_TPR', 'r604800'); // past week
  params.set('start', '0');

  const searchUrl = `https://www.linkedin.com/jobs/search/?${params.toString()}`;

  logger.info(`Searching LinkedIn: ${searchUrl}`);

  let html: string;
  try {
    const resp = await fetch(searchUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!resp.ok) {
      logger.warn(`LinkedIn search returned HTTP ${resp.status}`);
      return [];
    }
    html = await resp.text();
  } catch (err) {
    logger.warn(`LinkedIn fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const $ = cheerio.load(html);
  const results: DiscoverResult[] = [];

  // LinkedIn's job search page has job cards. The exact selectors change over
  // time, so we try several known patterns.
  const selectors = [
    '.job-search-card',
    '.base-card',
    'li.jobs-search-results__list-item',
    '[data-job-id]',
  ];

  let cards: ReturnType<typeof $> | null = null;
  for (const sel of selectors) {
    const found = $(sel);
    if (found.length > 0) {
      cards = found;
      break;
    }
  }

  if (!cards || cards.length === 0) {
    // Fallback: try to find any <a> with /jobs/view/ in href
    $('a[href*="/jobs/view/"]').each((_i, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href) return;

      // Try to find sibling/parent text content for title
      const parentCard = $el.closest('li, div[class*="card"], div[class*="result"]');
      const title = parentCard.find('h3, [class*="title"]').first().text().trim() ||
        $el.text().trim();
      const company = parentCard.find('[class*="company"], h4').first().text().trim();
      const loc = parentCard.find('[class*="location"]').first().text().trim();

      if (title && results.length < maxResults) {
        const url = href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
        // Check for duplicate
        if (!results.some((r) => r.url === url)) {
          results.push({
            title,
            company: company || 'Unknown',
            location: loc || (location ?? 'Unknown'),
            url,
            source: 'linkedin',
          });
        }
      }
    });
  } else {
    cards.each((_i, el) => {
      if (results.length >= maxResults) return false;

      const $card = $(el);
      const titleEl = $card.find('h3, [class*="title"], .job-search-card__title');
      const companyEl = $card.find('h4, [class*="company"], .job-search-card__subtitle');
      const locationEl = $card.find('[class*="location"], .job-search-card__location');
      const linkEl = $card.find('a[href*="/jobs/view/"]');

      const title = titleEl.first().text().trim();
      const href = linkEl.first().attr('href');
      if (!title || !href) return;

      const url = href.startsWith('http') ? href : `https://www.linkedin.com${href.split('?')[0]}`;
      const company = companyEl.first().text().trim() || 'Unknown';
      const loc = locationEl.first().text().trim() || location || 'Unknown';

      // Skip if we already have this URL
      if (results.some((r) => r.url === url)) return;

      results.push({
        title,
        company,
        location: loc,
        url,
        source: 'linkedin',
      });
    });
  }

  logger.info(`LinkedIn: found ${results.length} result(s)`);
  return results;
}

// ----- Greenhouse API ---------------------------------------------------------

/**
 * Search a Greenhouse board. Requires a company board name.
 *
 * API: GET https://boards-api.greenhouse.io/v1/boards/{company}/jobs
 * Returns all active jobs for that board (public, no auth).
 */
async function searchGreenhouse(
  query: string,
  location?: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
  _company?: string,
): Promise<DiscoverResult[]> {
  // If a specific company is provided, search its board
  const companies = _company ? [_company] : [];
  if (companies.length === 0) {
    // Without a company name, Greenhouse discovery requires a company list.
    // For now, return empty — users can discover companies via LinkedIn first.
    logger.debug('Greenhouse: no company specified, skipping');
    return [];
  }

  const results: DiscoverResult[] = [];

  for (const company of companies) {
    if (results.length >= maxResults) break;

    const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company)}/jobs`;

    try {
      const resp = await fetch(apiUrl, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!resp.ok) continue;

      const data = (await resp.json()) as {
        jobs?: Array<{
          title: string;
          absolute_url: string;
          location: { name: string };
          updated_at: string;
        }>;
      };

      const jobs = data.jobs || [];
      for (const job of jobs) {
        if (results.length >= maxResults) break;

        const titleMatch = job.title.toLowerCase().includes(query.toLowerCase());
        const locMatch = !location ||
          job.location?.name?.toLowerCase().includes(location.toLowerCase());

        if (titleMatch && locMatch) {
          results.push({
            title: job.title,
            company,
            location: job.location?.name || 'Unknown',
            url: job.absolute_url,
            source: 'greenhouse',
            postedAt: job.updated_at,
          });
        }
      }
    } catch (err) {
      logger.debug(`Greenhouse API error for ${company}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return results;
}

// ----- Lever API --------------------------------------------------------------

/**
 * Search a Lever postings API. Requires a company name.
 *
 * API: GET https://api.lever.co/v0/postings/{company}
 * Returns all active postings (public, no auth).
 */
async function searchLever(
  query: string,
  location?: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
  _company?: string,
): Promise<DiscoverResult[]> {
  const companies = _company ? [_company] : [];
  if (companies.length === 0) {
    logger.debug('Lever: no company specified, skipping');
    return [];
  }

  const results: DiscoverResult[] = [];

  for (const company of companies) {
    if (results.length >= maxResults) break;

    const apiUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}`;

    try {
      const resp = await fetch(apiUrl, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!resp.ok) continue;

      const data = (await resp.json()) as Array<{
        text: string;
        host: string;
        url: string;
        categories: { location?: string };
        createdAt: number;
      }>;

      const jobs = Array.isArray(data) ? data : [];
      for (const job of jobs) {
        if (results.length >= maxResults) break;

        const titleMatch = job.text.toLowerCase().includes(query.toLowerCase());
        const jobLocation = job.categories?.location || '';
        const locMatch = !location ||
          jobLocation.toLowerCase().includes(location.toLowerCase());

        if (titleMatch && locMatch) {
          results.push({
            title: job.text,
            company,
            location: jobLocation || 'Unknown',
            url: job.url || job.host,
            source: 'lever',
            postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : undefined,
          });
        }
      }
    } catch (err) {
      logger.debug(`Lever API error for ${company}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return results;
}

// ----- Ashby API --------------------------------------------------------------

/**
 * Search an Ashby job board. Requires a board name (company slug).
 *
 * API: POST https://jobs.ashbyhq.com/api/nonuser/{board}
 * Returns job listings (public, minimal auth).
 */
async function searchAshby(
  query: string,
  location?: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
  _company?: string,
): Promise<DiscoverResult[]> {
  const companies = _company ? [_company] : [];
  if (companies.length === 0) {
    logger.debug('Ashby: no company specified, skipping');
    return [];
  }

  const results: DiscoverResult[] = [];

  for (const company of companies) {
    if (results.length >= maxResults) break;

    const apiUrl = `https://jobs.ashbyhq.com/api/nonuser/${encodeURIComponent(company)}`;

    try {
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          query,
          location: location || '',
          includeDepartmentRestricted: true,
        }),
      });
      if (!resp.ok) continue;

      const data = (await resp.json()) as {
        jobs?: Array<{
          title: string;
          location: string;
          jobUrl: string;
          publishedAt: string;
          department: string;
        }>;
        total: number;
      };

      const jobs = data.jobs || [];
      for (const job of jobs.slice(0, maxResults - results.length)) {
        results.push({
          title: job.title,
          company: job.department || company,
          location: job.location || 'Unknown',
          url: job.jobUrl,
          source: 'ashby',
          postedAt: job.publishedAt || undefined,
        });
      }
    } catch (err) {
      logger.debug(`Ashby API error for ${company}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return results;
}

// ----- main discover ----------------------------------------------------------

type SearchHandler = (query: string, location?: string, maxResults?: number, company?: string) => Promise<DiscoverResult[]>;

const SOURCE_HANDLERS: Record<string, SearchHandler> = {
  linkedin: searchLinkedIn,
  greenhouse: searchGreenhouse,
  lever: searchLever,
  ashby: searchAshby,
};

/**
 * Search job boards for postings matching the query.
 *
 * Fans out to enabled sources in parallel and deduplicates by URL.
 * LinkedIn is the primary cross-company source.
 * Greenhouse/Lever/Ashby require a company name for per-board API access.
 */
export async function discoverJobs(opts: DiscoverOptions): Promise<DiscoverResult[]> {
  const sources = opts.sources && opts.sources.length > 0 ? opts.sources : ALL_SOURCES;
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const { query, location, company } = opts;

  const promises = sources.map((source) => {
    const handler = SOURCE_HANDLERS[source];
    if (!handler) return Promise.resolve([] as DiscoverResult[]);
    return handler(query, location, maxResults, company).catch((err) => {
      logger.warn(`Discover ${source} failed: ${err instanceof Error ? err.message : String(err)}`);
      return [] as DiscoverResult[];
    });
  });

  const sourceResults = await Promise.allSettled(promises);
  const allResults: DiscoverResult[] = [];

  // Deduplicate by URL
  const seen = new Set<string>();
  for (const settled of sourceResults) {
    if (settled.status === 'rejected') continue;
    for (const result of settled.value) {
      const normalized = result.url.split('?')[0]!.toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        allResults.push(result);
      }
    }
  }

  // Sort: LinkedIn first (usually broadest), then by source
  allResults.sort((a, b) => {
    const order: Record<string, number> = { linkedin: 0, greenhouse: 1, lever: 2, ashby: 3 };
    return (order[a.source] ?? 9) - (order[b.source] ?? 9);
  });

  return allResults.slice(0, maxResults);
}
