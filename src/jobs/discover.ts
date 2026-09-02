/**
 * Job Board Discovery
 *
 * Searches job boards for postings matching a query. Supports:
 *   - The Muse: public international jobs API (on-site, hybrid, remote)
 *   - Jobicy: public remote-jobs API
 *   - Remotive: public remote-jobs API
 *   - Greenhouse: Public board API (per-company)
 *   - Lever: Public postings API (per-company)
 *   - Ashby: Public API (per-company)
 *
 * The Muse, Jobicy, and Remotive provide cross-company discovery without scraping.
 * Greenhouse/Lever/Ashby can search when a specific company is given.
 * LinkedIn automated discovery is intentionally disabled because LinkedIn
 * requires express permission for automated crawling.
 */

import { logger } from '../utils/logger.js';
import { isHttpUrl, parseHttpUrl } from '../utils/url.js';

// ----- types ------------------------------------------------------------------

export type DiscoverySource =
  | 'themuse'
  | 'jobicy'
  | 'remotive'
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'linkedin';

export interface DiscoverOptions {
  query: string;
  location?: string;
  sources?: DiscoverySource[];
  maxResults?: number;
  workMode?: 'any' | 'remote' | 'onsite';
  searchDepth?: 'quick' | 'deep';
  /** Optional company name for per-company board APIs. */
  company?: string;
}

export interface DiscoverResult {
  title: string;
  company: string;
  location: string;
  url: string;
  source: DiscoverySource;
  workMode?: 'remote' | 'onsite' | 'hybrid' | 'unknown';
  postedAt?: string;
}

export type DiscoveryDiagnosticStatus = 'ok' | 'empty' | 'skipped' | 'unavailable' | 'error';

export interface DiscoveryDiagnostic {
  source: DiscoverySource;
  status: DiscoveryDiagnosticStatus;
  message: string;
  resultCount: number;
  httpStatus?: number;
  partial?: boolean;
}

export interface DiscoverResponse {
  results: DiscoverResult[];
  diagnostics: DiscoveryDiagnostic[];
}

const USER_AGENT = 'JobBot/0.1 (personal job search; local use)';

const DEFAULT_MAX_RESULTS = 20;
const DEEP_MAX_RESULTS = 100;
const THE_MUSE_FALLBACK_PAGE_COUNT = 5;
const THE_MUSE_QUICK_PAGE_COUNT = 40;
const THE_MUSE_DEEP_PAGE_COUNT = 120;
const THE_MUSE_PAGE_CONCURRENCY = 8;
const THE_MUSE_QUICK_BUDGET_MS = 30_000;
const THE_MUSE_DEEP_BUDGET_MS = 60_000;
const DEFAULT_SOURCES: DiscoverySource[] = ['themuse', 'jobicy', 'remotive'];
const COMPANY_SOURCES: DiscoverySource[] = ['greenhouse', 'lever', 'ashby'];
const REMOTE_ONLY_SOURCES: DiscoverySource[] = ['jobicy', 'remotive'];
const PUBLIC_API_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PUBLIC_API_CACHE_MAX_ENTRIES = 128;
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const ALL_DISCOVERY_SOURCES: readonly DiscoverySource[] = [
  'themuse', 'jobicy', 'remotive', 'greenhouse', 'lever', 'ashby', 'linkedin',
];

export function resetDiscoveryCacheForTests(): void {
  responseCache.clear();
}

export function getDiscoveryCacheSizeForTests(): number {
  return responseCache.size;
}

class DiscoverySourceError extends Error {
  public constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly unavailable = false,
  ) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}

function pruneResponseCache(now = Date.now()): void {
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt <= now) responseCache.delete(key);
  }
}

function enforceResponseCacheLimit(): void {
  while (responseCache.size > PUBLIC_API_CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    responseCache.delete(oldestKey);
  }
}

