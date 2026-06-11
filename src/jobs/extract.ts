import { getDb } from '../db/client.js';
import { extractWithLLM } from './extractors/llm.js';
import { writeLLMSalary, writeLLMSkills } from './market-data.js';
import { logger } from '../utils/logger.js';

export interface ExtractResult {
  jobId: number;
  url: string;
  atsType: string;
  title: string;
  company: string;
  location: string;
  success: boolean;
  error?: string;
}

/**
 * Fetch and extract job details using LLM (DeepSeek).
 * Works on any ATS — no per-platform parsers needed.
 */
export async function extractJob(jobId: number, signal?: AbortSignal): Promise<ExtractResult> {
  const db = getDb();
  const job = db.prepare('SELECT id, url, ats_type FROM jobs WHERE id = ?').get(jobId) as
    | { id: number; url: string; ats_type: string }
    | undefined;

  if (!job) {
    throw new Error(`Job not found: id=${jobId}`);
  }

  logger.info(`Fetching ${job.url}...`);

  let html: string;
  try {
    const res = await fetch(job.url, {
      headers: { 'User-Agent': 'JobBot/0.2 (personal job-search assistant)' },
      signal,
    });
    if (!res.ok) {
      const errMsg = `HTTP ${res.status}`;
      db.prepare('UPDATE jobs SET score_reason = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(`Extract failed: ${errMsg}`, jobId);
      return {
        jobId, url: job.url, atsType: job.ats_type,
        title: '', company: '', location: '',
        success: false, error: errMsg,
      };
    }
    html = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare('UPDATE jobs SET score_reason = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(`Extract failed: ${msg}`, jobId);
    return {
      jobId, url: job.url, atsType: job.ats_type,
      title: '', company: '', location: '',
      success: false, error: msg,
    };
  }

  // LLM extraction
  try {
    const extracted = await extractWithLLM(html, job.url, signal);

    db.prepare(
      `UPDATE jobs SET title = ?, company = ?, location = ?, description = ?, apply_url = ?, status = 'extracted', updated_at = datetime('now') WHERE id = ?`,
    ).run(extracted.title, extracted.company, extracted.location, extracted.description, extracted.applyUrl, jobId);

    // Write LLM-extracted salary and skills to market_data
    if (extracted.salary) {
      try {
        writeLLMSalary(jobId, extracted.salary, extracted.title, extracted.location);
        logger.debug(`Salary written for job #${jobId}`);
      } catch (err) {
        logger.warn(`Failed to write salary for job #${jobId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (extracted.skills.length > 0) {
      try {
        writeLLMSkills(jobId, extracted.skills);
        logger.debug(`${extracted.skills.length} skill(s) written for job #${jobId}`);
      } catch (err) {
        logger.warn(`Failed to write skills for job #${jobId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Log event
    db.prepare(
      "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (?, 'extract', ?, ?, datetime('now'))",
    ).run(jobId, `Extracted: "${extracted.title}" at ${extracted.company} (${extracted.location})`, JSON.stringify({ title: extracted.title, company: extracted.company, location: extracted.location }));

    logger.info(`Extracted: "${extracted.title}" at ${extracted.company} (${extracted.location})`);
    return {
      jobId, url: job.url, atsType: job.ats_type,
      title: extracted.title, company: extracted.company, location: extracted.location,
      success: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`LLM extraction failed for job ${jobId}: ${msg}`);
    db.prepare('UPDATE jobs SET score_reason = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(`Extract failed: ${msg}`, jobId);
    return {
      jobId, url: job.url, atsType: job.ats_type,
      title: '', company: '', location: '',
      success: false, error: msg,
    };
  }
}

/**
 * Extract all jobs that haven't been extracted yet (title IS NULL).
 */
export async function extractAll(): Promise<ExtractResult[]> {
  const db = getDb();
  const jobs = db.prepare('SELECT id FROM jobs WHERE title IS NULL').all() as { id: number }[];

  const results: ExtractResult[] = [];
  for (const job of jobs) {
    const result = await extractJob(job.id);
    results.push(result);
  }

  const succeeded = results.filter((r) => r.success).length;
  logger.info(`Extracted ${succeeded}/${results.length} job(s)`);
  return results;
}
