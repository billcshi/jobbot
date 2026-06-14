import { extractJob } from './extract.js';
import { composeJob } from './compose.js';
import { auditJob } from './audit.js';
import { getDb } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { extractMarketData } from './market-data.js';
import { asyncPool } from '../utils/async-pool.js';
import { getPipelineState, getPipelineManager, type PipelineStage } from './pipeline-state.js';
import { getActiveUserId } from '../utils/user-context.js';
import { getStageConcurrency, getConcurrency } from '../utils/config.js';

// ----- per-stage batch runners ------------------------------------------------

/**
 * Extract all queued jobs (title IS NULL) concurrently.
 * Default concurrency: 5.
 */
export async function runExtract(concurrency?: number, state = getPipelineState()): Promise<void> {
  const limit = concurrency ?? getStageConcurrency('extract');
  const db = getDb();
  const userId = getActiveUserId();
  const jobs = db.prepare('SELECT id FROM jobs WHERE title IS NULL AND user_id = ?').all(userId) as { id: number }[];

  if (jobs.length === 0) {
    console.log('No queued jobs to extract.');
    return;
  }

  state.startStage('extract', jobs.length);

  console.log(`Extracting ${jobs.length} job(s) (${limit} concurrent)...`);
  let succeeded = 0;
  let failed = 0;

  const results = await asyncPool(limit, jobs, async (job, _idx, _signal) => {
    const ctrl = state.taskStarted('extract', job.id);
    try {
      const result = await extractJob(job.id, ctrl.signal);
      if (result.success) {
        console.log(`  ✓ #${job.id}: "${result.title}" at ${result.company}`);
        state.updateTaskMeta('extract', job.id, { title: result.title, company: result.company });
        state.taskCompleted('extract', job.id);
        return 'ok';
      } else {
        console.log(`  ✕ #${job.id}: ${result.error}`);
        state.taskCompleted('extract', job.id);
        return 'fail';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.log(`  ⊘ #${job.id}: cancelled`);
        state.taskCancelled('extract', job.id);
        return 'cancelled';
      }
      if (ctrl.signal.aborted) {
        console.log(`  ⊘ #${job.id}: cancelled`);
        state.taskCancelled('extract', job.id);
        return 'cancelled';
      }
      logger.error(`Extract job ${job.id}: ${msg}`);
      state.taskCompleted('extract', job.id);
      return 'error';
    }
  });

  let cancelled = 0;
  for (const r of results) {
    if (r.skipped) { failed++; continue; }
    if (r.result === 'cancelled') cancelled++;
    else if (r.result === 'ok') succeeded++;
    else failed++;
  }

  state.finishStage('extract');
  const parts = [`${succeeded} succeeded`, `${failed} failed`];
  if (cancelled) parts.push(`${cancelled} cancelled`);
  console.log(`\nExtract done: ${parts.join(', ')}.`);
}

/**
 * Score all extracted-but-unscored jobs concurrently.
 * Default concurrency: 3.
 */
