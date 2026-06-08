/**
 * JobBot Web UI — v0.3
 *
 * A simple local-only Express server that reads from SQLite and renders
 * HTML pages for browsing the job-search pipeline.
 *
 * Routes:
 *   GET /                Dashboard: all jobs, filters, sorting, tier badges
 *   GET /jobs/:id        Job detail: extracted data, score breakdown, LLM reasoning
 */

import express from 'express';
import path from 'node:path';
import { getDb } from '../db/client.js';
import { PROJECT_ROOT } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

const app = express();

// ----- configuration -------------------------------------------------------

const PORT = 3000;
const VIEWS_DIR = path.join(PROJECT_ROOT, 'src', 'ui', 'views');

app.set('view engine', 'ejs');
app.set('views', VIEWS_DIR);
app.set('view cache', false);

// ----- types ---------------------------------------------------------------

interface JobRow {
  id: number;
  url: string;
  ats_type: string;
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
  apply_url: string | null;
  score: number | null;
  tier: string | null;
  score_reason: string | null;
  status: string;
  discovered_at: string;
  updated_at: string;
}

interface TierCount {
  A: number;
  B: number;
  C: number;
  D: number;
}

// ----- helpers -------------------------------------------------------------

function tierLabel(tier: string | null): string {
  return tier ?? '-';
}

function tierClass(tier: string | null): string {
  switch (tier) {
    case 'A': return 'tier-a';
    case 'B': return 'tier-b';
    case 'C': return 'tier-c';
    case 'D': return 'tier-d';
    default: return 'tier-none';
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    new: 'New',
    extracted: 'Extracted',
    scored: 'Scored',
    tailored: 'Tailored',
    applied: 'Applied',
    archived: 'Archived',
  };
  return map[status] ?? status;
}

