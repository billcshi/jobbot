/**
 * JobBot Web UI
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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getDb } from '../db/client.js';
import { deleteJob, deleteByTier, deleteByStatus } from '../jobs/delete.js';
import { addUrl } from '../jobs/add-url.js';
import { extractSalaryRanges } from '../jobs/market-data.js';
import { PROJECT_ROOT, LOCAL_DIR, RESUMES_DIR, jobResumeDir } from '../utils/paths.js';
import { readCandidate, readPreferences, writeProfile } from '../utils/profile-store.js';
import { parseYaml } from '../utils/yaml.js';
import { getDeepseekKey, getDeepseekModel, getStageConcurrency } from '../utils/config.js';
import { logAiCall, extractUsage } from '../utils/ai-logger.js';
import { logger } from '../utils/logger.js';
import { getPipelineManager } from '../jobs/pipeline-state.js';
import { appContextForUser } from '../utils/app-context.js';
import { createDefaultPipeline } from '../application/pipeline/default-pipeline.js';
import { AuthError, AuthService } from '../auth/auth-service.js';

const app = express();

// ----- configuration -------------------------------------------------------

const PORT = 3000;
const VIEWS_DIR = path.join(PROJECT_ROOT, 'src', 'ui', 'views');

app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', VIEWS_DIR);
app.disable('view cache');
// Also set EJS to not cache (Express 5 compat)
app.set('view options', { cache: false });
// Override EJS cache
app.locals.cache = false;

export interface MutationRequestMetadata {
  method: string;
  protocol?: string;
  host?: string;
  origin?: string;
  secFetchSite?: string;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/** Browser-focused same-origin guard for every state-changing HTTP method. */
export function isTrustedMutationRequest(request: MutationRequestMetadata): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) return true;
  if (!request.host || !request.origin) return false;
  if (request.secFetchSite && request.secFetchSite.toLowerCase() !== 'same-origin') return false;

  try {
    const expected = new URL(`${request.protocol ?? 'http'}://${request.host}`);
    const origin = new URL(request.origin);
    if (!isLoopbackHostname(expected.hostname) || !isLoopbackHostname(origin.hostname)) return false;
    return expected.origin.toLowerCase() === origin.origin.toLowerCase();
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  const trusted = isTrustedMutationRequest({
    method: req.method,
    protocol: req.protocol,
    host: req.get('host'),
    origin: req.get('origin'),
    secFetchSite: req.get('sec-fetch-site'),
  });
  if (!trusted) {
    res.status(403).json({ error: 'Mutation rejected: same-origin localhost request required.' });
    return;
  }
  next();
});

// ----- cookie parser (minimal, no dependency) ----------------------------------

app.use((req, _res, next) => {
  const raw = req.headers.cookie;
  const cookies: Record<string, string> = {};
  if (raw) {
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).cookies = cookies;
  next();
});

// ----- local authentication --------------------------------------------------

const SESSION_COOKIE = 'jobbot_session';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function requestCookies(req: express.Request): Record<string, string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((req as any).cookies as Record<string, string> | undefined) ?? {};
}

function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
}

function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
}

function authService(): AuthService {
  return new AuthService(getDb());
}

function authErrorResponse(res: express.Response, error: unknown): void {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  logger.error(`Authentication failed: ${error instanceof Error ? error.message : String(error)}`);
  res.status(500).json({ error: 'Authentication failed.' });
}

app.get('/login', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const user = authService().resolveSession(requestCookies(req)[SESSION_COOKIE]);
  if (user) {
    res.redirect('/');
    return;
  }
  res.render('login');
});

app.post('/api/auth/register', async (req, res) => {
  const { username, password, setupToken } = (req.body || {}) as {
    username?: unknown;
    password?: unknown;
    setupToken?: unknown;
  };
  try {
    const service = authService();
    const user = setupToken === undefined
      ? await service.register(username, password)
      : await service.claimWithSetupToken(username, password, setupToken);
    const session = service.createSession(user.id);
    res.setHeader('Set-Cookie', [sessionCookie(session.token, req.secure), clearedSessionCookie(req.secure).replace(SESSION_COOKIE, 'active_user')]);
    res.status(201).json({ ok: true, user });
  } catch (error: unknown) {
    authErrorResponse(res, error);
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = (req.body || {}) as { username?: unknown; password?: unknown };
  try {
    const service = authService();
    const user = await service.authenticate(username, password);
    const session = service.createSession(user.id);
    res.setHeader('Set-Cookie', [sessionCookie(session.token, req.secure), clearedSessionCookie(req.secure).replace(SESSION_COOKIE, 'active_user')]);
    res.json({ ok: true, user });
  } catch (error: unknown) {
    authErrorResponse(res, error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  authService().revokeSession(requestCookies(req)[SESSION_COOKIE]);
  res.setHeader('Set-Cookie', clearedSessionCookie(req.secure));
  res.json({ ok: true });
});

// Web requests require a credential-backed session. The process-global user
// context remains available only to CLI commands.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = authService().resolveSession(requestCookies(req)[SESSION_COOKIE]);
  if (!user) {
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Authentication required.' });
    } else {
      res.redirect('/login');
    }
    return;
  }

  res.locals.userId = user.id;
  res.locals.userName = user.username;
  res.locals.activeUser = user.username;
  res.locals.activeUserId = user.id;

  next();
});

