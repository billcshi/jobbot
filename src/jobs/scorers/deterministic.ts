/**
 * Deterministic job scoring — used as fallback when LLM is unavailable,
 * and for unit testing the scoring dimensions independently.
 */
import type { Preferences, ScoreResult } from '../score.js';

export function titleScore(title: string | null, preferred: string[]): number {
  if (!title || preferred.length === 0) return 0;
  const t = title.toLowerCase();
  const best = Math.max(
    ...preferred.map((p) => {
      const pl = p.toLowerCase();
      if (t === pl) return 1;
      if (t.includes(pl)) return 0.8;
      const pWords = new Set(pl.split(/\s+/));
      const tWords = new Set(t.split(/\s+/));
      const intersection = [...pWords].filter((w) => tWords.has(w)).length;
      if (intersection === 0) return 0;
      return Math.min(1, intersection / pWords.size) * 0.6;
    }),
  );
  return best;
}

export function locationScore(location: string | null, pref: Preferences['preferred_locations']): number {
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

export function companyScore(company: string | null, preferred: string[]): number {
  if (!company || preferred.length === 0) return 0;
  const c = company.toLowerCase();
  for (const p of preferred) {
    if (c.includes(p.toLowerCase())) return 1;
  }
  return 0;
}

export function industryScore(description: string | null, preferred: string[]): number {
  if (!description || preferred.length === 0) return 0;
  const d = description.toLowerCase();
  for (const ind of preferred) {
    if (d.includes(ind.toLowerCase())) return 1;
  }
  return 0;
}

export function descriptionQualityScore(description: string | null): number {
  if (!description) return 0;
  const len = description.length;
  if (len > 2000) return 1;
  if (len > 1000) return 0.7;
  if (len > 500) return 0.4;
  if (len > 100) return 0.2;
  return 0;
}

export function dealBreakerCheck(
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

export interface JobRow {
  id: number;
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
}

/** Full deterministic score — used by tests and as CI fallback. */
export function scoreJobDeterministic(job: JobRow, prefs: Preferences): ScoreResult {
  const breakerKws = dealBreakerCheck(job.title, job.company, job.description, prefs.deal_breakers);
  if (breakerKws.length > 0) {
    return { score: 0, tier: 'D', reason: `Deal-breaker triggered: ${breakerKws.join(', ')}` };
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

  const sortedTiers = Object.entries(prefs.tiers).sort((a, b) => b[1] - a[1]);
  let tier = 'D';
  for (const [t, threshold] of sortedTiers) {
    if (score >= threshold) {
      tier = t;
      break;
    }
  }

  const parts: string[] = [];
  if (tScore > 0) parts.push(`title(${tScore.toFixed(2)})`);
  if (lScore > 0) parts.push(`location(${lScore.toFixed(2)})`);
  if (cScore > 0) parts.push(`company(${cScore.toFixed(2)})`);
  if (iScore > 0) parts.push(`industry(${iScore.toFixed(2)})`);
  if (qScore > 0) parts.push(`description(${qScore.toFixed(2)})`);

  const reason = parts.length > 0 ? parts.join(' ') : 'insufficient data (placeholder job)';
  return { score, tier, reason };
}
