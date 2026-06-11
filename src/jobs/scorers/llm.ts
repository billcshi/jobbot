import { readFileSync } from 'node:fs';
import { PROMPTS_DIR } from '../../utils/paths.js';
import { readCandidate, readPreferences } from '../../utils/profile-store.js';
import { getDeepseekKey, getDeepseekThinking } from '../../utils/config.js';
import { parseLLMJson } from '../../utils/parse-llm-json.js';
import { logAiCall, extractUsage } from '../../utils/ai-logger.js';
import { logger } from '../../utils/logger.js';
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

  const userId = getActiveUserId();
  const candidateInfo = [
    `## Candidate Profile`,
    '```yaml',
    readCandidate(userId),
    '```',
  ].join('\n');

  const prefsInfo = [
    `## Scoring Preferences`,
    '```yaml',
    readPreferences(userId),
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
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      const errMsg = `DeepSeek API error ${response.status}: ${body.slice(0, 200)}`;
      logAiCall({
        operation: 'score',
        model: 'deepseek-v4-flash',  // flash: no reasoning, faster, ideal for scoring
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

    const responseText = await response.text();
    let data: { choices: [{ message: { content: string; reasoning_content?: string } }]; usage?: Record<string, number> };
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(`DeepSeek returned non-JSON: ${responseText.slice(0, 300)}`);
    }
    const content = data.choices?.[0]?.message?.content;
    // v4-pro may return empty content with reasoning_content (max_tokens hit mid-reasoning)
    const reasoning = data.choices?.[0]?.message?.reasoning_content;
    if (!content && reasoning) {
      throw new Error(`DeepSeek reasoning exceeded token limit (reasoning: ${reasoning.slice(0, 200)}). Increase max_tokens.`);
    }
    if (!content) {
      throw new Error(`Empty response from DeepSeek (raw: ${responseText.slice(0, 300)})`);
    }

    const parsed = parseLLMJson(content, `score job #${job.id}`) as Record<string, any>; // LLM output is inherently untyped
    const usage = extractUsage(data as Record<string, unknown>);
    const result = {
      score: typeof parsed.score === 'number' ? parsed.score : 0,
      tier: parsed.tier || 'D',
      reason: parsed.reason || '',
    };

    logAiCall({
      operation: 'score',
      model: 'deepseek-v4-flash',  // flash: no reasoning, faster, ideal for scoring
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