// Serve only the two user-facing PDF artifacts after verifying job ownership.
// Never expose the local/resumes root as a static directory.
app.get('/resumes/:jobId/:artifact', (req, res) => {
  const jobId = Number(req.params.jobId);
  const artifact = req.params.artifact;
  const userId = res.locals.userId;
  if (!Number.isInteger(jobId) || jobId < 1 || !['resume.pdf', 'cover-letter.pdf'].includes(artifact)) {
    res.status(404).send('Artifact not found');
    return;
  }

  const db = getDb();
  const owned = db.prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId);
  if (!owned) {
    res.status(404).send('Artifact not found');
    return;
  }

  const ownedRoot = path.resolve(RESUMES_DIR, String(jobId));
  let filePath: string;
  let expectedSha256: string | undefined;
  if (artifact === 'resume.pdf') {
    const version = db.prepare(`
      SELECT rv.id, rv.pdf_path, a.sha256 FROM resume_versions rv
      JOIN resume_drafts rd ON rd.id = rv.draft_id AND rd.status = 'rendered'
      JOIN artifacts a ON a.resume_version_id = rv.id
        AND a.artifact_type = 'pdf' AND a.path = rv.pdf_path
      WHERE rv.job_id = ? AND rv.user_id = ? AND rv.pdf_path IS NOT NULL
      ORDER BY rv.id DESC, a.id DESC LIMIT 1
    `).get(jobId, userId) as { id: number; pdf_path: string; sha256: string } | undefined;
    if (!version) {
      res.status(404).send('Artifact not found');
      return;
    }
    filePath = path.resolve(version.pdf_path);
    expectedSha256 = version.sha256;
  } else {
    filePath = path.resolve(ownedRoot, artifact);
  }

  const relativePath = path.relative(ownedRoot, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || !existsSync(filePath)) {
    res.status(404).send('Artifact not found');
    return;
  }
  if (artifact === 'resume.pdf') {
    const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    if (!expectedSha256 || expectedSha256 !== actual) {
      res.status(409).send('Artifact integrity check failed');
      return;
    }
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(filePath);
});

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
    composed: 'Composed',
    audited: 'Audited',
    audit_failed: 'Audit Failed',
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
  const userId = res.locals.userId;

  // Parse query params
  const tierFilter = typeof req.query.tier === 'string' ? req.query.tier.toUpperCase() : null;
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : null;
  const appliedFilter = typeof req.query.applied === 'string' ? req.query.applied : 'hide'; // "hide" | "only" | "all"
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'score';

  // Build query — join user_scores for per-user score display
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (tierFilter && ['A', 'B', 'C', 'D'].includes(tierFilter)) {
    conditions.push('COALESCE(us.tier, j.tier) = ?');
    params.push(tierFilter);
  }
  if (statusFilter && ['new', 'extracted', 'scored', 'composed', 'audited', 'applied', 'archived'].includes(statusFilter)) {
    conditions.push('j.status = ?');
    params.push(statusFilter);
  }

  // Application filter
  if (appliedFilter === 'hide') {
    // Default: hide applied jobs
    conditions.push("(j.status != 'applied' AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id AND a.user_id = ? AND a.status != 'draft'))");
    params.push(userId);
  } else if (appliedFilter === 'only') {
    conditions.push("(j.status = 'applied' OR EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id AND a.user_id = ? AND a.status != 'draft'))");
    params.push(userId);
  }
  // "all" — no filter

  // Always filter by active user
  conditions.push('j.user_id = ?');
  params.push(userId);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  let orderBy: string;
  switch (sort) {
    case 'company':
      orderBy = 'COALESCE(j.company, \'zzz\') ASC, j.id ASC';
      break;
    case 'title':
      orderBy = 'COALESCE(j.title, \'zzz\') ASC, j.id ASC';
      break;
    case 'date':
      orderBy = 'j.discovered_at DESC, j.id ASC';
      break;
    case 'score':
    default:
      orderBy = 'COALESCE(us.score, j.score, -1) DESC, j.id ASC';
      break;
  }

  const query = `
    SELECT j.*, us.score as user_score, us.tier as user_tier, us.score_reason as user_score_reason
    FROM jobs j
    LEFT JOIN user_scores us ON us.job_id = j.id AND us.user_id = ?
    ${where}
    ORDER BY ${orderBy}
  `;
  const jobs = db.prepare(query).all(userId, ...params) as (JobRow & { user_score: number | null; user_tier: string | null; user_score_reason: string | null })[];

  // Post-process: derive consistent tier from display score.
  // LLM can return tier/score mismatches, and legacy jobs may only have jobs.score.
  // Canonical thresholds: A ≥ 0.80, B ≥ 0.65, C ≥ 0.50, D < 0.50.
  function deriveTier(score: number): string {
    if (score >= 0.80) return 'A';
    if (score >= 0.65) return 'B';
    if (score >= 0.50) return 'C';
    return 'D';
  }
  const enrichedJobs = jobs.map(job => {
    const displayScore = job.user_score ?? job.score;
    const displayTier = displayScore != null ? deriveTier(displayScore) : (job.user_tier || job.tier || null);
    return { ...job, _displayScore: displayScore, _displayTier: displayTier };
  });

  // Tier counts (per-user, from user_scores)
  const tierCounts = db.prepare(`
    SELECT tier, COUNT(*) as count FROM jobs
    WHERE user_id = ? AND tier IS NOT NULL AND score IS NOT NULL
    GROUP BY tier
  `).all(userId) as { tier: string; count: number }[];

  const counts: TierCount = { A: 0, B: 0, C: 0, D: 0 };
  for (const row of tierCounts) {
    if (row.tier in counts) {
      counts[row.tier as keyof TierCount] = row.count;
    }
  }

  const totalJobs = (db.prepare('SELECT COUNT(*) as count FROM jobs WHERE user_id = ?').get(userId) as { count: number }).count;

  // Pipeline stage counts for funnel
  const stageCounts = {
    ingested: totalJobs,
    extracted: (db.prepare('SELECT COUNT(*) as c FROM jobs WHERE title IS NOT NULL AND user_id = ?').get(userId) as { c: number }).c,
    scored: (db.prepare('SELECT COUNT(*) as c FROM jobs WHERE score IS NOT NULL AND user_id = ?').get(userId) as { c: number }).c,
    composed: (db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status IN ('composed','audited') AND user_id = ?").get(userId) as { c: number }).c,
    audited: (db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'audited' AND user_id = ?").get(userId) as { c: number }).c,
  };

  // Applied count for this user
  const appliedCount = (db.prepare(
    "SELECT COUNT(*) as c FROM applications WHERE user_id = ? AND status != 'draft'",
  ).get(userId) as { c: number }).c;

  // Top companies
  const topCompanies = db.prepare(`
    SELECT company, COUNT(*) as count FROM jobs
    WHERE user_id = ? AND company IS NOT NULL AND company != ''
    GROUP BY company ORDER BY count DESC LIMIT 8
  `).all(userId) as { company: string; count: number }[];

  res.render('dashboard', {
    title: 'Dashboard',
    jobs: enrichedJobs,
    counts,
    totalJobs,
    appliedCount,
    stageCounts,
    topCompanies,
    filters: { tier: tierFilter, status: statusFilter, sort, applied: appliedFilter },
    helpers: { tierLabel, tierClass, statusLabel, truncate, scoreFmt },
  });
});

// ----- routes: job detail --------------------------------------------------

