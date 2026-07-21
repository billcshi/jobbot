import { logger } from '../utils/logger.js';
import type { AppContext } from '../utils/app-context.js';
import { legacyAppContext } from '../utils/app-context.js';
import { createDefaultPipeline } from '../application/pipeline/default-pipeline.js';

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

// ----- batch scoring --------------------------------------------------------

export interface ScoreAllResult {
  scored: number;
  skipped: number;
}

/**
 * Score all jobs using DeepSeek LLM.
 * Jobs with descriptions get full LLM evaluation.
 * Placeholder jobs (no description) get a bare-minimum fallback score.
 *
 * Scores are written to user_scores per user. The jobs summary columns are
 * updated at the same time for list and dashboard queries.
 */
export async function scoreAll(context: AppContext = legacyAppContext()): Promise<ScoreAllResult> {
  const summary = await createDefaultPipeline(context, { log: (message) => logger.info(message) })
    .runStage('score');
  const skipped = summary.failed + summary.cancelled + summary.skipped;
  logger.info(`Scored ${summary.succeeded} job(s) via LLM, ${skipped} failed/skipped.`);
  return { scored: summary.succeeded, skipped };
}
