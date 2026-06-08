import { existsSync, readFileSync } from 'node:fs';
import { tailorJob } from './tailor.js';
import { renderJob } from './render.js';
import { getDb } from '../db/client.js';
import { RESUMES_DIR } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

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
 */
export async function composeJob(jobId: number): Promise<ComposeResult> {
  const db = getDb();
  logger.info(`Composing resume for job #${jobId}...`);

  // Check for previous audit feedback (retry loop)
  const feedbackPath = `${RESUMES_DIR}/${jobId}-audit-feedback.json`;
  let auditFeedback: string | undefined;
  if (existsSync(feedbackPath)) {
    try {
      const fb = JSON.parse(readFileSync(feedbackPath, 'utf-8'));
      console.log(`↻ Retry: using audit feedback (score ${fb.score}/100, ${fb.issues.length} issues)`);
      auditFeedback = JSON.stringify(fb, null, 2);
    } catch {
      // Corrupt feedback — ignore
    }
  }

  // Step 1: Tailor (with optional audit feedback)
  const tailorResult = await tailorJob(jobId, auditFeedback);
  if (!tailorResult.success) {
    return { success: false, jobId, error: `Tailor failed: ${tailorResult.error}` };
  }
  console.log(`✓ Tailored: ${tailorResult.versionName}`);

  // Step 2: Render
  const renderResult = await renderJob(jobId);
  if (!renderResult.success) {
    return { success: false, jobId, error: `Render failed: ${renderResult.error}` };
  }
  console.log(`✓ PDF: ${renderResult.pdfPath}`);

  // Auto-generate cover letter
  try {
    const { generateCoverLetter } = await import('./cover-letter.js');
    const cl = await generateCoverLetter(jobId);
    if (cl.success) {
      console.log(`✓ Cover letter: ${cl.pdfPath}`);
    }
  } catch {
    // Cover letter is optional — don't block compose
  }

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