app.get('/jobs/:id', (req, res) => {
  const db = getDb();
  const jobId = Number(req.params.id);
  const userId = res.locals.userId;

  if (!Number.isInteger(jobId) || jobId < 1) {
    res.status(400).send('Invalid job ID');
    return;
  }

  // Join user_scores for per-user score
  const job = db.prepare(`
    SELECT j.*, us.score as user_score, us.tier as user_tier, us.score_reason as user_score_reason
    FROM jobs j
    LEFT JOIN user_scores us ON us.job_id = j.id AND us.user_id = ?
    WHERE j.id = ? AND j.user_id = ?
  `).get(userId, jobId, userId) as (JobRow & { user_score: number | null; user_tier: string | null; user_score_reason: string | null }) | undefined;

  if (!job) {
    res.status(404).send('Job not found');
    return;
  }

  // Get application for this user
  const application = db.prepare(
    'SELECT * FROM applications WHERE job_id = ? AND user_id = ?',
  ).get(jobId, userId) as {
    id: number; status: string; submitted_at: string | null;
    responded_at: string | null; response_type: string | null;
    notes: string | null;
  } | undefined;

  // Use per-user score if available, fall back to legacy jobs.score
  const displayScore = job.user_score ?? job.score;
  const displayTier = job.user_tier ?? job.tier;
  const displayReason = job.user_score_reason ?? job.score_reason;

  // Parse score_reason into sections
  const reasonParagraphs = displayReason
    ? displayReason.split(/(?<=\.)\s+(?=[A-Z])/).filter(Boolean)
    : [];

  // Load stage outputs for interactive pipeline.
  // Verify the PDF file actually exists on disk — the DB record may be stale
  // if files were cleaned up or pdflatex failed silently.
  const resumeVersionRow = db.prepare(`
    SELECT rv.id, rv.pdf_path, rv.version_name, rv.created_at
    FROM resume_versions rv
    JOIN resume_drafts rd ON rd.id = rv.draft_id AND rd.status = 'rendered'
    WHERE rv.job_id = ? AND rv.user_id = ? AND rv.pdf_path IS NOT NULL
    ORDER BY rv.created_at DESC LIMIT 1
  `).get(jobId, userId) as { id: number | null; pdf_path: string | null; version_name: string | null; created_at: string | null } | undefined;
  const resumeVersion = resumeVersionRow?.pdf_path && existsSync(resumeVersionRow.pdf_path)
    ? resumeVersionRow
    : undefined;

  // GET remains read-only. A missing artifact is displayed as stale and may be
  // repaired by an explicit render/maintenance action.

  // Build descriptive download filenames: {FirstName}{LastName}_{Company}_{YYYY-MM-DD}_v{ver}.pdf
  let resumeDownloadName = 'resume.pdf';
  let clDownloadName = 'cover-letter.pdf';
  try {
    const candidate = parseYaml<{ name?: { first?: string; last?: string } }>(readCandidate(userId));
    const fullName = [candidate.name?.first, candidate.name?.last].filter(Boolean).join('');
    const company = (job.company || 'Unknown').replace(/[^a-zA-Z0-9.-]/g, '');
    const date = (resumeVersion?.created_at || job.discovered_at || '').slice(0, 10); // YYYY-MM-DD
    const ver = resumeVersion?.id ? `v${resumeVersion.id}` : 'v1';
    const safeName = fullName || 'Candidate';
    const stem = [safeName, company, date, ver].filter(Boolean).join('_');
    resumeDownloadName = `${stem}.pdf`;
    clDownloadName = `CoverLetter_${safeName}_${company}_${date}.pdf`;
  } catch { /* keep defaults */ }

  // Check for existing cover letter
  const clPdfPath = `${jobResumeDir(jobId)}/cover-letter.pdf`;
  const hasCoverLetter = existsSync(clPdfPath);

  let auditData: { overallScore?: number; contentScore?: number; visualScore?: number; contentIssues?: unknown[]; visualIssues?: unknown[] } | null = null;
  const auditPath = `${jobResumeDir(jobId)}/audit.json`;
  if (existsSync(auditPath)) {
    try {
      auditData = JSON.parse(readFileSync(auditPath, 'utf-8'));
    } catch { /* ignore corrupt audit */ }
  }

  // Load events for this job
  interface EventRow {
    id: number; event_type: string; description: string | null;
    metadata: string | null; created_at: string;
  }
  const events = db.prepare(
    'SELECT id, event_type, description, metadata, created_at FROM events WHERE job_id = ? ORDER BY created_at ASC',
  ).all(jobId) as EventRow[];

  // Extract salary for this job: prefer LLM-extracted data from market_data,
  // fall back to regex on the description.
  let jobSalaries: { low: number; high: number; raw: string }[] = [];
  let jobSkills: string[] = [];
  try {
    // Check for LLM-extracted data first (source = job_<id>)
    const llmSalaryRow = db.prepare(
      "SELECT value FROM job_market_data WHERE source = ? AND key LIKE 'salary_range.%' LIMIT 1",
    ).get(`job_${jobId}`) as { value: string } | undefined;
    const llmSkillRows = db.prepare(
      "SELECT key FROM job_market_data WHERE source = ? AND key LIKE 'common_req.%'",
    ).all(`job_${jobId}`) as { key: string }[];

    if (llmSalaryRow) {
      // Parse LLM-extracted salary value like "$120k–$180k"
      const match = llmSalaryRow.value.match(/\$(\d+)k[–\-]\$(\d+)k/);
      if (match) {
        jobSalaries.push({ low: parseInt(match[1]!, 10) * 1000, high: parseInt(match[2]!, 10) * 1000, raw: llmSalaryRow.value });
      }
    }
    jobSkills = llmSkillRows.map((r) => r.key.replace('common_req.', '').replace(/_/g, ' '));
  } catch { /* ignore */ }

  // Fallback: regex extraction if no LLM data found
  if (jobSalaries.length === 0 && job.description) {
    try {
      jobSalaries = extractSalaryRanges(job.description);
    } catch { /* ignore */ }
  }

  // Load market data relevant to this job
  interface MarketDataRow { key: string; value: string; source: string; confidence: number; sample_size: number; }
  let salaryMarket: MarketDataRow[] = [];
  let skillMarket: MarketDataRow[] = [];
  let titleMarket: MarketDataRow[] = [];

  try {
    salaryMarket = db.prepare(
      "SELECT * FROM job_market_data WHERE key LIKE 'salary_range.%' ORDER BY sample_size DESC LIMIT 8",
    ).all() as MarketDataRow[];
    skillMarket = db.prepare(
      "SELECT * FROM job_market_data WHERE key LIKE 'common_req.%' ORDER BY CAST(value AS REAL) DESC LIMIT 15",
    ).all() as MarketDataRow[];
    // Titles similar to this job
    if (job.title) {
      const titleNorm = job.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '_').slice(0, 60);
      titleMarket = db.prepare(
        "SELECT * FROM job_market_data WHERE key LIKE 'title_freq.%' AND key LIKE ? ORDER BY CAST(value AS REAL) DESC LIMIT 6",
      ).all(`%${titleNorm.slice(0, 20)}%`) as MarketDataRow[];
    }
  } catch { /* market data table might not exist yet if no jobs scored */ }

  res.render('job-detail', {
    title: job.title || `Job #${job.id}`,
    job,
    displayScore,
    displayTier,
    displayReason,
    application,
    reasonParagraphs,
    events,
    resumeVersion,
    resumeDownloadName,
    clDownloadName,
    auditData,
    hasCoverLetter,
    clPdfPath,
    RESUMES_DIR,
    jobSalaries,
    jobSkills,
    salaryMarket,
    skillMarket,
    titleMarket,
    helpers: { tierLabel, tierClass, statusLabel, truncate, scoreFmt },
  });
});

// ----- routes: add-urls page -----------------------------------------------

app.get('/add-urls', (_req, res) => {
  res.render('add-urls', { title: 'Add URLs' });
});

// ----- routes: pipeline ----------------------------------------------------

app.get('/pipeline', (_req, res) => {
  const db = getDb();
  const userId = res.locals.userId;

  const totalJobs = (db.prepare('SELECT COUNT(*) as count FROM jobs WHERE user_id = ?').get(userId) as { count: number }).count;

  // ---- per-stage queue queries ------------------------------------------------
  const ingestQueued = db.prepare(
    `SELECT id, url, ats_type FROM jobs
     WHERE user_id = ? AND title IS NULL AND (score_reason IS NULL OR score_reason NOT LIKE 'Extract failed:%')
     ORDER BY id`,
  ).all(userId) as { id: number; url: string; ats_type: string }[];
  const ingestFailed = db.prepare(
    `SELECT id, url, ats_type, score_reason FROM jobs
     WHERE user_id = ? AND title IS NULL AND score_reason LIKE 'Extract failed:%'
     ORDER BY id`,
  ).all(userId) as { id: number; url: string; ats_type: string; score_reason: string }[];
  const ingestDone = totalJobs - ingestQueued.length - ingestFailed.length;

  // Step 2 (Extract → Score): queued/failed/done
  const extractQueued = db.prepare(
    `SELECT id, title, company FROM jobs
     WHERE user_id = ? AND title IS NOT NULL AND score IS NULL
     ORDER BY id`,
  ).all(userId) as { id: number; title: string | null; company: string | null }[];
  const extractDone = (totalJobs - ingestQueued.length - ingestFailed.length) - extractQueued.length;

  // Step 3 results: scored jobs
  const scoredCount = (db.prepare(
    'SELECT COUNT(*) as count FROM jobs WHERE user_id = ? AND score IS NOT NULL',
  ).get(userId) as { count: number }).count;

  // Step 4 (Score → Compose): only A/B tier (C requires manual action, D = deal-breakers)
  const composeQueued = db.prepare(
    `SELECT id, title, company FROM jobs
     WHERE user_id = ? AND status IN ('scored', 'audit_failed') AND score > 0 AND tier IN ('A', 'B')
     ORDER BY id`,
  ).all(userId) as { id: number; title: string | null; company: string | null }[];
  const composeDone = (db.prepare(
    `SELECT COUNT(*) as count FROM jobs WHERE user_id = ? AND status IN ('composed', 'audited')`,
  ).get(userId) as { count: number }).count;
  const composeEligible = composeDone + composeQueued.length;
  const dSkipped = (db.prepare(
    `SELECT COUNT(*) as count FROM jobs WHERE user_id = ? AND status = 'scored' AND tier = 'D'`,
  ).get(userId) as { count: number }).count;
  const cSkipped = (db.prepare(
    `SELECT COUNT(*) as count FROM jobs WHERE user_id = ? AND status = 'scored' AND tier = 'C'`,
  ).get(userId) as { count: number }).count;

  // Step 5 (Compose → Audit): queued = composed but not audited
  const auditQueued = db.prepare(
    `SELECT id, title, company FROM jobs
     WHERE user_id = ? AND status = 'composed'
     ORDER BY id`,
  ).all(userId) as { id: number; title: string | null; company: string | null }[];
  const auditDone = (db.prepare(
    `SELECT COUNT(*) as count FROM jobs WHERE user_id = ? AND status = 'audited'`,
  ).get(userId) as { count: number }).count;

  // Tier distribution (per-user scored jobs)
  const tierRows = db.prepare(`
    SELECT tier, COUNT(*) as count FROM jobs
    WHERE user_id = ? AND tier IS NOT NULL AND score IS NOT NULL
    GROUP BY tier
  `).all(userId) as { tier: string; count: number }[];

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
    // Step 3
    scoredCount,
    tierCounts,
    // Step 4
    composeQueued,
    composeDone,
    composeEligible,
    dSkipped,
    cSkipped,
    // Step 5
    auditQueued,
    auditDone,
  });
});