export async function runScore(concurrency?: number, state = getPipelineState()): Promise<void> {
  const limit = concurrency ?? getStageConcurrency('score');
  const db = getDb();
  const userId = getActiveUserId();
  // Only score jobs that haven't been scored yet. score=0 is a valid result (deal-breaker).
  const jobs = db.prepare(
    'SELECT id FROM jobs WHERE title IS NOT NULL AND score IS NULL AND user_id = ?',
  ).all(userId) as { id: number }[];

  if (jobs.length === 0) {
    console.log('No queued jobs to score.');
    return;
  }

  state.startStage('score', jobs.length);

  console.log(`Scoring ${jobs.length} job(s) (${limit} concurrent)...`);
  let scored = 0;
  let skipped = 0;
  let cancelled = 0;

  const results = await asyncPool(limit, jobs, async ({ id: jobId }, _idx, _signal) => {
    const job = db.prepare(
      'SELECT id, title, company, location, description FROM jobs WHERE id = ?',
    ).get(jobId) as {
      id: number; title: string | null; company: string | null;
      location: string | null; description: string | null;
    } | undefined;

    if (!job) { state.taskCompleted('score', jobId); return 'skip'; }

    const ctrl = state.taskStarted('score', jobId, { title: job.title ?? undefined, company: job.company ?? undefined });
    const userId = getActiveUserId();
    try {
      const { scoreJobWithLLM } = await import('./scorers/llm.js');
      const result = await scoreJobWithLLM(job, undefined, ctrl.signal);
      db.prepare(
        "UPDATE jobs SET score = ?, tier = ?, score_reason = ?, status = 'scored', updated_at = datetime('now') WHERE id = ?",
      ).run(result.score, result.tier, result.reason, jobId);
      // Per-user score
      db.prepare(
        "INSERT INTO user_scores (job_id, user_id, score, tier, score_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now')) ON CONFLICT(job_id, user_id) DO UPDATE SET score = excluded.score, tier = excluded.tier, score_reason = excluded.score_reason, updated_at = datetime('now')",
      ).run(jobId, userId, result.score, result.tier, result.reason);
      console.log(`  ✓ #${jobId}: ${result.tier} (${result.score.toFixed(2)})`);
      state.taskCompleted('score', jobId);

      // Extract market data from scored jobs
      extractMarketData(job);
      return 'scored';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if ((err instanceof DOMException && err.name === 'AbortError') || ctrl.signal.aborted) {
        console.log(`  ⊘ #${jobId}: cancelled`);
        state.taskCancelled('score', jobId);
        return 'cancelled';
      }
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
      db.prepare(
        "INSERT INTO user_scores (job_id, user_id, score, tier, score_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now')) ON CONFLICT(job_id, user_id) DO UPDATE SET score = excluded.score, tier = excluded.tier, score_reason = excluded.score_reason, updated_at = datetime('now')",
      ).run(jobId, userId, fallback.score, fallback.tier, fallback.reason);
      console.log(`  ⚠ #${jobId}: Fallback ${fallback.tier} (${fallback.score.toFixed(2)})`);
      state.taskCompleted('score', jobId);
      return 'fallback';
    }
  });

  for (const r of results) {
    if (r.skipped) { skipped++; continue; }
    if (r.result === 'scored') scored++;
    else if (r.result === 'fallback') skipped++;
    else if (r.result === 'cancelled') cancelled++;
    else skipped++;
  }

  const parts = [`${scored} LLM-scored`, `${skipped} fallback`];
  if (cancelled) parts.push(`${cancelled} cancelled`);
  console.log(`\nScore done: ${parts.join(', ')}.`);
}

/**
 * Compose (customize + render) all scored jobs concurrently.
 * Default concurrency: 2.
 */
