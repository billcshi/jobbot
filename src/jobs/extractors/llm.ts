import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import { PROMPTS_DIR } from '../../utils/paths.js';
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
  const apiKey = process.env['ANTHROPIC_AUTH_TOKEN'];

  if (!apiKey) {
    throw new Error('ANTHROPIC_AUTH_TOKEN not set in environment');
  }

  // Trim to 20k chars to stay within reasonable token limits
  const truncated = text.length > 20_000 ? text.slice(0, 20_000) : text;

  logger.debug(`LLM extraction: ${truncated.length} chars from ${url}`);

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: `URL: ${url}\n\nPage text:\n${truncated}` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4096,
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
  if (!content) {
    throw new Error('Empty response from DeepSeek');
  }

  const parsed = JSON.parse(content);
  logger.debug(`LLM extracted: "${parsed.title}" at ${parsed.company}`);

  return {
    title: parsed.title || '',
    company: parsed.company || '',
    location: parsed.location || '',
    description: parsed.description || '',
    applyUrl: parsed.apply_url || url,
  };
}