// ----- routes: events timeline ----------------------------------------------

app.get('/events', (req, res) => {
  const db = getDb();
  const userId = res.locals.userId;
  const jobFilter = typeof req.query.job === 'string' ? Number(req.query.job) : null;
  const typeFilter = typeof req.query.type === 'string' ? req.query.type : null;

  let query = `SELECT e.*, j.title as job_title, j.company as job_company
    FROM events e LEFT JOIN jobs j ON e.job_id = j.id`;
  const conditions: string[] = ['j.user_id = ?'];
  const params: unknown[] = [userId];

  if (jobFilter && !Number.isNaN(jobFilter)) {
    conditions.push('e.job_id = ?');
    params.push(jobFilter);
  }
  if (typeFilter) {
    conditions.push('e.event_type = ?');
    params.push(typeFilter);
  }

  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY e.created_at DESC, e.id DESC LIMIT 200';

  interface EventRow {
    id: number; job_id: number; event_type: string;
    description: string | null; metadata: string | null; created_at: string;
    job_title: string | null; job_company: string | null;
  }

  const events = db.prepare(query).all(...params) as EventRow[];

  const eventTypes = (db.prepare(`
    SELECT DISTINCT e.event_type
    FROM events e JOIN jobs j ON j.id = e.job_id
    WHERE j.user_id = ? ORDER BY e.event_type
  `).all(userId) as { event_type: string }[]).map((r) => r.event_type);

  res.render('events', {
    title: 'Event Timeline',
    events,
    eventTypes,
    filters: { job: jobFilter, type: typeFilter },
  });
});

// ----- routes: AI log -------------------------------------------------------

