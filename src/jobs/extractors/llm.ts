import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import { PROMPTS_DIR } from '../../utils/paths.js';
import { getDeepseekKey } from '../../utils/config.js';
import { logAiCall, extractUsage } from '../../utils/ai-logger.js';
import { logger } from '../../utils/logger.js';

const EXTRACT_PROMPT = readFileSync(`${PROMPTS_DIR}/extract-job.md`, 'utf-8');

export interface LlmExtractedJob {
  title: string;
  company: string;
  location: string;
  description: string;
  applyUrl: string;
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
export async function extractWithLLM(html: string, url: string): Promise<LlmExtractedJob> {
  const text = htmlToText(html);
  const apiKey = getDeepseekKey();

  if (!apiKey) {
    throw new Error('DeepSeek API key not set. Add to local/config.yaml or set ANTHROPIC_AUTH_TOKEN env var.');
  }

  // Trim to 20k chars to stay within reasonable token limits
  const truncated = text.length > 20_000 ? text.slice(0, 20_000) : text;

  logger.debug(`LLM extraction: ${truncated.length} chars from ${url}`);

  const requestBody = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user', content: `URL: ${url}\n\nPage text:\n${truncated}` },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 4096,
  };

  const startMs = Date.now();
  let errorMsg: string | undefined;

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
      errorMsg = `HTTP ${response.status}: ${body.slice(0, 200)}`;
    } else {
      const data = (await response.json()) as {
        choices: [{ message: { content: string } }];
        usage?: Record<string, number>;
      };

      const content = data.choices[0]?.message?.content;
      if (!content) {
        errorMsg = 'Empty response from DeepSeek';
      } else {
        const parsed = JSON.parse(content);
        const usage = extractUsage(data as Record<string, unknown>);

        logAiCall({
          operation: 'extract',
          model: 'deepseek-chat',
          provider: 'deepseek',
          endpoint: 'https://api.deepseek.com/v1/chat/completions',
          requestSummary: `Extract job details from ${url} (${truncated.length} chars)`,
          responseSummary: `"${parsed.title}" at ${parsed.company} (${parsed.location})`,
          ...usage,
          durationMs: Date.now() - startMs,
          success: true,
        });

        logger.debug(`LLM extracted: "${parsed.title}" at ${parsed.company}`);
        return {
          title: parsed.title || '',
          company: parsed.company || '',
          location: parsed.location || '',
          description: parsed.description || '',
          applyUrl: parsed.apply_url || url,
        };
      }
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  // If we reach here, something failed
  logAiCall({
    operation: 'extract',
    model: 'deepseek-chat',
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
