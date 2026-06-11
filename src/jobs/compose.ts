import { existsSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tailorJob } from './tailor.js';
import { renderJob } from './render.js';
import { getDb } from '../db/client.js';
import { jobResumeDir } from '../utils/paths.js';
import { readCandidate } from '../utils/profile-store.js';
import { getActiveUserId } from '../utils/user-context.js';
import { logger } from '../utils/logger.js';

/**
 * Detect which resume variant to use based on job title keywords.
 * Reads available variants from the candidate profile.
 * Falls back to 'general' if no clear match or no variants defined.
 */
function detectResumeVariant(jobId: number): string {
  const db = getDb();
  const job = db.prepare('SELECT title, description FROM jobs WHERE id = ?').get(jobId) as
    | { title: string | null; description: string | null }
    | undefined;
  if (!job?.title) return 'general';

  const title = job.title.toLowerCase();
  const desc = (job.description || '').toLowerCase();

  // Try to load available variants from candidate profile
  let variants: string[] = [];
  try {
    const candidateYaml = readCandidate(getActiveUserId());
    if (candidateYaml) {
      // Look for resume_variants: section
      const match = candidateYaml.match(/^resume_variants:\s*\n((?:\s+-\s+.+\n?)*)/m);
      if (match?.[1]) {
        variants = [...match[1].matchAll(/-\s*(\S+)/g)].map((m) => m[1]!);
      }
    }
  } catch { /* ignore */ }

  // If no variants defined, return general
  if (variants.length === 0) return 'general';

  // Keyword matching
  const variantKeywords: Record<string, string[]> = {
    backend: ['backend', 'back end', 'back-end', 'api', 'server', 'database', 'aws', 'gcp', 'golang', 'python', 'java', 'rust', 'microservices', 'distributed'],
    'full-stack': ['full stack', 'fullstack', 'full-stack', 'frontend', 'front end', 'front-end', 'react', 'vue', 'angular'],
    frontend: ['frontend', 'front end', 'front-end', 'ui engineer', 'ux engineer', 'react', 'vue', 'angular', 'svelte'],
    ml: ['machine learning', 'ml engineer', 'data scientist', 'deep learning', 'llm', 'nlp', 'computer vision', 'ai engineer', 'pytorch', 'tensorflow'],
    devops: ['devops', 'sre', 'infrastructure', 'platform', 'kubernetes', 'docker', 'terraform', 'ci/cd'],
    mobile: ['ios', 'android', 'mobile', 'swift', 'kotlin', 'react native', 'flutter'],
  };

  const scores: Record<string, number> = {};
  for (const variant of variants) {
    const vk = variant.toLowerCase().replace(/_/g, '-');
    const keywords = variantKeywords[vk];
    if (!keywords) continue;

    let score = 0;
    for (const kw of keywords) {
      if (title.includes(kw)) score += 3;
      if (desc.includes(kw)) score += 1;
    }
    scores[variant] = score;
  }

  // Pick the highest-scoring variant with score > 0
  const sorted = Object.entries(scores)
    .filter(([, s]) => s > 0)
    .sort(([, a], [, b]) => b - a);

  if (sorted.length > 0 && sorted[0]![1] > 2) {
    return sorted[0]![0];
  }

  return 'general';
}

export interface ComposeResult {
  success: boolean;
  jobId: number;
  pdfPath?: string;
  error?: string;
}

/**
 * Compose a tailored resume and render it to PDF in one step.
 * Equivalent to: tailor --job <id> && render --job <id>
 *
 * Sets job status to 'composed' on success.
 *
 * @param jobId Job to compose for
 * @param variantName Optional resume variant name. Auto-selected from job title if not provided.
 */
