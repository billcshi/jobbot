import { readFileSync } from 'node:fs';
import { PROMPTS_DIR } from '../../utils/paths.js';
import { CANDIDATE_PATH, PREFERENCES_PATH } from '../../utils/paths.js';
import { getDeepseekKey } from '../../utils/config.js';
import { logAiCall, extractUsage } from '../../utils/ai-logger.js';
import { logger } from '../../utils/logger.js';
import type { ScoreResult } from '../score.js';

const SCORE_PROMPT = readFileSync(`${PROMPTS_DIR}/score-job.md`, 'utf-8');

interface JobForScoring {
  id: number;
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
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

  const candidateInfo = [
    `## Candidate Profile`,
    '```yaml',
    readFileSync(CANDIDATE_PATH, 'utf-8'),
    '```',
  ].join('\n');

  const prefsInfo = [
    `## Scoring Preferences`,
    '```yaml',
    readFileSync(PREFERENCES_PATH, 'utf-8'),
    '```',
  ].join('\n');

  logger.debug(`Scoring job ${job.id} via LLM...`);

  const requestBody = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: SCORE_PROMPT },
      { role: 'user', content: [
        candidateInfo,
        '',
        prefsInfo,
        '',
        jobInfo,
        instruction ? `\n## Additional Instruction\n${instruction}` : '',
      ].filter(Boolean).join('\n') },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 2048,
  };

  const startMs = Date.now();

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const body = await response.text();
      const errMsg = `DeepSeek API error ${response.status}: ${body.slice(0, 200)}`;
      logAiCall({
        operation: 'score',
        model: 'deepseek-chat',
        provider: 'deepseek',
        endpoint: 'https://api.deepseek.com/v1/chat/completions',
        requestSummary: `Score job #${job.id} "${job.title}" at ${job.company}`,
        responseSummary: errMsg,
        durationMs: Date.now() - startMs,
        success: false,
        error: errMsg,
      });
      throw new Error(errMsg);
    }

    const data = (await response.json()) as {
      choices: [{ message: { content: string } }];
      usage?: Record<string, number>;
    };
    const content = data.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response from DeepSeek');

    const parsed = JSON.parse(content);
    const usage = extractUsage(data as Record<string, unknown>);
    const result = {
      score: typeof parsed.score === 'number' ? parsed.score : 0,
      tier: parsed.tier || 'D',
      reason: parsed.reason || '',
    };

    logAiCall({
      operation: 'score',
      model: 'deepseek-chat',
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Score job #${job.id} "${job.title}" at ${job.company}`,
      responseSummary: `${result.tier} (${result.score.toFixed(2)}) — ${result.reason.slice(0, 100)}`,
      ...usage,
      durationMs: Date.now() - startMs,
      success: true,
    });

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAiCall({
      operation: 'score',
      model: 'deepseek-chat',
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
