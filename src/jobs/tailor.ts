import { getDb } from '../db/client.js';
import { readFileSync } from 'node:fs';
import { PROMPTS_DIR } from '../utils/paths.js';
import { readCandidate } from '../utils/profile-store.js';
import { getActiveUserId } from '../utils/user-context.js';
import { getDeepseekKey, getDeepseekModel, getDeepseekThinking } from '../utils/config.js';
import { parseLLMJson } from '../utils/parse-llm-json.js';
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
    data_processing?: string[];
  };
  keyword_adjustments?: {
    original: string;
    adjusted: string;
    reason: string;
  }[];
  selected_projects?: {
    name: string;
    highlights: string[];
    technologies: string[];
  }[];
}

/**
 * Customize a resume for a specific job using DeepSeek LLM.
 *
 * Reads the job description + candidate profile, sends to LLM,
 * and writes the customized resume data to the resume_versions table.
 *
 * @param jobId Job to customize for
 * @param auditFeedback Optional JSON string from a previous audit failure.
 *   When provided, it's injected at the TOP of the prompt so the LLM prioritizes fixes.
 * @param variant Optional resume variant name (e.g., "backend", "full-stack").
 *   When provided, the LLM customizes the resume with that focus.
 * @param version Optional compose version number. When provided, the full LLM
 *   prompt is written to <jobResumeDir>/tailor-prompt-v<version>.txt for debugging.
 * @param previousOutput Optional YAML string of the previous tailored output.
 *   When provided (retry), the LLM can see what it produced before and make
 *   targeted edits instead of starting from scratch.
 */
export async function tailorJob(jobId: number, auditFeedback?: string, variant?: string, signal?: AbortSignal, version?: number, previousOutput?: string): Promise<TailorResult> {
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
    candidateYaml = readCandidate(getActiveUserId());
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

  const isRetry = !!auditFeedback;
  logger.info(`Customizing resume for job #${jobId}: "${job.title}" at ${job.company}${isRetry ? ' (retry with audit feedback)' : ''}...`);

  // Build user message — audit feedback goes FIRST so the LLM prioritizes it
  const userMessage = [
    `Today's date: ${new Date().toISOString().split('T')[0]}`,
    '',
    // Audit feedback at TOP — highest priority
    auditFeedback ? [
      '## ⚠️ PREVIOUS AUDIT FEEDBACK (ADDRESS EVERY ISSUE)',
      'The previous version of this resume failed audit. You MUST fix these specific issues in your output:',
      '```json',
      auditFeedback,
      '```',
      'Fix every issue listed above. This is the highest priority. Stay truthful to the candidate profile.',
      '',
    ].join('\n') : '',
    // Previous output so the LLM can see what it wrote and make targeted edits
    previousOutput ? [
      '## Your Previous Output (for reference)',
      'This is what you produced last time. The audit found issues with it (see feedback above).',
      'Make targeted edits — keep what worked, fix only what the audit flagged.',
      '```yaml',
      previousOutput,
      '```',
      '',
    ].join('\n') : '',
    jobInfo,
    '',
    variant && variant !== 'general' ? [
      '## Resume Variant',
      `Use the "${variant}" resume variant. Focus on experience and skills relevant to ${variant} roles.`,
      '',
    ].join('\n') : '',
    '## Candidate Profile',
    '```yaml',
    candidateYaml,
    '```',
  ].filter(Boolean).join('\n');

  const thinking = getDeepseekThinking('customize');
  const requestBody: Record<string, unknown> = {
    model: getDeepseekModel(),
    messages: [
      { role: 'system', content: TAILOR_PROMPT },
      { role: 'user', content: userMessage },
    ],
    max_tokens: isRetry ? 32768 : 16384,  // more tokens for retries to allow thorough fixes
  };
  if (thinking) requestBody['thinking'] = thinking;

  const startMs = Date.now();
  let llmOutput: LlmTailorOutput;

  // Log prompt for debugging when version is provided
  if (version !== undefined) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { jobResumeDir } = await import('../utils/paths.js');
    const dir = jobResumeDir(jobId);
    mkdirSync(dir, { recursive: true });
    const promptDump = [
      '=== SYSTEM PROMPT ===',
      TAILOR_PROMPT,
      '',
      '=== USER MESSAGE ===',
      userMessage,
    ].join('\n');
    writeFileSync(`${dir}/tailor-prompt-v${version}.txt`, promptDump, 'utf-8');
    console.log(`  📝 Wrote tailor prompt: ${dir}/tailor-prompt-v${version}.txt`);
  }

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
      throw new Error(`DeepSeek API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices: [{ message: { content: string } }];
      usage?: Record<string, number>;
    };
    const content = data.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response from DeepSeek');

    llmOutput = parseLLMJson(content, `tailor job #${jobId}`) as LlmTailorOutput;
    const usage = extractUsage(data as Record<string, unknown>);

    logAiCall({
      operation: 'customize',
      model: getDeepseekModel(),
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Customize resume for job #${jobId} "${job.title}" at ${job.company}${auditFeedback ? ' (audit retry)' : ''}`,
      responseSummary: `${llmOutput.selected_experience.length} positions, summary ${llmOutput.summary.length} chars`,
      ...usage,
      durationMs: Date.now() - startMs,
      success: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Tailor LLM failed for job ${jobId}: ${msg}`);
    logAiCall({
      operation: 'customize',
      model: getDeepseekModel(),
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Customize resume for job #${jobId}`,
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

  // Enforce reverse-chronological order (most recent first).
  // The LLM sometimes reorders by relevance; this guarantees correct date order.
  llmOutput.selected_experience.sort((a, b) => {
    const dateVal = (dateStr: string | undefined): number => {
      if (!dateStr) return 0;
      const s = dateStr.trim().toLowerCase();
      if (s === 'present') return Infinity; // current job → always first
      // Parse "Month YYYY" or "YYYY" into a comparable number
      const months: Record<string, number> = {
        january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
        july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
      };
      const m = s.match(/([a-z]+)\s+(\d{4})/i);
      if (m) return (parseInt(m[2]!, 10) * 100) + (months[m[1]!.toLowerCase()] || 0);
      const y = s.match(/(\d{4})/);
      if (y) return parseInt(y[1]!, 10) * 100;
      return 0;
    };
    return dateVal(b.start) - dateVal(a.start);
  });

  // Serialize to YAML for storage
  const versionName = `tailored-v1-${Date.now()}`;
  const yaml = await import('js-yaml');
  const yamlData = yaml.dump(llmOutput);

  // Store in resume_versions + tailored YAML
  const { jobResumeDir } = await import('../utils/paths.js');
  const texPath = `${jobResumeDir(jobId)}/resume.tex`;
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
  mkdirSync(jobResumeDir(jobId), { recursive: true });
  writeFileSync(`${jobResumeDir(jobId)}/tailored.yaml`, yamlData, 'utf-8');

  // Note: status change to 'composed' is handled by compose.ts.
  // When tailor is called standalone, we leave status as-is.

  return {
    success: true,
    jobId,
    versionName,
    summary: llmOutput.summary,
  };
}
