import { readFileSync } from 'node:fs';
import { PROMPTS_DIR } from '../../utils/paths.js';
import { CANDIDATE_PATH, PREFERENCES_PATH } from '../../utils/paths.js';
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
): Promise<ScoreResult> {
  const apiKey = process.env['ANTHROPIC_AUTH_TOKEN'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_AUTH_TOKEN not set');
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

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: SCORE_PROMPT },
        { role: 'user', content: `${candidateInfo}\n\n${prefsInfo}\n\n${jobInfo}` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices: [{ message: { content: string } }];
  };
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error('Empty response from DeepSeek');

  const parsed = JSON.parse(content);

  return {
    score: typeof parsed.score === 'number' ? parsed.score : 0,
    tier: parsed.tier || 'D',
    reason: parsed.reason || '',
  };
}
