import { extractJob } from './extract.js';
import { composeJob } from './compose.js';
import { auditJob } from './audit.js';
import { getDb } from '../db/client.js';
import { logger } from '../utils/logger.js';

/** Delay helper — small pause between LLM calls to avoid rate limits. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----- per-stage batch runners ------------------------------------------------

/**
 * Extract all queued jobs (title IS NULL) with rate limiting.
 */
export async function runExtract(): Promise<void> {
  const db = getDb();
  const jobs = db.prepare('SELECT id FROM jobs WHERE title IS NULL').all() as { id: number }[];

  if (jobs.length === 0) {
    console.log('No queued jobs to extract.');
    return;
  }

  console.log(`Extracting ${jobs.length} job(s)...`);
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < jobs.length; i++) {
    console.log(`[${i + 1}/${jobs.length}] Extracting job #${jobs[i]!.id}...`);
    try {
      const result = await extractJob(jobs[i]!.id);
      if (result.success) {
        console.log(`  ✓ "${result.title}" at ${result.company}`);
        succeeded++;
      } else {
        console.log(`  ✕ Failed: ${result.error}`);
        failed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Extract job ${jobs[i]!.id}: ${msg}`);
      failed++;
    }

    if (i < jobs.length - 1) await delay(1500);
  }

  console.log(`\nExtract done: ${succeeded} succeeded, ${failed} failed.`);
}

/**
 * Score all extracted-but-unscored jobs.
 */
export async function runScore(): Promise<void> {
  const db = getDb();
  // Only score jobs that haven't been scored yet. score=0 is a valid result (deal-breaker).
  const jobs = db.prepare(
    'SELECT id FROM jobs WHERE title IS NOT NULL AND score IS NULL',
  ).all() as { id: number }[];

  if (jobs.length === 0) {
    console.log('No queued jobs to score.');
    return;
  }

  console.log(`Scoring ${jobs.length} job(s)...`);
  let scored = 0;
  let skipped = 0;

  for (let i = 0; i < jobs.length; i++) {
    const jobId = jobs[i]!.id;
    const job = db.prepare(
      'SELECT id, title, company, location, description FROM jobs WHERE id = ?',
    ).get(jobId) as {
      id: number; title: string | null; company: string | null;
      location: string | null; description: string | null;
    } | undefined;

    if (!job) continue;

    console.log(`[${i + 1}/${jobs.length}] Scoring job #${jobId}: "${job.title || 'Untitled'}"...`);
    try {
      const { scoreJobWithLLM } = await import('./scorers/llm.js');
      const result = await scoreJobWithLLM(job);
      db.prepare(
        "UPDATE jobs SET score = ?, tier = ?, score_reason = ?, status = 'scored', updated_at = datetime('now') WHERE id = ?",
      ).run(result.score, result.tier, result.reason, jobId);
      console.log(`  ✓ ${result.tier} (${result.score.toFixed(2)})`);
      scored++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Score job ${jobId}: ${msg}`);
      const { scoreJobDeterministic } = await import('./scorers/deterministic.js');
      const prefs = {
        preferred_titles: [],
        preferred_locations: { remote: false, cities: [] },
        preferred_companies: [],
        preferred_industries: [],
        deal_breakers: { description: '', keywords: [] },
        weights: {},
        tiers: { A: 0.8, B: 0.65, C: 0.5, D: 0 },
      };
      const fallback = scoreJobDeterministic(job, prefs);
      db.prepare(
        "UPDATE jobs SET score = ?, tier = ?, score_reason = ?, status = 'scored', updated_at = datetime('now') WHERE id = ?",
      ).run(fallback.score, fallback.tier, fallback.reason, jobId);
      console.log(`  ⚠ Fallback: ${fallback.tier} (${fallback.score.toFixed(2)})`);
      skipped++;
    }

    if (i < jobs.length - 1) await delay(1000);
  }

  console.log(`\nScore done: ${scored} LLM-scored, ${skipped} fallback.`);
}

/**
 * Compose (tailor + render) all scored jobs.
 */
export async function runCompose(): Promise<void> {
  const db = getDb();
  // Only compose jobs with real scores (exclude score=0 deal-breakers)
  const jobs = db.prepare(
    "SELECT id FROM jobs WHERE status = 'scored' AND score > 0 AND tier != 'D'",
  ).all() as { id: number }[];

  if (jobs.length === 0) {
    console.log('No queued jobs to compose.');
    return;
  }

  console.log(`Composing ${jobs.length} job(s)...`);
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < jobs.length; i++) {
    console.log(`[${i + 1}/${jobs.length}] Composing job #${jobs[i]!.id}...`);
    try {
      const result = await composeJob(jobs[i]!.id);
      if (result.success) {
        console.log(`  ✓ PDF: ${result.pdfPath}`);
        succeeded++;
      } else {
        console.log(`  ✕ Failed: ${result.error}`);
        failed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Compose job ${jobs[i]!.id}: ${msg}`);
      failed++;
    }

    if (i < jobs.length - 1) await delay(2000); // longer: tailor LLM + pdflatex
  }

  console.log(`\nCompose done: ${succeeded} succeeded, ${failed} failed.`);
}

// ----- audit with retry loop --------------------------------------------------

/** Max compose→audit retries before giving up. */
const MAX_AUDIT_RETRIES = 3;

/**
 * Audit all composed jobs. Failed audits loop back to compose automatically
 * up to MAX_AUDIT_RETRIES times.
 */
export async function runAudit(): Promise<void> {
  const db = getDb();
  const jobs = db.prepare(
    "SELECT id FROM jobs WHERE status = 'composed'",
  ).all() as { id: number }[];

  if (jobs.length === 0) {
    console.log('No queued jobs to audit.');
    return;
  }

  console.log(`Auditing ${jobs.length} job(s)...`);
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < jobs.length; i++) {
    const jobId = jobs[i]!.id;

    for (let attempt = 1; attempt <= MAX_AUDIT_RETRIES; attempt++) {
      const label = attempt > 1 ? ` (retry ${attempt}/${MAX_AUDIT_RETRIES})` : '';
      console.log(`[${i + 1}/${jobs.length}] Auditing job #${jobId}${label}...`);

      try {
        const result = await auditJob(jobId);
        if (!result.success) {
          console.log(`  ✕ Audit error: ${result.error}`);
          failed++;
          break;
        }

        // Check whether it passed the quality gate
        const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as
          | { status: string }
          | undefined;

        if (job?.status === 'audited') {
          console.log(`  ✓ PASSED (${result.overallScore}/100) — ready for apply`);
          passed++;
          break;
        }

        // Failed — status went back to 'scored'. Re-compose and try again.
        if (attempt < MAX_AUDIT_RETRIES) {
          console.log(`  ↻ Re-composing with audit feedback...`);
          await delay(1000);
          const composeResult = await composeJob(jobId);
          if (!composeResult.success) {
            console.log(`  ✕ Re-compose failed: ${composeResult.error}`);
            failed++;
            break;
          }
          await delay(2000);
        } else {
          console.log(`  ✕ FAILED after ${MAX_AUDIT_RETRIES} attempts — manual review needed`);
          failed++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Audit job ${jobId}: ${msg}`);
        failed++;
        break;
      }
    }

    if (i < jobs.length - 1) await delay(1500);
  }

  console.log(`\nAudit done: ${passed} passed, ${failed} failed.`);
}

// ----- full pipeline ----------------------------------------------------------

/**
 * Run the full pipeline: extract → score → compose → audit.
 */
export async function runAll(): Promise<void> {
  console.log('=== Pipeline: Extract ===\n');
  await runExtract();

  console.log('\n=== Pipeline: Score ===\n');
  await runScore();

  console.log('\n=== Pipeline: Compose ===\n');
  await runCompose();

  console.log('\n=== Pipeline: Audit ===\n');
  await runAudit();

  console.log('\n=== Pipeline Complete ===');
}

/**
 * Run the full pipeline for a single job.
 */
export async function runJob(jobId: number): Promise<void> {
  console.log(`=== Pipeline: Job #${jobId} ===\n`);

  // Extract
  console.log('--- Extract ---');
  const extractResult = await extractJob(jobId);
  if (!extractResult.success) {
    console.log(`Extract failed: ${extractResult.error}`);
    console.log('Pipeline stopped.');
    return;
  }
  console.log(`"${extractResult.title}" at ${extractResult.company} (${extractResult.location})`);
  await delay(1000);

  // Score
  console.log('\n--- Score ---');
  const db = getDb();
  const job = db.prepare(
    'SELECT id, title, company, location, description FROM jobs WHERE id = ?',
  ).get(jobId) as {
    id: number; title: string | null; company: string | null;
    location: string | null; description: string | null;
  } | undefined;

  if (!job) {
    console.log('Job not found after extraction.');
    return;
  }

  try {
    const { scoreJobWithLLM } = await import('./scorers/llm.js');
    const result = await scoreJobWithLLM(job);
    db.prepare(
      "UPDATE jobs SET score = ?, tier = ?, score_reason = ?, status = 'scored', updated_at = datetime('now') WHERE id = ?",
    ).run(result.score, result.tier, result.reason, jobId);
    console.log(`${result.tier} (${result.score.toFixed(2)}) — ${result.reason.slice(0, 120)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Score failed: ${msg}`);
    console.log('Pipeline stopped.');
    return;
  }
  await delay(1000);

  // Compose
  console.log('\n--- Compose ---');
  const composeResult = await composeJob(jobId);
  if (!composeResult.success) {
    console.log(`Compose failed: ${composeResult.error}`);
    console.log('Pipeline stopped.');
    return;
  }
  console.log(`PDF: ${composeResult.pdfPath}`);
  await delay(1000);

  // Audit (with retry loop)
  console.log('\n--- Audit ---');
  for (let attempt = 1; attempt <= MAX_AUDIT_RETRIES; attempt++) {
    if (attempt > 1) {
      console.log(`\nRetry ${attempt}/${MAX_AUDIT_RETRIES}...`);
      const reCompose = await composeJob(jobId);
      if (!reCompose.success) {
        console.log(`Re-compose failed: ${reCompose.error}`);
        break;
      }
      await delay(2000);
    }

    const auditResult = await auditJob(jobId);
    if (!auditResult.success) {
      console.log(`Audit error: ${auditResult.error}`);
      break;
    }

    const currentJob = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as
      | { status: string }
      | undefined;

    if (currentJob?.status === 'audited') {
      console.log(`\n✓ Passed audit (${auditResult.overallScore}/100) — ready for apply`);
      break;
    }

    if (attempt === MAX_AUDIT_RETRIES) {
      console.log(`\n✕ Failed audit after ${MAX_AUDIT_RETRIES} attempts — manual review needed`);
    }
  }

  console.log('\n=== Pipeline Complete ===');
}
