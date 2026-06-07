import { getDb } from '../db/client.js';
import { readYamlFile } from '../utils/yaml.js';
import { PREFERENCES_PATH } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

// ----- preference types -----------------------------------------------------

export interface Preferences {
  preferred_titles: string[];
  preferred_locations: {
    remote: boolean;
    cities: string[];
  };
  preferred_companies: string[];
  preferred_industries: string[];
  deal_breakers: {
    description: string;
    keywords: string[];
  };
  weights: Record<string, number>;
  tiers: Record<string, number>;
}

export interface ScoreResult {
  score: number;
  tier: string;
  reason: string;
}

/** Row shape as read from the jobs table. */
interface JobRow {
  id: number;
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
}

// ----- scoring logic --------------------------------------------------------

const DEFAULT_PREFS: Preferences = {
  preferred_titles: [],
  preferred_locations: { remote: true, cities: [] },
  preferred_companies: [],
  preferred_industries: [],
  deal_breakers: { description: '', keywords: [] },
  weights: {
    title_match: 0.35,
    location_match: 0.25,
    company_match: 0.15,
    industry_match: 0.20,
    description_quality: 0.05,
  },
  tiers: { A: 0.8, B: 0.65, C: 0.5, D: 0.0 },
};

function titleScore(title: string | null, preferred: string[]): number {
  if (!title || preferred.length === 0) return 0;
  const t = title.toLowerCase();
  const best = Math.max(
    ...preferred.map((p) => {
      const pl = p.toLowerCase();
      if (t === pl) return 1;
      if (t.includes(pl)) return 0.8;
      // Check word overlap
      const pWords = new Set(pl.split(/\s+/));
      const tWords = new Set(t.split(/\s+/));
      const intersection = [...pWords].filter((w) => tWords.has(w)).length;
      if (intersection === 0) return 0;
      return Math.min(1, intersection / pWords.size) * 0.6;
    }),
  );
  return best;
}

function locationScore(location: string | null, pref: Preferences['preferred_locations']): number {
  if (!location) return 0;
  const loc = location.toLowerCase();

  if (pref.remote) {
    if (loc.includes('remote') || loc.includes('anywhere')) return 1;
    if (loc.includes('united states') && !loc.includes('ca') && !loc.includes('ny')) return 0.6;
  }

  for (const city of pref.cities) {
    if (loc.includes(city.toLowerCase())) return 1;
  }

  return 0;
}

function companyScore(company: string | null, preferred: string[]): number {
  if (!company || preferred.length === 0) return 0;
  const c = company.toLowerCase();
  for (const p of preferred) {
    if (c.includes(p.toLowerCase())) return 1;
  }
  return 0;
}

function industryScore(description: string | null, preferred: string[]): number {
  if (!description || preferred.length === 0) return 0;
  const d = description.toLowerCase();
  for (const ind of preferred) {
    if (d.includes(ind.toLowerCase())) return 1;
  }
  return 0;
}

function descriptionQualityScore(description: string | null): number {
  if (!description) return 0;
  // Simple heuristic: longer, more structured descriptions are better
  const len = description.length;
  if (len > 2000) return 1;
  if (len > 1000) return 0.7;
  if (len > 500) return 0.4;
  if (len > 100) return 0.2;
  return 0;
}

function dealBreakerCheck(
  title: string | null,
  company: string | null,
  description: string | null,
  dealBreakers: Preferences['deal_breakers'],
): string[] {
  const triggered: string[] = [];
  if (dealBreakers.keywords.length === 0) return triggered;

  const haystack = [title, company, description].filter(Boolean).join(' ').toLowerCase();

  for (const kw of dealBreakers.keywords) {
    if (haystack.includes(kw.toLowerCase())) {
      triggered.push(kw);
    }
  }
  return triggered;
}

/** Score a single job row against preferences. */
export function scoreJob(job: JobRow, prefs: Preferences): ScoreResult {
  // Deal-breakers first
  const breakerKws = dealBreakerCheck(job.title, job.company, job.description, prefs.deal_breakers);
  if (breakerKws.length > 0) {
    return {
      score: 0,
      tier: 'D',
      reason: `Deal-breaker triggered: ${breakerKws.join(', ')}`,
    };
  }

  const w = prefs.weights;

  const tScore = titleScore(job.title, prefs.preferred_titles);
  const lScore = locationScore(job.location, prefs.preferred_locations);
  const cScore = companyScore(job.company, prefs.preferred_companies);
  const iScore = industryScore(job.description, prefs.preferred_industries);
  const qScore = descriptionQualityScore(job.description);

  const raw =
    tScore * (w.title_match ?? 0.35) +
    lScore * (w.location_match ?? 0.25) +
    cScore * (w.company_match ?? 0.15) +
    iScore * (w.industry_match ?? 0.20) +
    qScore * (w.description_quality ?? 0.05);

  const score = Math.round(raw * 1000) / 1000;

  // Tier
  const sortedTiers = Object.entries(prefs.tiers).sort((a, b) => b[1] - a[1]);
  let tier = 'D';
  for (const [t, threshold] of sortedTiers) {
    if (score >= threshold) {
      tier = t;
      break;
    }
  }

  // Reason
  const parts: string[] = [];
  if (tScore > 0) parts.push(`title(${tScore.toFixed(2)})`);
  if (lScore > 0) parts.push(`location(${lScore.toFixed(2)})`);
  if (cScore > 0) parts.push(`company(${cScore.toFixed(2)})`);
  if (iScore > 0) parts.push(`industry(${iScore.toFixed(2)})`);
  if (qScore > 0) parts.push(`description(${qScore.toFixed(2)})`);

  const reason = parts.length > 0 ? parts.join(' ') : 'insufficient data (placeholder job)';

  return { score, tier, reason };
}

// ----- batch scoring --------------------------------------------------------

export interface ScoreAllResult {
  scored: number;
  skipped: number;
}

/** Score all unscored jobs in the database. */
export function scoreAll(): ScoreAllResult {
  const prefs = readYamlFile<Preferences>(PREFERENCES_PATH, DEFAULT_PREFS);
  const db = getDb();

  const jobs = db.prepare(
    'SELECT id, title, company, location, description FROM jobs WHERE status != ?',
  ).all('archived') as JobRow[];

  if (jobs.length === 0) {
    logger.info('No jobs to score.');
    return { scored: 0, skipped: 0 };
  }

  const updateStmt = db.prepare(
    'UPDATE jobs SET score = ?, tier = ?, score_reason = ?, updated_at = datetime(\'now\') WHERE id = ?',
  );

  const tx = db.transaction(() => {
    for (const job of jobs) {
      const result = scoreJob(job, prefs);
      updateStmt.run(result.score, result.tier, result.reason, job.id);
    }
  });
  tx();

  logger.info(`Scored ${jobs.length} job(s).`);
  return { scored: jobs.length, skipped: 0 };
}
