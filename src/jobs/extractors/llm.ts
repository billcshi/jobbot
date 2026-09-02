import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import { PROMPTS_DIR } from '../../utils/paths.js';
import { getDeepseekKey, getDeepseekModel, getDeepseekThinking } from '../../utils/config.js';
import { parseLLMJson } from '../../utils/parse-llm-json.js';
import { logAiCall, extractUsage } from '../../utils/ai-logger.js';
import { logger } from '../../utils/logger.js';
import { requestAiJson } from '../../utils/http-json.js';

const EXTRACT_PROMPT = readFileSync(`${PROMPTS_DIR}/extract-job.md`, 'utf-8');

export interface LlmSalary {
  low: number | null;
  high: number | null;
  currency: string;
}

export interface LlmExtractedJob {
  title: string;
  company: string;
  location: string;
  description: string;
  applyUrl: string;
  salary: LlmSalary | null;
  skills: string[];
}

/**
 * Strip HTML down to visible text, removing scripts, styles, and navigation.
 * Keeps the page content small enough for LLM extraction.
 */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html);

  // Remove non-content elements
  $('script, style, noscript, nav, footer, header, iframe, svg, img, link, meta').remove();

  // Try to focus on the main content area
  const main = $('main, article, #content, .posting, .job-description, [role="main"]');
  if (main.length > 0) {
    return main.first().text().replace(/\s+/g, ' ').trim();
  }

  return $('body').text().replace(/\s+/g, ' ').trim();
}

/**
 * Extract structured job data using DeepSeek LLM.
 */
export async function extractWithLLM(html: string, url: string, signal?: AbortSignal): Promise<LlmExtractedJob> {
  const text = htmlToText(html);
  const apiKey = getDeepseekKey();

  if (!apiKey) {
    throw new Error('DeepSeek API key not set. Add to local/config.yaml or set ANTHROPIC_AUTH_TOKEN env var.');
  }

  // Trim to 20k chars to stay within reasonable token limits
  const truncated = text.length > 20_000 ? text.slice(0, 20_000) : text;

  logger.debug(`LLM extraction: ${truncated.length} chars from ${url}`);

  const thinking = getDeepseekThinking('extract');
  const requestBody: Record<string, unknown> = {
    model: getDeepseekModel(),
    messages: [
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user', content: `Today's date: ${new Date().toISOString().split('T')[0]}\n\nURL: ${url}\n\nPage text:\n${truncated}` },
    ],
    max_tokens: 16384,
  };
  if (thinking) requestBody['thinking'] = thinking;

  const startMs = Date.now();
  let errorMsg: string | undefined;

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
    }, { signal, label: 'DeepSeek job extraction' });
      const data = request.data;
      const content = data.choices?.[0]?.message?.content;
      const reasoning = data.choices?.[0]?.message?.reasoning_content;
      if (!content && reasoning) {
        errorMsg = `DeepSeek reasoning exceeded token limit (reasoning: ${reasoning.slice(0, 200)})`;
      } else if (!content) {
        errorMsg = 'Empty response from DeepSeek';
      }
      if (content && data) {
        const parsed = parseLLMJson(content, `extract ${url.slice(0, 80)}`) as Record<string, any>; // LLM output is inherently untyped
        const usage = extractUsage(data as Record<string, unknown>);

        logAiCall({
          operation: 'extract',
          model: getDeepseekModel(),
          provider: 'deepseek',
          endpoint: 'https://api.deepseek.com/v1/chat/completions',
          requestSummary: `Extract job details from ${url} (${truncated.length} chars)`,
          responseSummary: `"${parsed.title}" at ${parsed.company} (${parsed.location})`,
          ...usage,
          durationMs: request.durationMs,
          success: true,
        });

        logger.debug(`LLM extracted: "${parsed.title}" at ${parsed.company}`);
        return {
          title: parsed.title || '',
          company: parsed.company || '',
          location: parsed.location || '',
          description: parsed.description || '',
          applyUrl: parsed.apply_url || url,
          salary: parsed.salary && typeof parsed.salary === 'object' && (parsed.salary.low != null || parsed.salary.high != null)
            ? {
                low: typeof parsed.salary.low === 'number' ? parsed.salary.low : null,
                high: typeof parsed.salary.high === 'number' ? parsed.salary.high : null,
                currency: parsed.salary.currency || 'USD',
              }
            : null,
          skills: Array.isArray(parsed.skills) ? parsed.skills.filter((s: unknown): s is string => typeof s === 'string') : [],
        };
      }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  // If we reach here, something failed
  logAiCall({
    operation: 'extract',
    model: getDeepseekModel(),
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    requestSummary: `Extract job details from ${url} (${truncated.length} chars)`,
    responseSummary: errorMsg || 'Unknown error',
    durationMs: Date.now() - startMs,
    success: false,
    error: errorMsg,
  });

  throw new Error(errorMsg || 'Extraction failed');
}