export async function runCompose(concurrency?: number, state = getPipelineState()): Promise<void> {
  const limit = concurrency ?? getStageConcurrency('compose');
  const db = getDb();
  const userId = getActiveUserId();
  // Only compose A/B tier jobs (C requires manual action, D = deal-breakers)
  const jobs = db.prepare(
    "SELECT id FROM jobs WHERE status IN ('scored', 'audit_failed') AND score > 0 AND tier IN ('A', 'B') AND user_id = ?",
  ).all(userId) as { id: number }[];

  if (jobs.length === 0) {
    console.log('No queued jobs to compose.');
    return;
  }

  state.startStage('compose', jobs.length);

  console.log(`Composing ${jobs.length} job(s) (${limit} concurrent)...`);
  let succeeded = 0;
  let failed = 0;

  let cancelled = 0;
  const results = await asyncPool(limit, jobs, async ({ id: jobId }, _idx, _signal) => {
    const ctrl = state.taskStarted('compose', jobId);
    try {
      const result = await composeJob(jobId, undefined, ctrl.signal);
      if (result.success) {
        console.log(`  ✓ #${jobId}: ${result.pdfPath}`);
        state.taskCompleted('compose', jobId);
        return 'ok';
      } else {
        console.log(`  ✕ #${jobId}: ${result.error}`);
        state.taskCompleted('compose', jobId);
        return 'fail';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if ((err instanceof DOMException && err.name === 'AbortError') || ctrl.signal.aborted) {
        console.log(`  ⊘ #${jobId}: cancelled`);
        state.taskCancelled('compose', jobId);
        return 'cancelled';
      }
      logger.error(`Compose job ${jobId}: ${msg}`);
      state.taskCompleted('compose', jobId);
      return 'error';
    }
  });

  for (const r of results) {
    if (r.skipped) { failed++; continue; }
    if (r.result === 'cancelled') cancelled++;
    else if (r.result === 'ok') succeeded++;
    else failed++;
  }

  const parts = [`${succeeded} succeeded`, `${failed} failed`];
  if (cancelled) parts.push(`${cancelled} cancelled`);
  console.log(`\nCompose done: ${parts.join(', ')}.`);
}

// ----- audit with retry loop --------------------------------------------------

/** Max compose→audit retries before giving up. */
const MAX_AUDIT_RETRIES = 3;

/**
 * Audit all composed jobs concurrently.
 * Failed audits loop back to compose automatically
 * up to MAX_AUDIT_RETRIES times.
 * Default concurrency: 2.
 */
export async function runAudit(concurrency?: number, state = getPipelineState()): Promise<void> {
  const limit = concurrency ?? getStageConcurrency('audit');
  const db = getDb();
  const userId = getActiveUserId();
  const jobs = db.prepare(
    "SELECT id FROM jobs WHERE status = 'composed' AND user_id = ?",
  ).all(userId) as { id: number }[];

  if (jobs.length === 0) {
    console.log('No queued jobs to audit.');
    return;
  }

  state.startStage('audit', jobs.length);

  console.log(`Auditing ${jobs.length} job(s) (${limit} concurrent)...`);
  let passed = 0;
  let failed = 0;
  let cancelled = 0;

  const results = await asyncPool(limit, jobs, async ({ id: jobId }, _idx, _poolSignal) => {
    const ctrl = state.taskStarted('audit', jobId);

    for (let attempt = 1; attempt <= MAX_AUDIT_RETRIES; attempt++) {
      if (ctrl.signal.aborted) {
        state.taskCancelled('audit', jobId);
        return 'cancelled';
      }

      const label = attempt > 1 ? ` (retry ${attempt}/${MAX_AUDIT_RETRIES})` : '';
      console.log(`  Auditing job #${jobId}${label}...`);

      try {
        const result = await auditJob(jobId, ctrl.signal);
        if (!result.success) {
          console.log(`  ✕ #${jobId}: Audit error: ${result.error}`);
          state.taskCompleted('audit', jobId);
          return 'fail';
        }

        const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as
          | { status: string }
          | undefined;

        if (job?.status === 'audited') {
          console.log(`  ✓ #${jobId}: PASSED (${result.overallScore}/100) — ready for apply`);
          state.taskCompleted('audit', jobId);
          return 'pass';
        }

        if (attempt < MAX_AUDIT_RETRIES) {
          console.log(`  ↻ #${jobId}: Re-composing with audit feedback...`);
          const composeResult = await composeJob(jobId, undefined, ctrl.signal);
          if (!composeResult.success) {
            console.log(`  ✕ #${jobId}: Re-compose failed: ${composeResult.error}`);
            state.taskCompleted('audit', jobId);
            return 'fail';
          }
        } else {
          console.log(`  ✕ #${jobId}: FAILED after ${MAX_AUDIT_RETRIES} attempts — manual review needed`);
          state.taskCompleted('audit', jobId);
          return 'fail';
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if ((err instanceof DOMException && err.name === 'AbortError') || ctrl.signal.aborted) {
          console.log(`  ⊘ #${jobId}: cancelled`);
          state.taskCancelled('audit', jobId);
          return 'cancelled';
        }
        logger.error(`Audit job ${jobId}: ${msg}`);
        state.taskCompleted('audit', jobId);
        return 'error';
      }
    }

    state.taskCompleted('audit', jobId);
    return 'fail';
  });

  for (const r of results) {
    if (r.skipped) { failed++; continue; }
    if (r.result === 'cancelled') cancelled++;
    else if (r.result === 'pass') passed++;
    else failed++;
  }

  const auditParts = [`${passed} passed`, `${failed} failed`];
  if (cancelled) auditParts.push(`${cancelled} cancelled`);
  console.log(`\nAudit done: ${auditParts.join(', ')}.`);
}

// ----- full pipeline ----------------------------------------------------------

/**
 * Run the full pipeline: extract → score → compose → audit.
 */
/**
 * Run the full pipeline with per-job concurrency. Each job flows through
 * extract → score → compose → audit independently — as soon as one job
 * finishes compose, it immediately starts audit without waiting for others.
 */
/**
 * Resolve the current pipeline status of a job from the DB.
 * Returns the stage the job is waiting for, or 'done' if fully processed.
 */
function jobPipelineStage(db: ReturnType<typeof getDb>, jobId: number): 'extract' | 'score' | 'compose' | 'audit' | 'done' {
  const job = db.prepare('SELECT title, score, status FROM jobs WHERE id = ?').get(jobId) as
    { title: string | null; score: number | null; status: string } | undefined;
  if (!job) return 'done';
  if (!job.title) return 'extract';           // 'new' — needs extraction
  if (job.score === null) return 'score';      // 'extracted' — needs scoring
  if (job.status === 'scored') return 'compose'; // scored but not composed
  if (job.status === 'composed') return 'audit'; // composed but not audited
  if (job.status === 'audit_failed') return 'compose'; // audit failed — re-compose with feedback
  return 'done';                                // 'audited' or unknown
}

export async function runAll(state = getPipelineState()): Promise<void> {
  const db = getDb();
  const userId = getActiveUserId();
  // Include 'composed' so we can audit already-composed jobs
  const jobs = db.prepare(
    "SELECT id FROM jobs WHERE status IN ('new','extracted','scored','composed','audit_failed') AND user_id = ? ORDER BY id",
  ).all(userId) as { id: number }[];

  if (jobs.length === 0) {
    console.log('No jobs to process.');
    return;
  }

  // Check global concurrency capacity
  const capacity = getPipelineManager().checkCapacity(userId, jobs.length);
  if (!capacity.allowed) {
    console.log(`Blocked: ${capacity.reason}`);
    return;
  }
  const pipelineConcurrency = capacity.concurrency;
  const concurrencyConfig = getConcurrency();

  state.startPipeline();

  const stageOrder: PipelineStage[] = ['extract', 'score', 'compose', 'audit'];

  // Calculate per-stage totals: a job "needs" a stage if its entry point
  // is at or before that stage in the pipeline. Jobs starting at 'score'
  // don't need extract; jobs starting at 'compose' don't need extract or score.
  const stageTotals: Record<PipelineStage, number> = { extract: 0, score: 0, compose: 0, audit: 0 };
  for (const { id: jobId } of jobs) {
    const ss = jobPipelineStage(db, jobId);
    if (ss === 'done') continue;
    const ssIdx = stageOrder.indexOf(ss);
    for (let i = ssIdx; i < stageOrder.length; i++) {
      stageTotals[stageOrder[i]!]!++;
    }
  }

  for (const stage of stageOrder) {
    state.startStage(stage, stageTotals[stage]!);
  }

  // Pre-mark already-completed stages for each job
  for (const { id: jobId } of jobs) {
    const startStage = jobPipelineStage(db, jobId);
    // Look up job title/company for task pool display metadata
    const jobMeta = db.prepare('SELECT title, company FROM jobs WHERE id = ?').get(jobId) as
      { title: string | null; company: string | null } | undefined;
    const meta = { title: jobMeta?.title ?? undefined, company: jobMeta?.company ?? undefined };
    for (const stage of stageOrder) {
      if (stage === startStage) break; // this stage and later ones need to run
      // This stage is already done — mark it completed in the tracker
      state.taskStarted(stage, jobId, meta);
      state.taskCompleted(stage, jobId);
    }
  }

  console.log(`Pipeline: ${jobs.length} job(s) (${pipelineConcurrency} concurrent, global cap: ${concurrencyConfig.global}, per-user: ${concurrencyConfig.per_user})`);

  let extracted = 0, scored = 0, composed = 0, audited = 0;
  let skipped = 0;
  let alreadyDone = 0;

  const { scoreJobWithLLM } = await import('./scorers/llm.js');
  const { scoreJobDeterministic } = await import('./scorers/deterministic.js');

  await asyncPool(pipelineConcurrency, jobs, async ({ id: jobId }, _idx, _poolSignal) => {
    // Determine where this job starts in the pipeline
    const startStage = jobPipelineStage(db, jobId);
    if (startStage === 'done') { alreadyDone++; return 'already-done'; }

    // --- Extract ---
    if (startStage === 'extract') {
      const extractCtrl = state.taskStarted('extract', jobId);
      let extractOk = false;
      for (let retry = 0; retry < 2; retry++) {
        if (extractCtrl.signal.aborted) break;
        try {
          const extractResult = await extractJob(jobId, extractCtrl.signal);
          if (extractResult.success) {
            console.log(`  ✓ #${jobId} extract: "${extractResult.title}" at ${extractResult.company}`);
            state.updateTaskMeta('extract', jobId, { title: extractResult.title, company: extractResult.company });
            extractOk = true;
            break;
          }
          const transient = extractResult.error && (
            extractResult.error.includes('Empty response') ||
            extractResult.error.includes('Unterminated string') ||
            extractResult.error.includes('Unexpected end of JSON') ||
            extractResult.error.includes('HTTP 5') ||
            extractResult.error.includes('fetch failed')
          );
          if (transient && retry < 1) {
            console.log(`  ↻ #${jobId} extract retry ${retry + 1}: ${extractResult.error}`);
            continue;
          }
          console.log(`  ✕ #${jobId} extract: ${extractResult.error}`);
          break;
        } catch (err: any) {
          if (err?.name === 'AbortError' || extractCtrl.signal.aborted) break;
          if (retry < 1) { console.log(`  ↻ #${jobId} extract retry ${retry + 1}: ${err?.message || err}`); continue; }
          logger.error(`Extract job ${jobId}: ${err?.message || err}`);
          break;
        }
      }
      if (extractOk) {
        state.taskCompleted('extract', jobId);
        extracted++;
      } else if (extractCtrl.signal.aborted) {
        state.taskCancelled('extract', jobId); skipped++; return 'cancelled';
      } else {
        state.taskFailed('extract', jobId); skipped++; return 'error';
      }
    } else {
      console.log(`  - #${jobId} extract: already done, skipping`);
    }

    // --- Score ---
    const job = db.prepare(
      'SELECT id, title, company, location, description, score FROM jobs WHERE id = ?',
    ).get(jobId) as { id: number; title: string | null; company: string | null; location: string | null; description: string | null; score: number | null; } | undefined;

    if (!job) { skipped++; return 'skip'; }

    if (job.score === null) {
      const scoreCtrl = state.taskStarted('score', jobId, { title: job.title ?? undefined, company: job.company ?? undefined });
      let scoreOk = false;
      for (let retry = 0; retry < 2; retry++) {
        if (scoreCtrl.signal.aborted) break;
        try {
          const scoreResult = await scoreJobWithLLM(job, undefined, scoreCtrl.signal);
          db.prepare(
            "UPDATE jobs SET score = ?, tier = ?, score_reason = ?, status = 'scored', updated_at = datetime('now') WHERE id = ?",
          ).run(scoreResult.score, scoreResult.tier, scoreResult.reason, jobId);
          db.prepare(
            "INSERT INTO user_scores (job_id, user_id, score, tier, score_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now')) ON CONFLICT(job_id, user_id) DO UPDATE SET score = excluded.score, tier = excluded.tier, score_reason = excluded.score_reason, updated_at = datetime('now')",
          ).run(jobId, userId, scoreResult.score, scoreResult.tier, scoreResult.reason);
          console.log(`  ✓ #${jobId} score: ${scoreResult.tier} (${scoreResult.score.toFixed(2)})`);
          scoreOk = true;
          break;
        } catch (err: any) {
          if (err?.name === 'AbortError') break;
          const msg = err?.message || String(err);
          const transient = msg.includes('Empty response') || msg.includes('fetch failed');
          if (transient && retry < 1) {
            console.log(`  ↻ #${jobId} score retry ${retry + 1}: ${msg}`);
            continue;
          }
          const prefs = { preferred_titles: [], preferred_locations: { remote: false, cities: [] }, preferred_companies: [], preferred_industries: [], deal_breakers: { description: '', keywords: [] }, weights: {}, tiers: { A: 0.8, B: 0.65, C: 0.5, D: 0 } };
          const fallback = scoreJobDeterministic(job, prefs);
          db.prepare("UPDATE jobs SET score = ?, tier = ?, score_reason = ?, status = 'scored', updated_at = datetime('now') WHERE id = ?").run(fallback.score, fallback.tier, fallback.reason, jobId);
          db.prepare("INSERT INTO user_scores (job_id, user_id, score, tier, score_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now')) ON CONFLICT(job_id, user_id) DO UPDATE SET score = excluded.score, tier = excluded.tier, score_reason = excluded.score_reason, updated_at = datetime('now')").run(jobId, userId, fallback.score, fallback.tier, fallback.reason);
          console.log(`  ⚠ #${jobId} score fallback: ${fallback.tier}`);
          scoreOk = true;
          break;
        }
      }
      if (scoreOk) {
        state.taskCompleted('score', jobId);
        scored++;
        extractMarketData(job);
      } else if (scoreCtrl.signal.aborted) {
        state.taskCancelled('score', jobId); skipped++; return 'cancelled';
      } else {
        state.taskFailed('score', jobId); skipped++; return 'error';
      }
    } else {
      console.log(`  - #${jobId} score: already scored (${job.score?.toFixed(2)}), skipping`);
    }

    // --- Compose + Audit (retry loop) ---
    // When audit fails, compose re-runs with audit feedback within the SAME
    // pipeline run — no need for a second runAll() call.
    // Max 3 compose→audit attempts per job per pipeline run.
    for (let attempt = 0; attempt < MAX_AUDIT_RETRIES; attempt++) {
      if (state.signal?.aborted) break;

      // Always re-read status — auditJob() changes it on failure
      const statusRow = db.prepare('SELECT status, score, tier, title, company FROM jobs WHERE id = ?').get(jobId) as
        { status: string; score: number | null; tier: string | null; title: string | null; company: string | null } | undefined;

      if (!statusRow) { skipped++; return 'skip'; }

      // Skip deal-breakers and C-tier (manual action required)
      if (statusRow.score === 0 || statusRow.tier === 'D' || statusRow.tier === 'C') {
        if (attempt === 0) console.log(`  - #${jobId} compose: skipped (tier ${statusRow.tier}, requires manual action)`);
        break;
      }

      const meta = { title: statusRow.title ?? undefined, company: statusRow.company ?? undefined };

      // ---- Compose (if needed) ----
      if (statusRow.status === 'scored' || statusRow.status === 'extracted') {
        const composeCtrl = state.taskStarted('compose', jobId, meta);
        try {
          const composeResult = await composeJob(jobId, undefined, composeCtrl.signal);
          if (composeResult.success) {
            console.log(`  ✓ #${jobId} compose: ${composeResult.pdfPath}`);
            state.taskCompleted('compose', jobId);
            composed++;
          } else {
            console.log(`  ✕ #${jobId} compose: ${composeResult.error}`);
            state.taskFailed('compose', jobId);
            return 'fail';
          }
        } catch (err: any) {
          if (err?.name === 'AbortError' || composeCtrl.signal.aborted) { state.taskCancelled('compose', jobId); skipped++; return 'cancelled'; }
          logger.error(`Compose job ${jobId}: ${(err as Error).message}`);
          state.taskFailed('compose', jobId);
          return 'error';
        }
      }

      // ---- Audit (if ready) ----
      const afterCompose = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string } | undefined;
      if (afterCompose?.status === 'audited') {
        console.log(`  - #${jobId} audit: already audited, skipping`);
        return 'already-audited';
      }
      if (afterCompose?.status !== 'composed') {
        // compose failed or was skipped — nothing to audit
        return 'ok';
      }

      const auditCtrl = state.taskStarted('audit', jobId, meta);
      try {
        const auditResult = await auditJob(jobId, auditCtrl.signal);
        if (!auditResult.success) {
          console.log(`  ✕ #${jobId} audit: ${auditResult.error}`);
          state.taskFailed('audit', jobId);
          return 'fail';
        }
        const current = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string } | undefined;
        if (current?.status === 'audited') {
          console.log(`  ✓ #${jobId} audit: PASSED (${auditResult.overallScore}/100)`);
          state.taskCompleted('audit', jobId);
          audited++;
          return 'ok'; // done!
        }
        // auditJob set status back to 'scored' — retry compose with feedback
        console.log(`  ↻ #${jobId} audit: FAILED (${auditResult.overallScore}/100) — re-composing with feedback...`);
        state.taskCompleted('audit', jobId);
        // continue to next attempt
      } catch (err: any) {
        if (err?.name === 'AbortError') { state.taskCancelled('audit', jobId); return 'cancelled'; }
        logger.error(`Audit job ${jobId}: ${(err as Error).message}`);
        state.taskFailed('audit', jobId);
        return 'error';
      }
    }
    // Exhausted all retries without passing — job stays at 'scored' or 'audit_failed'
    const finalStatus = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string } | undefined;
    if (finalStatus?.status === 'audit_failed') {
      console.log(`  ✕ #${jobId}: audit gave up after ${MAX_AUDIT_RETRIES} attempts — manual review needed`);
    }
  });

  state.finishPipeline();
  const summary = [`${extracted} extracted`, `${scored} scored`, `${composed} composed`, `${audited} audited`];
  if (alreadyDone) summary.push(`${alreadyDone} already done`);
  if (skipped) summary.push(`${skipped} skipped`);
  console.log(`\n=== Pipeline Complete: ${summary.join(', ')} ===`);
}

