import { readFileSync } from 'node:fs';
import { PROMPTS_DIR } from '../../utils/paths.js';
import { readCandidate, readPreferences } from '../../utils/profile-store.js';
import { getDeepseekKey, getDeepseekThinking } from '../../utils/config.js';
import { parseLLMJson } from '../../utils/parse-llm-json.js';
import { logAiCall, extractUsage } from '../../utils/ai-logger.js';
import { logger } from '../../utils/logger.js';
import { requestAiJson } from '../../utils/http-json.js';
import { getActiveUserId } from '../../utils/user-context.js';
import type { ScoreResult } from '../score.js';

const SCORE_PROMPT = readFileSync(`${PROMPTS_DIR}/score-job.md`, 'utf-8');

interface JobForScoring {
  id: number;
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
}

const SCORE_FIELDS = new Set(['score', 'tier', 'reason']);
const SCORE_TIERS = ['A', 'B', 'C', 'D'] as const;
type ScoreTier = typeof SCORE_TIERS[number];

function tierForScore(score: number): ScoreTier {
  if (score >= 0.8) return 'A';
  if (score >= 0.65) return 'B';
  if (score >= 0.5) return 'C';
  return 'D';
}

/** Validate the untrusted JSON value returned by the scoring model. */
export function parseScoreResponse(value: unknown): ScoreResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid score response: expected an object');
  }
  const record = value as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((key) => !SCORE_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new Error(`Invalid score response: unknown field(s): ${unknownFields.join(', ')}`);
  }
  if (typeof record.score !== 'number' || !Number.isFinite(record.score)) {
    throw new Error('Invalid score response: score must be a finite number');
  }
  if (record.score < 0 || record.score > 1) {
    throw new Error('Invalid score response: score must be between 0 and 1');
  }
  if (typeof record.tier !== 'string' || !SCORE_TIERS.includes(record.tier as ScoreTier)) {
    throw new Error('Invalid score response: tier must be one of A, B, C, or D');
  }
  if (typeof record.reason !== 'string' || record.reason.trim().length === 0) {
    throw new Error('Invalid score response: reason must be a non-empty string');
  }
  const expectedTier = tierForScore(record.score);
  if (record.tier !== expectedTier) {
    throw new Error(
      `Invalid score response: tier ${record.tier} is inconsistent with score ${record.score} (expected ${expectedTier})`,
    );
  }
  return { score: record.score, tier: record.tier, reason: record.reason.trim() };
}

/**
 * Score a single job using DeepSeek LLM.
 *
 * Sends: candidate profile + preferences + job description → LLM
 * Returns: score, tier, reason, highlights, concerns
 */
export async function scoreJobWithLLM(
  job: JobForScoring,
  instruction?: string,
  signal?: AbortSignal,
  userId?: number,
): Promise<ScoreResult> {
  const apiKey = getDeepseekKey();
  if (!apiKey) {
    throw new Error('DeepSeek API key not set. Add to local/config.yaml or set ANTHROPIC_AUTH_TOKEN env var.');
  }

  // Build the user message
  const jobInfo = [
    `## Job Posting`,
    `Title: ${job.title || 'Unknown'}`,
    `Company: ${job.company || 'Unknown'}`,
    `Location: ${job.location || 'Unknown'}`,
    ``,
    `Description:`,
    `${(job.description || '').slice(0, 10_000)}`,
  ].join('\n');

  // Explicit profile identity is used by application services. The fallback
  // keeps the public function compatible with legacy CLI callers.
  const resolvedUserId = userId ?? getActiveUserId();
  const candidateInfo = [
    `## Candidate Profile`,
    '```yaml',
    readCandidate(resolvedUserId),
    '```',
  ].join('\n');

  const prefsInfo = [
    `## Scoring Preferences`,
    '```yaml',
    readPreferences(resolvedUserId),
    '```',
  ].join('\n');

  logger.debug(`Scoring job ${job.id} via LLM...`);

  const thinking = getDeepseekThinking('score');
  const requestBody: Record<string, unknown> = {
    model: 'deepseek-v4-flash',  // flash: no reasoning, faster, ideal for scoring
    messages: [
      { role: 'system', content: SCORE_PROMPT },
      { role: 'user', content: [
        `Today's date: ${new Date().toISOString().split('T')[0]}`,
        '',
        candidateInfo,
        '',
        prefsInfo,
        '',
        jobInfo,
        instruction ? `\n## Additional Instruction\n${instruction}` : '',
      ].filter(Boolean).join('\n') },
    ],
    max_tokens: 8192,
  };
  if (thinking) requestBody['thinking'] = thinking;

  const startMs = Date.now();

  try {
    const request = await requestAiJson<{
      choices: [{ message: { content: string; reasoning_content?: string } }];
      usage?: Record<string, number>;
    }>('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    }, { signal, label: 'DeepSeek job scoring' });
    const data = request.data;
    const content = data.choices?.[0]?.message?.content;
    // v4-pro may return empty content with reasoning_content (max_tokens hit mid-reasoning)
    const reasoning = data.choices?.[0]?.message?.reasoning_content;
    if (!content && reasoning) {
      throw new Error(`DeepSeek reasoning exceeded token limit (reasoning: ${reasoning.slice(0, 200)}). Increase max_tokens.`);
    }
    if (!content) {
      throw new Error('Empty response from DeepSeek');
    }

    const parsed = parseLLMJson(content, `score job #${job.id}`);
    const usage = extractUsage(data as Record<string, unknown>);
    const result = parseScoreResponse(parsed);

    logAiCall({
      operation: 'score',
      model: 'deepseek-v4-flash',  // flash: no reasoning, faster, ideal for scoring
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Score job #${job.id} "${job.title}" at ${job.company}`,
      responseSummary: `${result.tier} (${result.score.toFixed(2)}) — ${result.reason.slice(0, 100)}`,
      ...usage,
      durationMs: request.durationMs,
      success: true,
    });

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAiCall({
      operation: 'score',
      model: 'deepseek-v4-flash',  // flash: no reasoning, faster, ideal for scoring
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Score job #${job.id} "${job.title}" at ${job.company}`,
      responseSummary: msg,
      durationMs: Date.now() - startMs,
      success: false,
      error: msg,
    });
    throw err;
  }
}