app.get('/ai-log', (_req, res) => {
  const userCount = (getDb().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
  if (userCount > 1) {
    res.status(403).send('AI logs are disabled when multiple user profiles exist because legacy entries have no ownership metadata.');
    return;
  }
  const logDir = `${LOCAL_DIR}/logs`;

  interface LogEntry {
    timestamp: string; operation: string; model: string; provider: string;
    requestSummary: string; responseSummary: string; promptTokens?: number;
    completionTokens?: number; cachedTokens?: number; totalTokens?: number;
    durationMs: number; success: boolean; time?: string; duration?: string; error?: string;
  }

  const entries: LogEntry[] = [];
  if (existsSync(logDir)) {
    const files = readdirSync(logDir)
      .filter((f: string) => f.startsWith('ai-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();

    for (const file of files) {
      const lines = readFileSync(`${logDir}/${file}`, 'utf-8')
        .split('\n')
        .filter((l: string) => l.trim());
      for (const line of lines.reverse()) {
        try {
          const entry = JSON.parse(line) as LogEntry;
          entry.time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
          entry.duration = entry.durationMs > 1000
            ? `${(entry.durationMs / 1000).toFixed(1)}s`
            : `${entry.durationMs}ms`;
          entries.push(entry);
          if (entries.length >= 500) break;
        } catch { /* skip malformed lines */ }
      }
      if (entries.length >= 500) break;
    }
  }

  const totalPrompt = entries.reduce((sum, entry) => sum + (entry.promptTokens ?? 0), 0);
  const totalCompletion = entries.reduce((sum, entry) => sum + (entry.completionTokens ?? 0), 0);
  const totalCached = entries.reduce((sum, entry) => sum + (entry.cachedTokens ?? 0), 0);
  const operations = [...new Set(entries.map((entry) => entry.operation))].sort();

  res.render('ai-log', {
    title: 'AI Call Log',
    entries,
    operations,
    totalPrompt,
    totalCompletion,
    totalCached,
  });
});

// ----- routes: profile pages -----------------------------------------------

const PROFILE_LABELS: Record<string, { label: string; description: string }> = {
  candidate: { label: 'Candidate Profile', description: 'Work history, education, skills, links. The source of truth for resume tailoring.' },
  preferences: { label: 'Preferences', description: 'Job titles, locations, industries, deal-breakers, and scoring weights.' },
};

type ProfileFile = 'candidate' | 'preferences';
type AiEditableProfileFile = 'preferences';

export function profileAllowsExternalAiEdit(file: ProfileFile): file is AiEditableProfileFile {
  return file === 'preferences';
}

/** Read a profile section from the database for a given user. */
function readProfile(file: ProfileFile, userId: number): string {
  switch (file) {
    case 'candidate': return readCandidate(userId);
    case 'preferences': return readPreferences(userId);
    default: return '';
  }
}

function getYamlSections(yaml: string): string[] {
  const sections: string[] = [];
  for (const line of yaml.split('\n')) {
    const m = line.match(/^(\w[\w_]*):/);
    if (m && m[1] && !line.startsWith(' ')) sections.push(m[1]);
  }
  return sections;
}

app.get('/profile', (_req, res) => {
  const userId = res.locals.userId;
  const candidate = readProfile('candidate', userId);
  const prefs = readProfile('preferences', userId);

  res.render('profile', {
    title: 'Profile',
    candidateSize: candidate ? `${candidate.split('\n').length} lines` : 'Not found',
    candidateSections: candidate ? getYamlSections(candidate) : [],
    prefsSize: prefs ? `${prefs.split('\n').length} lines` : 'Not found',
    prefsSections: prefs ? getYamlSections(prefs) : [],
  });
});

app.get('/profile/:file', (req, res) => {
  const file = req.params.file as ProfileFile;
  if (!(file in PROFILE_LABELS)) {
    res.status(404).send('Profile file not found');
    return;
  }

  const info = PROFILE_LABELS[file]!;
  const yamlRaw = readProfile(file, res.locals.userId);

  res.render('profile-edit', {
    title: `${info.label} — Profile`,
    profileLabel: info.label,
    profileFile: file,
    filePath: `Database: profile_revisions.${file}_json`,
    description: info.description,
    yamlRaw,
    aiEditable: profileAllowsExternalAiEdit(file),
    yamlEscaped: yamlRaw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  });
});

// ----- routes: profile API --------------------------------------------------

app.put('/api/profile/:file', (req, res) => {
  const file = req.params.file as ProfileFile;
  if (!(file in PROFILE_LABELS)) {
    res.status(400).json({ error: 'Invalid profile file' });
    return;
  }

  const { yaml } = req.body as { yaml?: string };
  if (typeof yaml !== 'string') {
    res.status(400).json({ error: 'Missing yaml field' });
    return;
  }

  try {
    writeProfile(res.locals.userId, file, yaml);
    logger.info(`Updated profile for ${res.locals.userName}: ${file}`);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * Build a domain-aware system prompt for AI-assisted profile editing.
 *
 * The old prompt was a generic "you are editing a YAML file" message that gave
 * the LLM zero context about what makes a good resume bullet, what the sections
 * mean, or how to make content more professional. This version gives the model
 * concrete writing guidance tuned to each profile section.
 */
function buildProfileEditPrompt(file: AiEditableProfileFile): string {
  const base = [
    'You are editing a JobBot profile file. Return ONLY the complete updated YAML.',
    'Keep everything that was not mentioned exactly as-is — structure, indentation, comments, and unrelated sections.',
    'Do NOT add commentary. Do NOT wrap in markdown code fences. Just the raw YAML.',
    'If the instruction is unclear, make your best guess and note it in a `# NOTE:` comment.',
  ];

  if (file === 'preferences') {
    return [
      ...base,
      '',
      '## What this file is',
      'This is the scoring preferences file. It controls how jobs are scored and ranked against the candidate\'s criteria.',
      '',
      '## Sections',
      '- `preferred_titles`: job titles the candidate is targeting. Use realistic, searchable title strings.',
      '- `preferred_locations`: remote preference and target cities. Cities should be lowercase, within commuting distance.',
      '- `allowed_countries`: countries where the candidate can legally work.',
      '- `preferred_companies`: specific companies of interest (can be empty).',
      '- `preferred_industries`: industries the candidate wants to work in. Keep these broad enough to match real job postings.',
      '- `deal_breakers`: keywords or phrases that should auto-reject a job. Include description and keywords list.',
      '- `weights`: scoring weights for each dimension — must sum to 1.0. Higher weight = more important.',
      '- `tiers`: score thresholds for A/B/C/D tiers.',
      '- `us_citizenship_bonus`: small score boost for US-citizen-only roles (0.00–0.05).',
      '',
      '## Rules',
      '- Titles should match how jobs are actually posted (e.g., "leasing agent" not "Leasing Superstar").',
      '- Cities should be within reasonable commute of the candidate\'s location.',
      '- Deal-breaker keywords should be specific enough to catch bad matches without false positives.',
      '- If the user says what kind of role they want, pick industry labels that real job boards use.',
    ].join('\n');
  }


  return base.join('\n');
}

app.post('/api/profile/:file/ai-edit', async (req, res) => {
  const file = req.params.file as ProfileFile;
  if (!(file in PROFILE_LABELS)) {
    res.status(400).json({ error: 'Invalid profile file' });
    return;
  }

  if (!profileAllowsExternalAiEdit(file)) {
    res.status(403).json({
      error: 'AI editing is disabled for candidate evidence. Record candidate facts through the local interview or manual confirmation flow.',
    });
    return;
  }

  const { instruction } = req.body as { instruction?: string };
  if (typeof instruction !== 'string' || !instruction.trim()) {
    res.status(400).json({ error: 'Missing instruction field' });
    return;
  }

  const apiKey = getDeepseekKey();
  if (!apiKey) {
    res.status(500).json({ error: 'DeepSeek API key not set. Add to local/config.yaml.' });
    return;
  }

  const userId = res.locals.userId;
  const currentYaml = readProfile(file, userId);
  if (!currentYaml) {
    res.status(404).json({ error: `Profile not found for ${res.locals.userName}: ${file}.yaml` });
    return;
  }

  const prompt = buildProfileEditPrompt(file);

  const requestBody = {
    model: getDeepseekModel(),
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: [
        `## Current YAML (${file}.yaml)`,
        '```yaml',
        currentYaml,
        '```',
        '',
        '## Instruction',
        instruction,
      ].join('\n') },
    ],
    max_tokens: 4096,
  };

  const startMs = Date.now();

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
      const errMsg = `DeepSeek API error ${response.status}: ${body.slice(0, 200)}`;
      logAiCall({
        operation: 'profile-edit',
        model: getDeepseekModel(),
        provider: 'deepseek',
        endpoint: 'https://api.deepseek.com/v1/chat/completions',
        requestSummary: `Edit ${file}.yaml: "${instruction.slice(0, 100)}"`,
        responseSummary: errMsg,
        durationMs: Date.now() - startMs,
        success: false,
        error: errMsg,
      });
      res.status(500).json({ error: errMsg });
      return;
    }

    const data = (await response.json()) as {
      choices: [{ message: { content: string } }];
      usage?: Record<string, number>;
    };
    const content = data.choices[0]?.message?.content || '';
    const cleaned = content.replace(/^```ya?ml\s*\n?/, '').replace(/\n?```\s*$/, '');
    const usage = extractUsage(data as Record<string, unknown>);

    logAiCall({
      operation: 'profile-edit',
      model: getDeepseekModel(),
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Edit ${file}.yaml: "${instruction.slice(0, 100)}"`,
      responseSummary: `Output: ${cleaned.length} chars (was ${currentYaml.length} chars)`,
      ...usage,
      durationMs: Date.now() - startMs,
      success: true,
    });

    res.json({ ok: true, yaml: cleaned });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAiCall({
      operation: 'profile-edit',
      model: getDeepseekModel(),
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Edit ${file}.yaml`,
      responseSummary: msg,
      durationMs: Date.now() - startMs,
      success: false,
      error: msg,
    });
    res.status(500).json({ error: msg });
  }
});

// ----- routes: run API (POST-based, launches background pipeline) ------------

app.post('/api/run', async (req, res) => {
  const manager = getPipelineManager();
  const userId = res.locals.userId;
  const { step, jobId } = (req.body || {}) as { step?: string; jobId?: number };
  const validSteps = ['extract', 'score', 'compose', 'audit'] as const;
  if (step && !validSteps.includes(step as typeof validSteps[number])) {
    res.status(400).json({ error: 'Invalid pipeline step' });
    return;
  }
  if (jobId !== undefined) {
    const owned = getDb().prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId);
    if (!Number.isInteger(jobId) || jobId < 1 || !owned) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
  }

  const reservation = manager.reserve(userId, jobId ? 1 : Number.MAX_SAFE_INTEGER);
  if (!reservation.allowed) {
    res.status(409).json({ error: reservation.reason });
    return;
  }
  const state = reservation.state;

  // Respond immediately with 202 Accepted
  res.status(202).json({ ok: true, message: 'Pipeline started' });

  // Run in background (don't await — fire and update state)
  (async () => {
    try {
      const context = appContextForUser(userId);
      const concurrency = {
        extract: Math.min(reservation.concurrency, getStageConcurrency('extract')),
        score: Math.min(reservation.concurrency, getStageConcurrency('score')),
        compose: Math.min(reservation.concurrency, getStageConcurrency('compose')),
        audit: Math.min(reservation.concurrency, getStageConcurrency('audit')),
      };
      const service = createDefaultPipeline(context, {
        progress: state,
        concurrency,
        log: (message) => logger.info(message),
      });
      if (jobId) {
        await service.runJob(jobId);
      } else if (step) {
        await service.runStage(step as import('../application/pipeline/types.js').PipelineStage);
      } else {
        await service.runAll();
      }
    } catch (err) {
      logger.error('Pipeline run failed', err);
    } finally {
      state.finishPipeline();
    }
  })();
});

app.get('/api/run/status', (_req, res) => {
  const userId = res.locals.userId;
  const state = getPipelineManager().get(userId);
  const snap = state.snapshot();

  // Compute simplified fields for backward compat
  let stage: string = snap.stage ?? 'idle';
  let current = 0;
  let total = 0;
  let succeeded = 0;
  let failed = 0;

  if (snap.stage && snap.stages[snap.stage]) {
    const ss = snap.stages[snap.stage];
    total = ss.total;
    succeeded = ss.completed.length;
    failed = ss.failed.length;
    current = ss.running.length + succeeded + failed;
  }

  res.json({
    running: snap.running,
    stage,
    startedAt: snap.startedAt,
    current,
    total,
    succeeded,
    failed,
    message: snap.running
      ? `Running ${stage}: ${current}/${total} (${succeeded} done, ${failed} failed)`
      : snap.finishedAt ? 'Pipeline complete' : 'Idle',
    // Also include full snapshot for richer UIs
    snapshot: snap,
  });
});

// ----- routes: pipeline visibility & control ----------------------------------

/**
 * GET /api/pipeline/status
 * Returns the requesting user's pipeline state snapshot for live UI rendering.
 * Each user sees only their own pipeline.
 */
app.get('/api/pipeline/status', (_req, res) => {
  const userId = res.locals.userId;
  const state = getPipelineManager().get(userId);
  res.json(state.snapshot());
});

/**
 * POST /api/pipeline/cancel
 * Cancels the requesting user's currently running pipeline.
 */
app.post('/api/pipeline/cancel', (_req, res) => {
  const userId = res.locals.userId;
  const state = getPipelineManager().get(userId);
  const cancelled = state.cancel();
  res.json({ ok: true, cancelled });
});

/**
 * POST /api/pipeline/tasks/:jobId/cancel
 * Cancel a single running task within the requesting user's pipeline.
 */
app.post('/api/pipeline/tasks/:jobId/cancel', (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!Number.isInteger(jobId) || jobId < 1) {
    res.status(400).json({ error: 'Invalid job ID' });
    return;
  }

  const userId = res.locals.userId;
  const state = getPipelineManager().get(userId);
  const snap = state.snapshot();

  // Find which stage this job is in
  let foundStage: import('../jobs/pipeline-state.js').PipelineStage | null = null;
  for (const stage of ['extract', 'score', 'compose', 'audit'] as const) {
    if (snap.stages[stage]?.running.includes(jobId)) {
      foundStage = stage;
      break;
    }
  }

  if (!foundStage) {
    res.status(404).json({ error: `Job #${jobId} is not currently running in any stage` });
    return;
  }

  const cancelled = state.cancelTask(foundStage, jobId);
  res.json({ ok: true, cancelled, jobId, stage: foundStage });
});