/**
 * Run the full pipeline for a single job.
 */
export async function runJob(jobId: number, state = getPipelineState()): Promise<void> {
  state.startPipeline();

  console.log(`=== Pipeline: Job #${jobId} ===\n`);

  // Extract
  console.log('--- Extract ---');
  state.startStage('extract', 1);
  state.taskStarted('extract', jobId);
  const extractResult = await extractJob(jobId);
  if (!extractResult.success) {
    console.log(`Extract failed: ${extractResult.error}`);
    console.log('Pipeline stopped.');
    state.taskCompleted('extract', jobId);
    state.finishStage('extract');
    state.finishPipeline();
    return;
  }
  console.log(`"${extractResult.title}" at ${extractResult.company} (${extractResult.location})`);
  state.taskCompleted('extract', jobId);
  state.finishStage('extract');

  // Score
  console.log('\n--- Score ---');
  state.startStage('score', 1);
  const db = getDb();
  const job = db.prepare(
    'SELECT id, title, company, location, description FROM jobs WHERE id = ?',
  ).get(jobId) as {
    id: number; title: string | null; company: string | null;
    location: string | null; description: string | null;
  } | undefined;

  if (!job) {
    console.log('Job not found after extraction.');
    state.finishStage('score');
    state.finishPipeline();
    return;
  }

  state.taskStarted('score', jobId);
  try {
    const { scoreJobWithLLM } = await import('./scorers/llm.js');
    const result = await scoreJobWithLLM(job);
    db.prepare(
      "UPDATE jobs SET score = ?, tier = ?, score_reason = ?, status = 'scored', updated_at = datetime('now') WHERE id = ?",
    ).run(result.score, result.tier, result.reason, jobId);
    console.log(`${result.tier} (${result.score.toFixed(2)}) — ${result.reason.slice(0, 120)}`);

    // Extract market data
    extractMarketData(job);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Score failed: ${msg}`);
    console.log('Pipeline stopped.');
    state.taskCompleted('score', jobId);
    state.finishStage('score');
    state.finishPipeline();
    return;
  }
  state.taskCompleted('score', jobId);
  state.finishStage('score');

  // Compose
  console.log('\n--- Compose ---');
  state.startStage('compose', 1);
  state.taskStarted('compose', jobId);
  const composeResult = await composeJob(jobId);
  if (!composeResult.success) {
    console.log(`Compose failed: ${composeResult.error}`);
    console.log('Pipeline stopped.');
    state.taskCompleted('compose', jobId);
    state.finishStage('compose');
    state.finishPipeline();
    return;
  }
  console.log(`PDF: ${composeResult.pdfPath}`);
  state.taskCompleted('compose', jobId);
  state.finishStage('compose');

  // Audit (with retry loop)
  console.log('\n--- Audit ---');
  state.startStage('audit', 1);
  state.taskStarted('audit', jobId);
  for (let attempt = 1; attempt <= MAX_AUDIT_RETRIES; attempt++) {
    if (attempt > 1) {
      console.log(`\nRetry ${attempt}/${MAX_AUDIT_RETRIES}...`);
      const reCompose = await composeJob(jobId);
      if (!reCompose.success) {
        console.log(`Re-compose failed: ${reCompose.error}`);
        break;
      }
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
  state.taskCompleted('audit', jobId);
  state.finishStage('audit');

  state.finishPipeline();
  console.log('\n=== Pipeline Complete ===');
}