async function fetchPublicJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const now = Date.now();
  pruneResponseCache(now);
  const cached = responseCache.get(url);
  if (cached && cached.expiresAt > now) {
    responseCache.delete(url);
    responseCache.set(url, cached);
    return cached.value;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 20_000))),
    });
  } catch (error: unknown) {
    throw new DiscoverySourceError(
      `Network request failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      true,
    );
  }
  if (!response.ok) {
    throw new DiscoverySourceError(`Public API returned HTTP ${response.status}`, response.status, true);
  }

  const value = await response.json() as unknown;
  responseCache.delete(url);
  pruneResponseCache();
  responseCache.set(url, { expiresAt: Date.now() + PUBLIC_API_CACHE_TTL_MS, value });
  enforceResponseCacheLimit();
  return value;
}

async function fetchAtsJson(
  source: 'Greenhouse' | 'Lever' | 'Ashby',
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const timeoutMs = 20_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...init.headers,
      },
      signal: timeoutSignal,
    });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new DiscoverySourceError(`${source} request timed out after ${timeoutMs}ms`, undefined, true);
    }
    throw new DiscoverySourceError(
      `${source} network request failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      true,
    );
  }
  if (!response.ok) {
    throw new DiscoverySourceError(
      `${source} API returned HTTP ${response.status}`,
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }
  try {
    return await response.json() as unknown;
  } catch (error) {
    throw new DiscoverySourceError(
      `${source} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      response.status,
      false,
    );
  }
}

export function normalizeDiscoveryQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

export function normalizeDiscoveryLocation(location?: string): string | undefined {
  const trimmed = location?.trim();
  if (!trimmed) return undefined;
  const noRestriction = /^(?:remote|anywhere|any)$/iu;
  if (noRestriction.test(trimmed)) return undefined;
  const aliases: Record<string, string> = {
    'seattle': 'Seattle, WA',
    'new york': 'New York, NY',
    'san francisco': 'San Francisco, CA',
    'san jose': 'San Jose, CA',
    'los angeles': 'Los Angeles, CA',
    'boston': 'Boston, MA',
    'austin': 'Austin, TX',
    'london': 'London, United Kingdom',
    'berlin': 'Berlin, Germany',
    'singapore': 'Singapore',
    'tokyo': 'Tokyo, Japan',
    'toronto': 'Toronto, Canada',
    'vancouver': 'Vancouver, Canada',
    'sydney': 'Sydney, Australia',
  };
  const alias = aliases[trimmed.toLowerCase()];
  if (alias) return alias;
  return trimmed;
}

function remoteLocationMatches(jobLocation: string, requestedLocation?: string): boolean {
  if (!requestedLocation) return true;
  const job = jobLocation.toLowerCase();
  const requested = requestedLocation.toLowerCase();
  if (job.includes(requested)) return true;
  if (/\b(worldwide|anywhere|global)\b/i.test(job)) return true;

  const isUnitedStatesLocation = /,\s*[a-z]{2}$/i.test(requestedLocation)
    || /\b(?:united states|usa)\b/i.test(requestedLocation);
  if (isUnitedStatesLocation && /\b(?:united states|usa|u\.s\.|us|north america|americas)\b/i.test(jobLocation)) {
    return true;
  }
  if (/\bcanada\b/i.test(requestedLocation) && /\b(?:canada|north america|americas)\b/i.test(jobLocation)) {
    return true;
  }
  if (/\b(?:japan|singapore|australia)\b/i.test(requestedLocation) && /\b(?:apac|asia[ -]?pacific)\b/i.test(jobLocation)) {
    return true;
  }
  if (/\b(?:united kingdom|germany)\b/i.test(requestedLocation)
      && /\b(?:emea|europe|european union|eu|uk)\b/i.test(jobLocation)) {
    return true;
  }

  return false;
}

function onsiteLocationMatches(jobLocation: string, requestedLocation?: string): boolean {
  if (!requestedLocation) return true;
  const job = jobLocation.trim().toLowerCase();
  const requested = requestedLocation.trim().toLowerCase();
  if (job.includes(requested)) return true;

  // Public boards often return only the city even when their query accepts a
  // canonical "City, Region/Country" value. The API already received the full
  // location, so accept an exact city component in the returned location.
  const requestedCity = requested.split(',')[0]?.trim();
  if (!requestedCity) return false;
  return job === requestedCity || job.startsWith(`${requestedCity},`);
}

function apiSearchTerm(query: string): string {
  const normalized = normalizeDiscoveryQuery(query);
  const tokens: string[] = normalized.toLowerCase().match(/[a-z0-9+#.]+/g) ?? [];
  if (tokens.includes('java')) return 'java';
  if (tokens.includes('agent')) return 'agent';
  return normalized;
}

function queryMatches(text: string, query: string): boolean {
  const tokens: string[] = query.toLowerCase().match(/[a-z0-9+#.]+|[\p{Script=Han}]+/gu) ?? [];
  if (tokens.length === 0) return true;
  const normalizedText = text.toLowerCase();
  const tokenMatches = (token: string): boolean => {
    if (token === 'intern' || token === 'internship') {
      return /(^|[^a-z0-9])intern(?:ship)?([^a-z0-9]|$)/i.test(normalizedText);
    }
    if (token === 'senior') {
      return /(^|[^a-z0-9])(?:senior|sr\.?)([^a-z0-9]|$)/i.test(normalizedText);
    }
    if (token === 'junior') {
      return /(^|[^a-z0-9])(?:junior|jr\.?|entry[ -]?level|graduate)([^a-z0-9]|$)/i.test(normalizedText);
    }
    if (/^[a-z0-9+#.]+$/i.test(token)) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(normalizedText);
    }
    return normalizedText.includes(token);
  };
  if (tokens.includes('ai') && tokens.includes('agent')) {
    const hasAi = /(^|[^a-z0-9])ai([^a-z0-9]|$)/i.test(normalizedText);
    const hasAgentFamily = /(^|[^a-z0-9])agent(?:ic|force)?([^a-z0-9]|$)/i.test(normalizedText);
    const hasLlm = /(^|[^a-z0-9])llms?([^a-z0-9]|$)/i.test(normalizedText);
    const hasTechnicalContext = /(^|[^a-z0-9])(runtime|systems?|software|engineer|backend|platform|developer)([^a-z0-9]|$)/i.test(normalizedText);
    if (!((hasAi && hasAgentFamily) || hasLlm || (hasAgentFamily && hasTechnicalContext))) {
      return false;
    }

    // Treat "AI agent" as one technical concept, but keep every other
    // discriminating term (for example "internship" or "senior") mandatory.
    const remainingTokens = tokens.filter(token => token !== 'ai' && token !== 'agent');
    const genericTokens = new Set(['engineer', 'developer', 'software']);
    const remainingRoleTokens = remainingTokens.filter(token => !genericTokens.has(token));
    const requiredRemainingTokens = remainingRoleTokens.length > 0
      ? remainingRoleTokens
      : remainingTokens;
    return requiredRemainingTokens.every(tokenMatches);
  }
  const genericTokens = new Set(['ai', 'engineer', 'developer', 'software']);
  const roleTokens = tokens.filter(token => !genericTokens.has(token));
  const requiredTokens = roleTokens.length > 0 ? roleTokens : tokens;
  return requiredTokens.every(tokenMatches);
}

function titleHasRoleAnchor(title: string, query: string): boolean {
  const tokens: string[] = query.toLowerCase().match(/[a-z0-9+#.]+/g) ?? [];
  const roleTokens = tokens.filter(token => [
    'agent', 'architect', 'backend', 'data', 'designer', 'developer', 'devops',
    'director', 'engineer', 'engineering', 'frontend', 'intern', 'internship',
    'junior', 'lead', 'manager', 'mobile', 'principal', 'product', 'qa',
    'scientist', 'security', 'senior', 'sre', 'staff',
  ].includes(token));
  if (roleTokens.length === 0) return true;

  const tokenMatchesTitle = (token: string): boolean => {
    if (token === 'engineer' || token === 'engineering' || token === 'developer') {
      return /\b(?:developer|engineer(?:ing)?)\b/i.test(title);
    }
    if (token === 'intern' || token === 'internship') return /\bintern(?:ship)?\b/i.test(title);
    if (token === 'senior') return /\b(?:senior|sr\.?)\b/i.test(title);
    if (token === 'junior') return /\b(?:junior|jr\.?|entry[ -]?level|graduate)\b/i.test(title);
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(title);
  };
  // Description matches are intentionally conservative: functional and level
  // words must remain visible in the title. "backend" is the sole exception,
  // because generic Software/Platform Engineer titles are common and receive a
  // separate adjacency check below.
  const requiredTitleTokens = roleTokens.filter(token => token !== 'backend');
  if (!requiredTitleTokens.every(tokenMatchesTitle)) return false;
  return roleTokens.some(tokenMatchesTitle);
}

function jobQueryMatchRank(title: string, contents: string, query: string): 0 | 1 | null {
  if (/\bbackend\b/i.test(query)) {
    const isExcludedTitle = /\b(front[ -]?end|frontend|ios|android|mobile|machine learning|ml|qa|quality assurance|test(?:ing)? engineer|engineer(?:ing)? in test|manager|director)\b/i.test(title);
    if (isExcludedTitle) return null;
  }
  if (queryMatches(title, query)) return 0;
  if (!contents || !queryMatches(`${title} ${contents}`, query)) return null;
  if (!titleHasRoleAnchor(title, query)) return null;

  if (/\bbackend\b/i.test(query)) {
    // Only expand a description match when the title is still an adjacent
    // software/platform/systems role. Unrelated ML, management, frontend, and
    // testing jobs often mention a backend team in otherwise irrelevant copy.
    const isBackendAdjacentTitle = /\b(?:software|platform|infrastructure|systems?|site reliability|full[ -]?stack|java|kotlin)\b.*\b(?:engineer(?:ing)?|developer|intern)\b/i.test(title)
      || /\b(?:engineer(?:ing)?|developer)\b.*\b(?:software|platform|infrastructure|systems?|site reliability|full[ -]?stack|distributed|java|kotlin)\b/i.test(title);
    if (!isBackendAdjacentTitle) return null;
  }

  return 1;
}

function inferWorkMode(location: string): DiscoverResult['workMode'] {
  if (/\bhybrid\b/i.test(location)) return 'hybrid';
  if (/\b(remote|anywhere|worldwide|distributed|work from home|wfh)\b/i.test(location)) return 'remote';
  if (!location.trim() || /^unknown$/i.test(location)) return 'unknown';
  return 'onsite';
}

function workModeMatches(mode: DiscoverResult['workMode'], requested: 'any' | 'remote' | 'onsite'): boolean {
  if (requested === 'any') return true;
  if (requested === 'remote') return mode === 'remote';
  return mode === 'onsite' || mode === 'hybrid';
}

function explicitWorkMode(value: unknown, fallbackLocation: string): DiscoverResult['workMode'] {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'remote') return 'remote';
    if (normalized === 'hybrid') return 'hybrid';
    if (normalized === 'on-site' || normalized === 'onsite') return 'onsite';
  }
  return inferWorkMode(fallbackLocation);
}

function atsLocationMatches(
  jobLocation: string,
  requestedLocation: string | undefined,
  mode: DiscoverResult['workMode'],
): boolean {
  return mode === 'remote'
    ? remoteLocationMatches(jobLocation, requestedLocation)
    : onsiteLocationMatches(jobLocation, requestedLocation);
}

function discoveryUrlKey(value: string): string {
  const url = parseHttpUrl(value);
  if (!url) return value;
  url.hash = '';
  url.searchParams.sort();
  return url.href;
}

interface SourceSearchResult {
  results: DiscoverResult[];
  message?: string;
  partial?: boolean;
}

function sourceSearchResult(
  results: DiscoverResult[],
  message?: string,
  partial = false,
): SourceSearchResult {
  return { results, message, partial };
}

// ----- The Muse API -----------------------------------------------------------

async function searchTheMuse(
  query: string,
  location?: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
  _company?: string,
  workMode: 'any' | 'remote' | 'onsite' = 'any',
  searchDepth: 'quick' | 'deep' = 'quick',
): Promise<SourceSearchResult> {
  const deadline = Date.now() + (searchDepth === 'deep' ? THE_MUSE_DEEP_BUDGET_MS : THE_MUSE_QUICK_BUDGET_MS);
  const normalizedQuery = normalizeDiscoveryQuery(query);
  const normalizedLocation = location?.trim().toLowerCase();
  const buildUrl = (page: number): URL => {
    const url = new URL('https://www.themuse.com/api/public/jobs');
    url.searchParams.set('page', String(page));
    url.searchParams.set('category', 'Software Engineering');
    if (/\binternship\b/i.test(normalizedQuery)) url.searchParams.set('level', 'Internship');
    if (location) url.searchParams.set('location', location);
    const apiKey = process.env['THE_MUSE_API_KEY'];
    if (apiKey) url.searchParams.set('api_key', apiKey);
    return url;
  };

  const firstPage = record(await fetchPublicJson(
    buildUrl(0).toString(),
    Math.max(1, deadline - Date.now()),
  ));
  const reportedPageCount = firstPage?.['page_count'];
  const availablePageCount = typeof reportedPageCount === 'number' && Number.isFinite(reportedPageCount)
    ? Math.max(1, Math.floor(reportedPageCount))
    : THE_MUSE_FALLBACK_PAGE_COUNT;
  const pageLimit = searchDepth === 'deep' ? THE_MUSE_DEEP_PAGE_COUNT : THE_MUSE_QUICK_PAGE_COUNT;
  const pageCount = Math.min(pageLimit, availablePageCount);
  const exactResults: DiscoverResult[] = [];
  const relatedResults: DiscoverResult[] = [];
  const collectPage = (payload: Record<string, unknown> | null): void => {
    const jobs = Array.isArray(payload?.['results']) ? payload['results'] : [];
    for (const value of jobs) {
      const job = record(value);
      if (!job) continue;
      const title = stringField(job, 'name');
      const companyRecord = record(job['company']);
      const refs = record(job['refs']);
      const company = companyRecord ? stringField(companyRecord, 'name') : undefined;
      const jobUrl = refs ? stringField(refs, 'landing_page') : undefined;
      if (!title || !company || !jobUrl || !isHttpUrl(jobUrl)) continue;
      const matchRank = jobQueryMatchRank(title, stringField(job, 'contents') ?? '', normalizedQuery);
      if (matchRank === null) continue;

      const rawLocations = Array.isArray(job['locations']) ? job['locations'] : [];
      const locations = rawLocations
        .map(value => record(value))
        .filter((value): value is Record<string, unknown> => value !== null)
        .map(value => stringField(value, 'name'))
        .filter((value): value is string => value !== undefined);
      const jobLocation = locations.join(' · ') || 'Unknown';
      const mode = inferWorkMode(jobLocation);
      if (!workModeMatches(mode, workMode)) continue;
      // The Muse already applies its location parameter to remote eligibility.
      // Requiring a returned label such as "Flexible / Remote" to contain the
      // requested city incorrectly discards valid upstream matches.
      if (mode !== 'remote' && !onsiteLocationMatches(jobLocation, normalizedLocation)) continue;

      const result: DiscoverResult = {
        title,
        company,
        location: jobLocation,
        url: jobUrl,
        source: 'themuse',
        workMode: mode,
        postedAt: stringField(job, 'publication_date'),
      };
      if (matchRank === 0) exactResults.push(result);
      else relatedResults.push(result);
    }
  };
  const currentResults = (): DiscoverResult[] => [...exactResults, ...relatedResults].slice(0, maxResults);

  collectPage(firstPage);
  if (exactResults.length + relatedResults.length >= maxResults) return sourceSearchResult(currentResults());

  const remainingPageNumbers = Array.from({ length: pageCount - 1 }, (_, index) => index + 1);
  let partialMessage = availablePageCount > pageCount
    ? `Partial results: stopped at the ${pageCount}-page request safety limit (${availablePageCount} pages reported).`
    : undefined;
  for (let start = 0; start < remainingPageNumbers.length; start += THE_MUSE_PAGE_CONCURRENCY) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      partialMessage = `Partial results: The Muse search time budget was exhausted after ${start + 1} page(s).`;
      break;
    }
    const batch = remainingPageNumbers.slice(start, start + THE_MUSE_PAGE_CONCURRENCY);
    try {
      const payloads = await Promise.all(batch.map(async page =>
        record(await fetchPublicJson(buildUrl(page).toString(), remainingMs)),
      ));
      for (const payload of payloads) collectPage(payload);
    } catch (error) {
      if (exactResults.length + relatedResults.length === 0) throw error;
      partialMessage = `Partial results: stopped after a page request failed (${error instanceof Error ? error.message : String(error)}).`;
      break;
    }
    if (exactResults.length + relatedResults.length >= maxResults) {
      partialMessage = undefined;
      break;
    }
  }

  return sourceSearchResult(currentResults(), partialMessage, Boolean(partialMessage));
}

// ----- LinkedIn ---------------------------------------------------------------

/**
 * LinkedIn rejects this project's automated HTML requests with HTTP 451 and its
 * published terms require express permission for crawling. Keep the source as
 * an explicit diagnostic so older CLI invocations fail clearly and safely.
 */
async function searchLinkedIn(
  _query: string,
  _location?: string,
  _maxResults: number = DEFAULT_MAX_RESULTS,
  _company?: string,
): Promise<SourceSearchResult> {
  throw new DiscoverySourceError(
    'LinkedIn automated discovery is disabled because LinkedIn requires express permission for crawling. Search LinkedIn manually and paste the job URL instead.',
    451,
    true,
  );
}

// ----- Jobicy API -------------------------------------------------------------

async function searchJobicy(
  query: string,
  location?: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
): Promise<SourceSearchResult> {
  const url = new URL('https://jobicy.com/api/v2/remote-jobs');
  url.searchParams.set('count', String(Math.min(Math.max(maxResults * 3, 20), 50)));
  url.searchParams.set('tag', apiSearchTerm(query));

  const payload = record(await fetchPublicJson(url.toString()));
  const jobs = Array.isArray(payload?.['jobs']) ? payload['jobs'] : [];
  const normalizedQuery = normalizeDiscoveryQuery(query);
  const normalizedLocation = location?.trim().toLowerCase();
  const results: DiscoverResult[] = [];

  for (const value of jobs) {
    const job = record(value);
    if (!job) continue;
    const title = stringField(job, 'jobTitle');
    const company = stringField(job, 'companyName');
    const jobUrl = stringField(job, 'url');
    if (!title || !company || !jobUrl || !isHttpUrl(jobUrl)) continue;

    const jobLocation = stringField(job, 'jobGeo') ?? 'Remote';
    const contents = [stringField(job, 'jobExcerpt'), stringField(job, 'jobDescription')].filter(Boolean).join(' ');
    if (jobQueryMatchRank(title, contents, normalizedQuery) === null) continue;
    if (!remoteLocationMatches(jobLocation, normalizedLocation)) continue;

    results.push({
      title,
      company,
      location: jobLocation,
      url: jobUrl,
      source: 'jobicy',
      workMode: 'remote',
      postedAt: stringField(job, 'pubDate'),
    });
    if (results.length >= maxResults) break;
  }

  return sourceSearchResult(results);
}

// ----- Remotive API -----------------------------------------------------------

async function searchRemotive(
  query: string,
  location?: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
): Promise<SourceSearchResult> {
  const url = new URL('https://remotive.com/api/remote-jobs');
  url.searchParams.set('search', apiSearchTerm(query));
  url.searchParams.set('limit', String(Math.min(Math.max(maxResults * 3, 20), 100)));

  const payload = record(await fetchPublicJson(url.toString()));
  const jobs = Array.isArray(payload?.['jobs']) ? payload['jobs'] : [];
  const normalizedQuery = normalizeDiscoveryQuery(query);
  const normalizedLocation = location?.trim().toLowerCase();
  const results: DiscoverResult[] = [];

  for (const value of jobs) {
    const job = record(value);
    if (!job) continue;
    const title = stringField(job, 'title');
    const company = stringField(job, 'company_name');
    const jobUrl = stringField(job, 'url');
    if (!title || !company || !jobUrl || !isHttpUrl(jobUrl)) continue;

    const jobLocation = stringField(job, 'candidate_required_location') ?? 'Remote';
    if (jobQueryMatchRank(title, stringField(job, 'description') ?? '', normalizedQuery) === null) continue;
    if (!remoteLocationMatches(jobLocation, normalizedLocation)) continue;

    results.push({
      title,
      company,
      location: jobLocation,
      url: jobUrl,
      source: 'remotive',
      workMode: 'remote',
      postedAt: stringField(job, 'publication_date'),
    });
    if (results.length >= maxResults) break;
  }

  return sourceSearchResult(results);
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
  workMode: 'any' | 'remote' | 'onsite' = 'any',
): Promise<SourceSearchResult> {
  // If a specific company is provided, search its board
  const companies = _company ? [_company] : [];
  if (companies.length === 0) {
    // Without a company name, Greenhouse discovery requires a company list.
    // For now, return empty — users can discover companies via LinkedIn first.
    logger.debug('Greenhouse: no company specified, skipping');
    return sourceSearchResult([]);
  }

  const results: DiscoverResult[] = [];

  for (const company of companies) {
    if (results.length >= maxResults) break;

    const apiUrl = new URL(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company)}/jobs`);
    // Greenhouse omits job content unless this flag is present. Without it,
    // description-based discovery silently degrades to title-only matching.
    apiUrl.searchParams.set('content', 'true');

    try {
      const data = await fetchAtsJson('Greenhouse', apiUrl.toString()) as {
        jobs?: Array<{
          title: string;
          absolute_url: string;
          location: { name: string };
          updated_at: string;
          content?: string;
          company_name?: string;
        }>;
      };

      const jobs = data.jobs || [];
      for (const job of jobs) {
        if (results.length >= maxResults) break;

        const jobLocation = job.location?.name || 'Unknown';
        const mode = inferWorkMode(jobLocation);
        const titleMatch = jobQueryMatchRank(job.title, job.content ?? '', normalizeDiscoveryQuery(query)) !== null;
        const locMatch = atsLocationMatches(jobLocation, location, mode);

        if (titleMatch && locMatch && workModeMatches(mode, workMode) && isHttpUrl(job.absolute_url)) {
          results.push({
            title: job.title,
            company: job.company_name || company,
            location: jobLocation,
            url: job.absolute_url,
            source: 'greenhouse',
            workMode: mode,
            postedAt: job.updated_at,
          });
        }
      }
    } catch (err) {
      if (err instanceof DiscoverySourceError) throw err;
      throw new DiscoverySourceError(
        `Greenhouse response handling failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return sourceSearchResult(results);
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
  workMode: 'any' | 'remote' | 'onsite' = 'any',
): Promise<SourceSearchResult> {
  const companies = _company ? [_company] : [];
  if (companies.length === 0) {
    logger.debug('Lever: no company specified, skipping');
    return sourceSearchResult([]);
  }

  const results: DiscoverResult[] = [];

  for (const company of companies) {
    if (results.length >= maxResults) break;

    try {
      const endpoints = [
        `https://api.lever.co/v0/postings/${encodeURIComponent(company)}`,
        `https://api.eu.lever.co/v0/postings/${encodeURIComponent(company)}`,
      ];
      let rawData: unknown;
      let notFoundError: DiscoverySourceError | undefined;
      for (const endpoint of endpoints) {
        try {
          rawData = await fetchAtsJson('Lever', endpoint);
          break;
        } catch (error) {
          if (error instanceof DiscoverySourceError && error.httpStatus === 404) {
            notFoundError = error;
            continue;
          }
          throw error;
        }
      }
      if (rawData === undefined) {
        throw notFoundError ?? new DiscoverySourceError('Lever board was not found', 404);
      }
      if (!Array.isArray(rawData)) {
        throw new DiscoverySourceError('Lever returned an invalid postings payload');
      }
      const data = rawData as Array<{
        text: string;
        host?: string;
        url?: string;
        hostedUrl?: string;
        applyUrl?: string;
        workplaceType?: string;
        categories?: { location?: string; allLocations?: string[] };
        createdAt: number;
        descriptionPlain?: string;
      }>;

      for (const job of data) {
        if (results.length >= maxResults) break;

        const titleMatch = jobQueryMatchRank(job.text, job.descriptionPlain ?? '', normalizeDiscoveryQuery(query)) !== null;
        const jobLocation = job.categories?.location || '';
        const allLocations = [jobLocation, ...(job.categories?.allLocations ?? [])]
          .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
          .join(' · ');
        const mode = explicitWorkMode(job.workplaceType, allLocations || 'Unknown');
        const locMatch = atsLocationMatches(allLocations, location, mode);
        const jobUrl = job.hostedUrl || job.url || job.host;

        if (titleMatch && locMatch && workModeMatches(mode, workMode) && jobUrl && isHttpUrl(jobUrl)) {
          results.push({
            title: job.text,
            company,
            location: jobLocation || 'Unknown',
            url: jobUrl,
            source: 'lever',
            workMode: mode,
            postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : undefined,
          });
        }
      }
    } catch (err) {
      if (err instanceof DiscoverySourceError) throw err;
      throw new DiscoverySourceError(
        `Lever response handling failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return sourceSearchResult(results);
}

// ----- Ashby API --------------------------------------------------------------

/**
 * Search an Ashby job board. Requires a board name (company slug).
 *
 * API: GET https://api.ashbyhq.com/posting-api/job-board/{board}
 * Returns all published listings for the public board.
 */
async function searchAshby(
  query: string,
  location?: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
  _company?: string,
  workMode: 'any' | 'remote' | 'onsite' = 'any',
): Promise<SourceSearchResult> {
  const companies = _company ? [_company] : [];
  if (companies.length === 0) {
    logger.debug('Ashby: no company specified, skipping');
    return sourceSearchResult([]);
  }

  const results: DiscoverResult[] = [];

  for (const company of companies) {
    if (results.length >= maxResults) break;

    const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company)}`;

    try {
      const data = await fetchAtsJson('Ashby', apiUrl) as {
        jobs?: Array<{
          title: string;
          location: string;
          jobUrl: string;
          publishedAt: string;
          department?: string;
          descriptionHtml?: string;
          descriptionPlain?: string;
          isListed?: boolean;
          isRemote?: boolean;
          workplaceType?: string;
          secondaryLocations?: Array<{ location?: string }>;
        }>;
        apiVersion?: string;
      };

      const jobs = data.jobs || [];
      for (const job of jobs) {
        if (results.length >= maxResults) break;
        if (job.isListed === false) continue;
        const jobLocation = job.location || 'Unknown';
        const matchingLocations = [
          jobLocation,
          ...(job.secondaryLocations ?? []).map(item => item.location ?? ''),
        ].filter(Boolean).join(' · ');
        const mode = job.isRemote === true
          ? 'remote'
          : explicitWorkMode(job.workplaceType, jobLocation);
        const description = job.descriptionPlain ?? job.descriptionHtml ?? '';
        if (jobQueryMatchRank(job.title, description, normalizeDiscoveryQuery(query)) === null) continue;
        if (!atsLocationMatches(matchingLocations, location, mode)) continue;
        if (!workModeMatches(mode, workMode) || !isHttpUrl(job.jobUrl)) continue;
        results.push({
          title: job.title,
          company,
          location: jobLocation,
          url: job.jobUrl,
          source: 'ashby',
          workMode: mode,
          postedAt: job.publishedAt || undefined,
        });
      }
    } catch (err) {
      if (err instanceof DiscoverySourceError) throw err;
      throw new DiscoverySourceError(
        `Ashby response handling failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return sourceSearchResult(results);
}

// ----- main discover ----------------------------------------------------------

type SearchHandler = (
  query: string,
  location?: string,
  maxResults?: number,
  company?: string,
  workMode?: 'any' | 'remote' | 'onsite',
  searchDepth?: 'quick' | 'deep',
) => Promise<SourceSearchResult>;

const SOURCE_HANDLERS: Record<DiscoverySource, SearchHandler> = {
  themuse: searchTheMuse,
  jobicy: searchJobicy,
  remotive: searchRemotive,
  linkedin: searchLinkedIn,
  greenhouse: searchGreenhouse,
  lever: searchLever,
  ashby: searchAshby,
};

/**
 * Search job boards for postings matching the query.
 *
 * Fans out to enabled sources in parallel and deduplicates by URL.
 * The Muse, Jobicy, and Remotive are the default cross-company sources.
 * Greenhouse/Lever/Ashby require a company name for per-board API access.
 */
export async function discoverJobsDetailed(opts: DiscoverOptions): Promise<DiscoverResponse> {
  const query = normalizeDiscoveryQuery(opts.query);
  if (!query) {
    throw new Error('Discovery query is required.');
  }
  if (/\p{Script=Han}/u.test(`${query} ${opts.location ?? ''}`)) {
    throw new Error('Job keywords and location must be entered in English.');
  }
  const sources = opts.sources && opts.sources.length > 0
    ? [...new Set(opts.sources)]
    : [...DEFAULT_SOURCES, ...COMPANY_SOURCES];
  const invalidSource = sources.find(source => !ALL_DISCOVERY_SOURCES.includes(source));
  if (invalidSource) throw new Error(`Unknown discovery source: ${String(invalidSource)}`);
  const company = opts.company?.trim() || undefined;
  const location = normalizeDiscoveryLocation(opts.location);
  const workMode = opts.workMode ?? 'any';
  const searchDepth = opts.searchDepth ?? 'quick';
  if (!['any', 'remote', 'onsite'].includes(workMode)) {
    throw new Error(`Unknown work mode: ${String(workMode)}`);
  }
  if (!['quick', 'deep'].includes(searchDepth)) {
    throw new Error(`Unknown search depth: ${String(searchDepth)}`);
  }
  const maxResults = opts.maxResults ?? (searchDepth === 'deep' ? DEEP_MAX_RESULTS : DEFAULT_MAX_RESULTS);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > DEEP_MAX_RESULTS) {
    throw new Error(`maxResults must be an integer from 1 to ${DEEP_MAX_RESULTS}.`);
  }

  if (searchDepth === 'deep' && sources.includes('themuse') && !location) {
    throw new Error('Deep search requires a work location when The Muse is enabled.');
  }

  const promises = sources.map(async (source): Promise<{ results: DiscoverResult[]; diagnostic: DiscoveryDiagnostic }> => {
    if (COMPANY_SOURCES.includes(source) && !company) {
      return {
        results: [],
        diagnostic: {
          source,
          status: 'skipped',
          message: `${source} requires a company board name.`,
          resultCount: 0,
        },
      };
    }
    if (workMode === 'onsite' && REMOTE_ONLY_SOURCES.includes(source)) {
      return {
        results: [],
        diagnostic: {
          source,
          status: 'skipped',
          message: `${source} only provides remote jobs.`,
          resultCount: 0,
        },
      };
    }

    const handler = SOURCE_HANDLERS[source];
    try {
      const outcome = await handler(query, location, maxResults, company, workMode, searchDepth);
      const { results } = outcome;
      return {
        results,
        diagnostic: {
          source,
          status: results.length > 0 ? 'ok' : 'empty',
          message: outcome.message ?? (results.length > 0
            ? `${results.length} matching job(s) found.`
            : 'The source responded successfully but had no matching jobs.'),
          resultCount: results.length,
          partial: outcome.partial,
        },
      };
    } catch (err: unknown) {
      logger.warn(`Discover ${source} failed: ${err instanceof Error ? err.message : String(err)}`);
      const sourceError = err instanceof DiscoverySourceError ? err : undefined;
      return {
        results: [],
        diagnostic: {
          source,
          status: sourceError?.unavailable ? 'unavailable' : 'error',
          message: err instanceof Error ? err.message : String(err),
          resultCount: 0,
          httpStatus: sourceError?.httpStatus,
        },
      };
    }
  });

  const sourceResults = await Promise.all(promises);
  const diagnostics: DiscoveryDiagnostic[] = [];

  // Deduplicate by URL while round-robin interleaving sources. This prevents a
  // high-volume first source from starving every later source at the global cap.
  const allResults: DiscoverResult[] = [];
  const seen = new Set<string>();
  diagnostics.push(...sourceResults.map(sourceResult => sourceResult.diagnostic));
  const largestSource = Math.max(0, ...sourceResults.map(sourceResult => sourceResult.results.length));
  for (let index = 0; index < largestSource && allResults.length < maxResults; index++) {
    for (const sourceResult of sourceResults) {
      const result = sourceResult.results[index];
      if (!result) continue;
      const normalized = discoveryUrlKey(result.url);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        allResults.push(result);
        if (allResults.length >= maxResults) break;
      }
    }
  }

  return { results: allResults, diagnostics };
}

export async function discoverJobs(opts: DiscoverOptions): Promise<DiscoverResult[]> {
  return (await discoverJobsDetailed(opts)).results;
}