// Run a single step for a specific job (non-blocking)
app.post('/api/run/step', async (req, res) => {
  const { jobId, step } = (req.body || {}) as { jobId?: number; step?: string };
  const userId = res.locals.userId;

  if (!jobId || !step || !['extract', 'score', 'compose', 'audit'].includes(step)) {
    res.status(400).json({ error: 'Requires jobId and a valid step' });
    return;
  }

  const owned = getDb().prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId);
  if (!owned) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  const manager = getPipelineManager();
  const reservation = manager.reserve(userId, 1);
  if (!reservation.allowed) {
    res.status(409).json({ error: reservation.reason });
    return;
  }
  const state = reservation.state;

  // Respond immediately
  res.status(202).json({ ok: true, message: `Running ${step} for job #${jobId}` });

  (async () => {
    try {
      await createDefaultPipeline(appContextForUser(userId), { progress: state, log: (message) => logger.info(message) })
        .runJobStage(jobId, step as import('../application/pipeline/types.js').PipelineStage);
    } catch (err) {
      logger.error(`Step ${step} for #${jobId} failed`, err);
      state.finishPipeline();
    }
  })();
});

// ----- routes: cover letter API ---------------------------------------------

app.post('/api/jobs/:id/cover-letter', async (req, res) => {
  const jobId = Number(req.params.id);
  const userId = res.locals.userId;
  const { tone } = (req.body || {}) as { tone?: string };
  const validTones = ['professional', 'enthusiastic', 'concise'] as const;
  const resolvedTone = tone && validTones.includes(tone as typeof validTones[number])
    ? (tone as typeof validTones[number])
    : 'professional';

  if (!Number.isInteger(jobId) || jobId < 1
    || !getDb().prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId)) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  try {
    const { generateCoverLetter } = await import('../jobs/cover-letter.js');
    const result = await generateCoverLetter(jobId, resolvedTone, undefined, userId);
    if (result.success) {
      res.json({ ok: true, pdfPath: result.pdfPath, tone: resolvedTone });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ----- routes: regenerate API -----------------------------------------------

app.post('/api/jobs/:id/regenerate', async (req, res) => {
  const jobId = Number(req.params.id);
  const userId = res.locals.userId;
  const { step, instruction } = (req.body || {}) as { step?: string; instruction?: string };

  if (!step || !['extract','score','compose','audit'].includes(step)) {
    res.status(400).json({ error: 'Valid step required: extract, score, compose, or audit' });
    return;
  }

  const db = getDb();
  const job = db.prepare('SELECT id, status FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId) as { id: number; status: string } | undefined;
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  const reservation = getPipelineManager().reserve(userId, 1);
  if (!reservation.allowed) {
    res.status(409).json({ error: reservation.reason });
    return;
  }

  // Reset status to before the selected step
  const statusBefore: Record<string, string> = {
    extract: 'new',      // clear extracted data for re-extract
    score: 'extracted',  // go back to before scoring
    compose: 'scored',   // go back to before compose
    audit: 'composed',   // go back to before audit
  };

  const newStatus = statusBefore[step]!;
  try {
    if (step === 'extract') {
      db.prepare(`UPDATE jobs SET title=NULL, company=NULL, location=NULL, description=NULL, apply_url=NULL,
        score=NULL, tier=NULL, score_reason=NULL, status=?, updated_at=datetime('now')
        WHERE id=? AND user_id=?`).run(newStatus, jobId, userId);
      db.prepare('DELETE FROM user_scores WHERE job_id = ? AND user_id = ?').run(jobId, userId);
    } else if (step === 'score') {
      db.prepare(`UPDATE jobs SET score=NULL, tier=NULL, score_reason=NULL, status=?, updated_at=datetime('now')
        WHERE id=? AND user_id=?`).run(newStatus, jobId, userId);
      db.prepare('DELETE FROM user_scores WHERE job_id = ? AND user_id = ?').run(jobId, userId);
    } else {
      db.prepare("UPDATE jobs SET status=?, updated_at=datetime('now') WHERE id=? AND user_id=?").run(newStatus, jobId, userId);
    }
    db.prepare("INSERT INTO events (job_id, event_type, description, created_at) VALUES (?, 'regenerate', ?, datetime('now'))")
      .run(jobId, `Regenerate ${step}${instruction ? ': ' + instruction : ''}`);
  } catch (error) {
    reservation.state.finishPipeline();
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }

  // Respond immediately
  res.status(202).json({ ok: true, message: `Regenerating ${step} for job #${jobId}` });

  // Run in background
  (async () => {
    try {
      await createDefaultPipeline(appContextForUser(userId), {
        progress: reservation.state,
        scoreInstruction: instruction,
        log: (message) => logger.info(message),
      }).runJobStage(jobId, step as import('../application/pipeline/types.js').PipelineStage);
      // Write event on success
      db.prepare("INSERT INTO events (job_id, event_type, description, created_at) VALUES (?, ?, ?, datetime('now'))")
        .run(jobId, `regenerate_${step}_done`, `Regenerated ${step}${instruction ? ' with instruction: ' + instruction : ''}`);
    } catch (err) {
      logger.error(`Regenerate ${step} for #${jobId} failed`, err);
      reservation.state.finishPipeline();
    }
  })();
});

// ----- routes: run-from API (restart pipeline from a stage) -------------------

/**
 * POST /api/jobs/:id/run-from
 * Reset a job to before the given stage and run the pipeline from there for
 * THIS single job only (unlike /api/run which runs all eligible jobs).
 * Body: { stage: 'extract' | 'score' | 'compose' | 'audit' }
 */
app.post('/api/jobs/:id/run-from', async (req, res) => {
  const jobId = Number(req.params.id);
  const { stage, fixLatex } = (req.body || {}) as { stage?: string; fixLatex?: boolean };
  const userId = res.locals.userId;
  const db = getDb();

  if (!stage || !['extract', 'score', 'compose', 'audit'].includes(stage)) {
    res.status(400).json({ error: 'Valid stage required: extract, score, compose, or audit' });
    return;
  }

  if (!Number.isInteger(jobId) || jobId < 1) {
    res.status(400).json({ error: 'Invalid job ID' });
    return;
  }

  const job = db.prepare('SELECT id, status, score FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId) as
    { id: number; status: string; score: number | null } | undefined;
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  const manager = getPipelineManager();
  const reservation = manager.reserve(userId, 1);
  if (!reservation.allowed) {
    res.status(409).json({ error: reservation.reason });
    return;
  }

  try {
    if (stage === 'extract') {
      db.prepare(`UPDATE jobs SET title=NULL, company=NULL, location=NULL, description=NULL, apply_url=NULL,
                  score=NULL, tier=NULL, score_reason=NULL, status='new',
                  updated_at=datetime('now') WHERE id=? AND user_id=?`).run(jobId, userId);
      db.prepare('DELETE FROM user_scores WHERE job_id = ? AND user_id = ?').run(jobId, userId);
    } else if (stage === 'score') {
      db.prepare(`UPDATE jobs SET score=NULL, tier=NULL, score_reason=NULL, status='extracted',
                  updated_at=datetime('now') WHERE id=? AND user_id=?`).run(jobId, userId);
      db.prepare('DELETE FROM user_scores WHERE job_id = ? AND user_id = ?').run(jobId, userId);
    } else if (stage === 'compose') {
      db.prepare(`UPDATE jobs SET status='scored', updated_at=datetime('now') WHERE id=? AND user_id=?`).run(jobId, userId);
    } else if (stage === 'audit') {
      db.prepare(`UPDATE jobs SET status='composed', updated_at=datetime('now') WHERE id=? AND user_id=?`).run(jobId, userId);
    }
    db.prepare("INSERT INTO events (job_id, event_type, description, created_at) VALUES (?, 'run_from', ?, datetime('now'))")
      .run(jobId, `Restart pipeline from ${stage}`);
  } catch (error) {
    reservation.state.finishPipeline();
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }

  // Respond immediately
  res.status(202).json({ ok: true, message: `Restarting pipeline from ${stage} for job #${jobId}` });

  // Run this single job through the pipeline in background
  const pipelineState = reservation.state;

  (async () => {
    try {
      await createDefaultPipeline(appContextForUser(userId), {
        progress: pipelineState,
        fixLatex,
        log: (message) => logger.info(message),
      }).runJobFrom(jobId, stage as import('../application/pipeline/types.js').PipelineStage);
      logger.info(`run-from #${jobId} complete`);
    } catch (err) {
      logger.error(`run-from #${jobId} failed`, err);
      pipelineState.finishPipeline();
    }
  })();
});

// ----- routes: batch add API ------------------------------------------------

app.post('/api/jobs/add-urls', (req, res) => {
  const { urls } = (req.body || {}) as { urls?: string[] };
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: 'Missing urls array in request body' });
    return;
  }

  const results = urls.map((url: string) => {
    if (typeof url !== 'string' || !url.trim()) {
      return { url, error: 'Invalid URL', added: false };
    }
    try {
      const r = addUrl(url.trim(), res.locals.userId);
      return {
        url: r.url,
        id: r.id,
        atsType: r.atsType,
        alreadyExisted: r.alreadyExisted,
        added: true,
      };
    } catch (err) {
      return { url, error: err instanceof Error ? err.message : String(err), added: false };
    }
  });

  const addedCount = results.filter((r: { added: boolean; alreadyExisted?: boolean }) => r.added && !r.alreadyExisted).length;
  const duplicateCount = results.filter((r: { added: boolean; alreadyExisted?: boolean }) => r.added && r.alreadyExisted).length;
  const errorCount = results.filter((r: { added: boolean }) => !r.added).length;

  res.json({ ok: true, added: addedCount, duplicates: duplicateCount, errors: errorCount, results });
});

app.post('/api/jobs/add-urls-and-run', async (req, res) => {
  const manager = getPipelineManager();
  const userId = res.locals.userId;

  const { urls } = (req.body || {}) as { urls?: string[] };
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: 'Missing urls array in request body' });
    return;
  }

  const reservation = manager.reserve(userId, urls.length);
  if (!reservation.allowed) {
    res.status(409).json({ error: reservation.reason });
    return;
  }

  const results = urls.map((url: string) => {
    if (typeof url !== 'string' || !url.trim()) {
      return { url, error: 'Invalid URL', added: false };
    }
    try {
      const r = addUrl(url.trim(), userId);
      return {
        url: r.url,
        id: r.id,
        atsType: r.atsType,
        alreadyExisted: r.alreadyExisted,
        added: true,
      };
    } catch (err) {
      return { url, error: err instanceof Error ? err.message : String(err), added: false };
    }
  });

  const addedCount = results.filter((r: { added: boolean; alreadyExisted?: boolean }) => r.added && !r.alreadyExisted).length;
  const duplicateCount = results.filter((r: { added: boolean; alreadyExisted?: boolean }) => r.added && r.alreadyExisted).length;
  const errorCount = results.filter((r: { added: boolean }) => !r.added).length;

  // Start pipeline in background
  res.status(202).json({
    ok: true,
    message: `${addedCount} added, ${duplicateCount} duplicates, ${errorCount} errors. Pipeline starting...`,
    added: addedCount,
    duplicates: duplicateCount,
    errors: errorCount,
    results,
  });

  // Get per-user pipeline state and capture userId before going async
  const pipelineState = reservation.state;
  const pipelineUserId = userId;

  // Run full pipeline in background
  (async () => {
    try {
      const { runAll } = await import('../jobs/run.js');
      await runAll(pipelineState, appContextForUser(pipelineUserId));
    } catch (err) {
      logger.error('Pipeline run failed', err);
      pipelineState.finishPipeline();
    }
  })();
});