function truncate(s: string | null, max: number): string {
  if (!s) return '-';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function scoreFmt(s: number | null): string {
  if (s == null) return '-';
  return s.toFixed(2);
}

// ----- routes: dashboard ---------------------------------------------------

app.get('/', (req, res) => {
  const db = getDb();

  // Parse query params
  const tierFilter = typeof req.query.tier === 'string' ? req.query.tier.toUpperCase() : null;
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : null;
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'score';

  // Build query
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (tierFilter && ['A', 'B', 'C', 'D'].includes(tierFilter)) {
    conditions.push('tier = ?');
    params.push(tierFilter);
  }
  if (statusFilter && ['new', 'extracted', 'scored', 'tailored', 'applied', 'archived'].includes(statusFilter)) {
    conditions.push('status = ?');
    params.push(statusFilter);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  let orderBy: string;
  switch (sort) {
    case 'company':
      orderBy = 'COALESCE(company, \'zzz\') ASC, id ASC';
      break;
    case 'title':
      orderBy = 'COALESCE(title, \'zzz\') ASC, id ASC';
      break;
    case 'date':
      orderBy = 'discovered_at DESC, id ASC';
      break;
    case 'score':
    default:
      orderBy = 'COALESCE(score, -1) DESC, id ASC';
      break;
  }

  const query = `SELECT * FROM jobs ${where} ORDER BY ${orderBy}`;
  const jobs = db.prepare(query).all(...params) as JobRow[];

  // Tier counts (only scored jobs, excludes deterministic fallback D/0.00)
  const tierCounts = db.prepare(`
    SELECT tier, COUNT(*) as count FROM jobs
    WHERE tier IS NOT NULL AND score > 0
    GROUP BY tier
  `).all() as { tier: string; count: number }[];

  const counts: TierCount = { A: 0, B: 0, C: 0, D: 0 };
  for (const row of tierCounts) {
    if (row.tier in counts) {
      counts[row.tier as keyof TierCount] = row.count;
    }
  }

  const totalJobs = (db.prepare('SELECT COUNT(*) as count FROM jobs').get() as { count: number }).count;

  res.render('dashboard', {
    title: 'Dashboard',
    jobs,
    counts,
    totalJobs,
    filters: { tier: tierFilter, status: statusFilter, sort },
    helpers: { tierLabel, tierClass, statusLabel, truncate, scoreFmt },
  });
});

// ----- routes: job detail --------------------------------------------------

app.get('/jobs/:id', (req, res) => {
  const db = getDb();
  const jobId = Number(req.params.id);

  if (!Number.isInteger(jobId) || jobId < 1) {
    res.status(400).send('Invalid job ID');
    return;
  }

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;

  if (!job) {
    res.status(404).send('Job not found');
    return;
  }

  // Parse score_reason into sections if it looks like narrative text
  // The LLM produces free-text reasoning; we display it as-is but
  // try to break it into paragraphs for readability.
  const reasonParagraphs = job.score_reason
    ? job.score_reason.split(/(?<=\.)\s+(?=[A-Z])/).filter(Boolean)
    : [];

  res.render('job-detail', {
    title: job.title || `Job #${job.id}`,
    job,
    reasonParagraphs,
    helpers: { tierLabel, tierClass, statusLabel, truncate, scoreFmt },
  });
});

// ----- routes: pipeline ----------------------------------------------------

app.get('/pipeline', (_req, res) => {
  const db = getDb();

  const totalJobs = (db.prepare('SELECT COUNT(*) as count FROM jobs').get() as { count: number }).count;

  // ---- per-stage queue queries ------------------------------------------------
  // Step 1 (Ingest → Extract): distinguish queued vs failed
  //   queued = never attempted (no title, no error)
  //   failed = attempted but failed (no title, has extract error)
  //   done   = succeeded (has title, moved to Step 2)
  const ingestQueued = db.prepare(
    `SELECT id, url, ats_type FROM jobs
     WHERE title IS NULL AND (score_reason IS NULL OR score_reason NOT LIKE 'Extract failed:%')
     ORDER BY id`,
  ).all() as { id: number; url: string; ats_type: string }[];
  const ingestFailed = db.prepare(
    `SELECT id, url, ats_type, score_reason FROM jobs
     WHERE title IS NULL AND score_reason LIKE 'Extract failed:%'
     ORDER BY id`,
  ).all() as { id: number; url: string; ats_type: string; score_reason: string }[];
  const ingestDone = totalJobs - ingestQueued.length - ingestFailed.length;

  // Step 2 (Extract → Score): queued/failed/done
  const extractQueued = db.prepare(
    `SELECT id, title, company FROM jobs
     WHERE title IS NOT NULL AND (score IS NULL OR score = 0)
     ORDER BY id`,
  ).all() as { id: number; title: string | null; company: string | null }[];
  const extractFailed: never[] = []; // scoring doesn't fail, it falls back to deterministic
  const extractDone = (totalJobs - ingestQueued.length - ingestFailed.length) - extractQueued.length;

  // Step 3 results: scored jobs
  const scoredCount = (db.prepare(
    'SELECT COUNT(*) as count FROM jobs WHERE score > 0',
  ).get() as { count: number }).count;

  // Tier distribution (real scores only)
  const tierRows = db.prepare(`
    SELECT tier, COUNT(*) as count FROM jobs
    WHERE tier IS NOT NULL AND score > 0
    GROUP BY tier
  `).all() as { tier: string; count: number }[];

  const tierCounts: TierCount = { A: 0, B: 0, C: 0, D: 0 };
  for (const row of tierRows) {
    if (row.tier in tierCounts) {
      tierCounts[row.tier as keyof TierCount] = row.count;
    }
  }

  res.render('pipeline', {
    title: 'Pipeline',
    totalJobs,
    // Step 1
    ingestDone,
    ingestQueued,
    ingestFailed,
    // Step 2
    extractDone,
    extractQueued,
    extractFailed,
    // Step 3
    scoredCount,
    tierCounts,
  });
});

// ----- start ---------------------------------------------------------------

export function startUi(port: number = PORT): void {
  app.listen(port, () => {
    logger.info(`JobBot UI running at http://localhost:${port}`);
  });
}
