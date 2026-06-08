import { getDb } from '../db/client.js';
import { readFileSync } from 'node:fs';
import { PROMPTS_DIR, CANDIDATE_PATH } from '../utils/paths.js';
import { getDeepseekKey } from '../utils/config.js';
import { logAiCall, extractUsage } from '../utils/ai-logger.js';
import { logger } from '../utils/logger.js';

const TAILOR_PROMPT = readFileSync(`${PROMPTS_DIR}/tailor-resume.md`, 'utf-8');

export interface TailorResult {
  success: boolean;
  jobId: number;
  versionName?: string;
  summary?: string;
  error?: string;
}

interface LlmTailorOutput {
  summary: string;
  selected_experience: {
    company: string;
    title: string;
    start: string;
    end: string | null;
    highlights: string[];
  }[];
  selected_skills: {
    languages?: string[];
    frameworks?: string[];
    infrastructure?: string[];
    databases?: string[];
  };
  keyword_adjustments: {
    original: string;
    adjusted: string;
    reason: string;
  }[];
}

/**
 * Tailor a resume for a specific job using DeepSeek LLM.
 *
 * Reads the job description + candidate profile, sends to LLM,
 * and writes the tailored resume data to the resume_versions table.
 *
 * @param jobId Job to tailor for
 * @param auditFeedback Optional JSON string from a previous audit failure.
 *   When provided, it's injected into the prompt so the LLM can fix specific issues.
 */
export async function tailorJob(jobId: number, auditFeedback?: string): Promise<TailorResult> {
  const db = getDb();
  const job = db.prepare(
    'SELECT id, title, company, location, description FROM jobs WHERE id = ?',
  ).get(jobId) as {
    id: number; title: string | null; company: string | null;
    location: string | null; description: string | null;
  } | undefined;

  if (!job) {
    return { success: false, jobId, error: `Job not found: id=${jobId}` };
  }

  if (!job.description) {
    return { success: false, jobId, error: 'Job has no description. Extract first.' };
  }

  const apiKey = getDeepseekKey();
  if (!apiKey) {
    return { success: false, jobId, error: 'DeepSeek API key not set. Add to local/config.yaml or set ANTHROPIC_AUTH_TOKEN env var.' };
  }

  // Read candidate profile
  let candidateYaml: string;
  try {
    candidateYaml = readFileSync(CANDIDATE_PATH, 'utf-8');
  } catch {
    return { success: false, jobId, error: 'Candidate profile not found. Run init-db first.' };
  }

  const jobInfo = [
    `## Job Posting`,
    `Title: ${job.title || 'Unknown'}`,
    `Company: ${job.company || 'Unknown'}`,
    `Location: ${job.location || 'Unknown'}`,
    ``,
    `Description:`,
    `${(job.description || '').slice(0, 10_000)}`,
  ].join('\n');

  logger.info(`Tailoring resume for job #${jobId}: "${job.title}" at ${job.company}...`);

  const userMessage = [
    jobInfo,
    '',
    '## Candidate Profile',
    '```yaml',
    candidateYaml,
    '```',
    auditFeedback ? [
      '',
      '## Previous Audit Feedback (FIX THESE ISSUES)',
      'The previous resume was audited and failed. You MUST address these issues:',
      '```json',
      auditFeedback,
      '```',
      'Fix every issue listed above while staying truthful to the candidate profile.',
    ].join('\n') : '',
  ].filter(Boolean).join('\n');

  const requestBody = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: TAILOR_PROMPT },
      { role: 'user', content: userMessage },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 4096,
  };

  const startMs = Date.now();
  let llmOutput: LlmTailorOutput;

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
      throw new Error(`DeepSeek API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices: [{ message: { content: string } }];
      usage?: Record<string, number>;
    };
    const content = data.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response from DeepSeek');

    llmOutput = JSON.parse(content) as LlmTailorOutput;
    const usage = extractUsage(data as Record<string, unknown>);

    logAiCall({
      operation: 'tailor',
      model: 'deepseek-chat',
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Tailor resume for job #${jobId} "${job.title}" at ${job.company}${auditFeedback ? ' (audit retry)' : ''}`,
      responseSummary: `${llmOutput.selected_experience.length} positions, summary ${llmOutput.summary.length} chars`,
      ...usage,
      durationMs: Date.now() - startMs,
      success: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Tailor LLM failed for job ${jobId}: ${msg}`);
    logAiCall({
      operation: 'tailor',
      model: 'deepseek-chat',
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Tailor resume for job #${jobId}`,
      responseSummary: msg,
      durationMs: Date.now() - startMs,
      success: false,
      error: msg,
    });
    return { success: false, jobId, error: msg };
  }

  // Validate output
  if (!llmOutput.summary || !llmOutput.selected_experience || llmOutput.selected_experience.length === 0) {
    return { success: false, jobId, error: 'LLM returned incomplete tailor data (missing summary or experience)' };
  }

  // Serialize to YAML for storage
  const versionName = `tailored-v1-${Date.now()}`;
  const yaml = await import('js-yaml');
  const yamlData = yaml.dump(llmOutput);

  // Store in resume_versions + tailored YAML
  const { RESUMES_DIR } = await import('../utils/paths.js');
  const texPath = `${RESUMES_DIR}/${jobId}-resume.tex`;
  db.prepare(
    `INSERT OR REPLACE INTO resume_versions (job_id, version_name, tex_path, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).run(jobId, versionName, texPath);

  // Note: status change to 'composed' is handled by compose.ts.
  // When tailor is called standalone, we leave status as-is.
  db.prepare(
    "UPDATE jobs SET updated_at = datetime('now') WHERE id = ?",
  ).run(jobId);

  // Store the tailored YAML in local/resumes/
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(RESUMES_DIR, { recursive: true });
  writeFileSync(`${RESUMES_DIR}/${jobId}-tailored.yaml`, yamlData, 'utf-8');

  // Note: status change to 'composed' is handled by compose.ts.
  // When tailor is called standalone, we leave status as-is.

  return {
    success: true,
    jobId,
    versionName,
    summary: llmOutput.summary,
  };
}