// ----- routes: schedule API ------------------------------------------------

app.post('/api/schedule/start', async (req, res) => {
  const userId = res.locals.userId;
  const { interval } = (req.body || {}) as { interval?: number };
  if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 1) {
    res.status(400).json({ error: 'Requires interval in minutes (>= 1)' });
    return;
  }
  try {
    const { startSchedule: ss } = await import('../jobs/schedule.js');
    const started = ss(interval, appContextForUser(userId));
    if (!started) {
      res.status(409).json({ error: 'A schedule is already active for this user.' });
      return;
    }
    res.json({ ok: true, userId, message: `Scheduled every ${interval} minute(s)` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/schedule/stop', async (_req, res) => {
  const userId = res.locals.userId;
  try {
    const { stopSchedule: ssStop } = await import('../jobs/schedule.js');
    res.json({ ok: true, userId, stopped: ssStop(userId) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/schedule/status', async (_req, res) => {
  const userId = res.locals.userId;
  try {
    const { isScheduleActive } = await import('../jobs/schedule.js');
    res.json({ userId, active: isScheduleActive(userId) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ----- routes: market data API ---------------------------------------------

app.get('/api/market-data', async (_req, res) => {
  const keyPrefix = typeof _req.query.key === 'string' ? _req.query.key : undefined;
  try {
    const { getMarketData } = await import('../jobs/market-data.js');
    const data = getMarketData(keyPrefix);
    res.json({ ok: true, data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ----- routes: discover API ------------------------------------------------

app.get('/api/discover', async (req, res) => {
  const query = typeof req.query.query === 'string' ? req.query.query : '';
  const location = typeof req.query.location === 'string' ? req.query.location : undefined;
  const source = typeof req.query.source === 'string' ? req.query.source : undefined;

  if (!query) {
    res.status(400).json({ error: 'Missing query parameter' });
    return;
  }

  try {
    const { discoverJobs } = await import('../jobs/discover.js');
    const results = await discoverJobs({ query, location, sources: source ? [source as 'greenhouse' | 'lever' | 'ashby' | 'linkedin'] : undefined });
    const sources = [...new Set(results.map((r: { source: string }) => r.source))];
    res.json({ ok: true, results, sources });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ----- routes: delete API (POST-based for Express 5 compat) ---------------

app.post('/api/jobs/:id/delete', (req, res) => {
  const jobId = Number(req.params.id);
  const db = getDb();

  if (!Number.isInteger(jobId) || jobId < 1) {
    res.status(400).json({ error: 'Invalid job ID' });
    return;
  }

  // Verify job belongs to this user
  const job = db.prepare('SELECT user_id FROM jobs WHERE id = ?').get(jobId) as { user_id: number } | undefined;
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (job.user_id !== res.locals.userId) {
    res.status(403).json({ error: 'Not your job' });
    return;
  }

  try {
    const result = deleteJob(jobId, res.locals.userId);
    res.json({ ok: true, deleted: result.deleted, job: result.jobs[0] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(404).json({ error: msg });
  }
});

app.post('/api/jobs/delete', (req, res) => {
  const { tier, status } = req.body as { tier?: string; status?: string };

  try {
    if (tier) {
      const result = deleteByTier(tier, res.locals.userId);
      res.json({ ok: true, deleted: result.deleted });
    } else if (status) {
      const result = deleteByStatus(status, res.locals.userId);
      res.json({ ok: true, deleted: result.deleted });
    } else {
      res.status(400).json({ error: 'Provide tier or status in request body' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ----- routes: application tracking API ------------------------------------

/**
 * Mark a job as applied (or update application status).
 * POST /api/jobs/:id/apply
 * Body: { status?: string, notes?: string, resumeVersionId?: number }
 */
app.post('/api/jobs/:id/apply', (req, res) => {
  const jobId = Number(req.params.id);
  const userId = res.locals.userId;
  const db = getDb();

  if (!Number.isInteger(jobId) || jobId < 1) {
    res.status(400).json({ error: 'Invalid job ID' });
    return;
  }

  const job = db.prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  const { status, notes, resumeVersionId } = (req.body || {}) as {
    status?: string; notes?: string; resumeVersionId?: number;
  };
  const newStatus = status || 'submitted';

  if (resumeVersionId !== undefined) {
    if (!Number.isInteger(resumeVersionId) || resumeVersionId < 1) {
      res.status(400).json({ error: 'Invalid resumeVersionId' });
      return;
    }
    const version = db.prepare(`
      SELECT rv.id, rv.pdf_path
      FROM resume_versions rv
      JOIN resume_drafts rd ON rd.id = rv.draft_id AND rd.status = 'rendered'
      WHERE rv.id = ? AND rv.job_id = ? AND rv.user_id = ? AND rv.pdf_path IS NOT NULL
    `).get(resumeVersionId, jobId, userId) as { id: number; pdf_path: string } | undefined;
    if (!version || !existsSync(version.pdf_path)) {
      res.status(400).json({ error: 'Resume version is not a rendered artifact owned by this user and job.' });
      return;
    }
  }

  // Upsert application
  const existing = db.prepare(
    'SELECT id FROM applications WHERE job_id = ? AND user_id = ?',
  ).get(jobId, userId) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE applications SET status = ?, notes = ?, submitted_at = COALESCE(submitted_at, datetime('now')),
       resume_version_id = COALESCE(?, resume_version_id),
       updated_at = datetime('now') WHERE id = ? AND job_id = ? AND user_id = ?`,
    ).run(newStatus, notes ?? null, resumeVersionId ?? null, existing.id, jobId, userId);
  } else {
    db.prepare(
      `INSERT INTO applications (job_id, user_id, status, submitted_at, notes, resume_version_id, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), ?, ?, datetime('now'), datetime('now'))`,
    ).run(jobId, userId, newStatus, notes ?? null, resumeVersionId ?? null);
  }

  // Update job status to 'applied' if submitting
  if (newStatus === 'submitted') {
    db.prepare("UPDATE jobs SET status = 'applied', updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(jobId, userId);
  }

  // Log event
  db.prepare(
    "INSERT INTO events (job_id, event_type, description, created_at) VALUES (?, 'apply', ?, datetime('now'))",
  ).run(jobId, `Application ${newStatus}${notes ? ': ' + notes : ''}`);

  res.json({ ok: true, jobId, userId, status: newStatus });
});

/**
 * Record a response to an application.
 * POST /api/jobs/:id/response
 * Body: { responseType: 'replied' | 'rejected' | 'interview' | 'offer' | 'accepted', notes?: string }
 */
app.post('/api/jobs/:id/response', (req, res) => {
  const jobId = Number(req.params.id);
  const userId = res.locals.userId;
  const db = getDb();

  if (!Number.isInteger(jobId) || jobId < 1) {
    res.status(400).json({ error: 'Invalid job ID' });
    return;
  }

  const ownedJob = db.prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId);
  if (!ownedJob) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  const { responseType, notes } = (req.body || {}) as {
    responseType?: string; notes?: string;
  };

  if (!responseType || !['replied', 'rejected', 'interview', 'offer', 'accepted'].includes(responseType)) {
    res.status(400).json({ error: 'Valid responseType required: replied, rejected, interview, offer, accepted' });
    return;
  }

  // Update application
  const existing = db.prepare(
    'SELECT id FROM applications WHERE job_id = ? AND user_id = ?',
  ).get(jobId, userId) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE applications SET status = 'responded', response_type = ?, responded_at = datetime('now'),
       notes = CASE WHEN ? IS NOT NULL THEN ? ELSE notes END,
       updated_at = datetime('now') WHERE id = ? AND job_id = ? AND user_id = ?`,
    ).run(responseType, notes ?? null, notes ?? null, existing.id, jobId, userId);
  } else {
    // Create application record if not exists
    db.prepare(
      `INSERT INTO applications (job_id, user_id, status, response_type, responded_at, notes, created_at, updated_at)
       VALUES (?, ?, 'responded', ?, datetime('now'), ?, datetime('now'), datetime('now'))`,
    ).run(jobId, userId, responseType, notes ?? null);
  }

  // Log event
  db.prepare(
    "INSERT INTO events (job_id, event_type, description, created_at) VALUES (?, ?, ?, datetime('now'))",
  ).run(jobId, `response_${responseType}`, notes ?? null);

  res.json({ ok: true, jobId, userId, responseType });
});

/**
 * Get application status for a job (for the active user).
 * GET /api/jobs/:id/application
 */
app.get('/api/jobs/:id/application', (req, res) => {
  const jobId = Number(req.params.id);
  const userId = res.locals.userId;
  const db = getDb();

  if (!Number.isInteger(jobId) || jobId < 1
    || !db.prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId)) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  const app = db.prepare(
    'SELECT * FROM applications WHERE job_id = ? AND user_id = ?',
  ).get(jobId, userId) as {
    id: number; status: string; submitted_at: string | null;
    responded_at: string | null; response_type: string | null;
    notes: string | null; created_at: string;
  } | undefined;

  res.json({ application: app ?? null });
});

// ----- start ---------------------------------------------------------------

export function startUi(port: number = PORT): void {
  app.listen(port, '127.0.0.1', () => {
    logger.info(`JobBot UI running at http://localhost:${port}`);
  });
}