export async function composeJob(jobId: number, variantName?: string, signal?: AbortSignal): Promise<ComposeResult> {
  const db = getDb();

  // Auto-select resume variant based on job title keywords
  const resolvedVariant = variantName ?? detectResumeVariant(jobId);
  if (resolvedVariant && resolvedVariant !== 'general') {
    logger.info(`Using resume variant: ${resolvedVariant} for job #${jobId}`);
  }
  logger.info(`Composing resume for job #${jobId}...`);

  // Check for previous audit feedback (retry loop).
  // Consume and delete the feedback — it's a one-time message from audit.
  // If audit fails again, it writes a fresh one. If a human triggered
  // re-compose, the old counter is cleared naturally.
  const feedbackPath = `${jobResumeDir(jobId)}/audit-feedback.json`;
  let auditFeedback: string | undefined;
  let composeVersion = 1;
  if (existsSync(feedbackPath)) {
    try {
      const fb = JSON.parse(readFileSync(feedbackPath, 'utf-8'));
      composeVersion = (fb.attempt || 0) + 1;
      console.log(`↻ Retry v${composeVersion}: using audit feedback (attempt ${fb.attempt || '?'}, score ${fb.score}/100, ${fb.issues?.length || 0} issues)`);
      auditFeedback = JSON.stringify(fb, null, 2);
    } catch {
      // Corrupt feedback — ignore
    }
    // Keep the feedback file — audit will overwrite it with updated attempt counter.
    // We just read the attempt number for versioning purposes.
  }

  // Read previous tailored output so the LLM can make targeted edits on retries
  let previousOutput: string | undefined;
  if (auditFeedback) {
    const prevYaml = `${jobResumeDir(jobId)}/tailored.yaml`;
    if (existsSync(prevYaml)) {
      try { previousOutput = readFileSync(prevYaml, 'utf-8'); } catch { /* ignore */ }
    }
  }

  // Step 1: Customize (with optional audit feedback, previous output, variant, and version)
  const tailorResult = await tailorJob(jobId, auditFeedback, resolvedVariant, signal, composeVersion, previousOutput);
  if (!tailorResult.success) {
    return { success: false, jobId, error: `Customize failed: ${tailorResult.error}` };
  }
  console.log(`✓ Customized: ${tailorResult.versionName}${resolvedVariant && resolvedVariant !== 'general' ? ` (${resolvedVariant} variant)` : ''}`);

  // Step 2: Render
  const renderResult = await renderJob(jobId);
  if (!renderResult.success) {
    return { success: false, jobId, error: `Render failed: ${renderResult.error}` };
  }
  console.log(`✓ PDF: ${renderResult.pdfPath}`);

  // Auto-generate cover letter (with version for debug prompts)
  try {
    const { generateCoverLetter } = await import('./cover-letter.js');
    const cl = await generateCoverLetter(jobId, 'professional', composeVersion);
    if (cl.success) {
      console.log(`✓ Cover letter: ${cl.pdfPath}`);
    }
  } catch {
    // Cover letter is optional — don't block compose
  }

  // Save versioned copies so user can compare iterations
  const dir = jobResumeDir(jobId);
  mkdirSync(dir, { recursive: true });
  const v = composeVersion;
  const suffix = `-v${v}`;
  copyFileSync(`${dir}/tailored.yaml`, `${dir}/tailored${suffix}.yaml`);
  copyFileSync(`${dir}/resume.tex`, `${dir}/resume${suffix}.tex`);
  copyFileSync(`${dir}/resume.pdf`, `${dir}/resume${suffix}.pdf`);
  if (existsSync(`${dir}/cover-letter.tex`)) {
    copyFileSync(`${dir}/cover-letter.tex`, `${dir}/cover-letter${suffix}.tex`);
  }
  if (existsSync(`${dir}/cover-letter.pdf`)) {
    copyFileSync(`${dir}/cover-letter.pdf`, `${dir}/cover-letter${suffix}.pdf`);
  }
  console.log(`  📁 Saved versioned copies as *${suffix}.* in ${dir}/`);

  // Set unified status
  db.prepare(
    "UPDATE jobs SET status = 'composed', updated_at = datetime('now') WHERE id = ?",
  ).run(jobId);

  // Log event
  db.prepare(
    "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (?, 'compose', ?, ?, datetime('now'))",
  ).run(jobId, `PDF: ${renderResult.pdfPath}`, JSON.stringify({ pdfPath: renderResult.pdfPath }));

  return { success: true, jobId, pdfPath: renderResult.pdfPath };
}
