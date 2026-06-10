/**
 * JobBot Web UI — v0.5
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
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { getDb } from '../db/client.js';
import { deleteJob, deleteByTier, deleteByStatus } from '../jobs/delete.js';
import { addUrl } from '../jobs/add-url.js';
import { extractSalaryRanges } from '../jobs/market-data.js';
import { PROJECT_ROOT, LOCAL_DIR, RESUMES_DIR, CANDIDATE_PATH, PREFERENCES_PATH, ANSWERS_PATH } from '../utils/paths.js';
import { getDeepseekKey, getDeepseekModel } from '../utils/config.js';
import { logAiCall, extractUsage } from '../utils/ai-logger.js';
import { logger } from '../utils/logger.js';

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

// Serve generated PDFs as static files
app.use('/resumes', express.static(RESUMES_DIR));

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

  // Tier counts (includes all scored jobs including score=0 deal-breakers)
  const tierCounts = db.prepare(`
    SELECT tier, COUNT(*) as count FROM jobs
    WHERE tier IS NOT NULL AND score IS NOT NULL
    GROUP BY tier
  `).all() as { tier: string; count: number }[];

  const counts: TierCount = { A: 0, B: 0, C: 0, D: 0 };
  for (const row of tierCounts) {
    if (row.tier in counts) {
      counts[row.tier as keyof TierCount] = row.count;
    }
  }

  const totalJobs = (db.prepare('SELECT COUNT(*) as count FROM jobs').get() as { count: number }).count;

  // Pipeline stage counts for funnel
  const stageCounts = {
    ingested: totalJobs,
    extracted: (db.prepare('SELECT COUNT(*) as c FROM jobs WHERE title IS NOT NULL').get() as { c: number }).c,
    scored: (db.prepare('SELECT COUNT(*) as c FROM jobs WHERE score IS NOT NULL').get() as { c: number }).c,
    composed: (db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status IN ('composed','audited')").get() as { c: number }).c,
    audited: (db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'audited'").get() as { c: number }).c,
  };

  // Top companies
  const topCompanies = db.prepare(`
    SELECT company, COUNT(*) as count FROM jobs
    WHERE company IS NOT NULL AND company != ''
    GROUP BY company ORDER BY count DESC LIMIT 8
  `).all() as { company: string; count: number }[];

  res.render('dashboard', {
    title: 'Dashboard',
    jobs,
    counts,
    totalJobs,
    stageCounts,
    topCompanies,
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

  // Parse score_reason into sections
  const reasonParagraphs = job.score_reason
    ? job.score_reason.split(/(?<=\.)\s+(?=[A-Z])/).filter(Boolean)
    : [];

  // Load stage outputs for interactive pipeline
  const resumeVersion = db.prepare(
    'SELECT pdf_path FROM resume_versions WHERE job_id = ? AND pdf_path IS NOT NULL ORDER BY created_at DESC LIMIT 1',
  ).get(jobId) as { pdf_path: string | null } | undefined;

  // Check for existing cover letter
  const clPdfPath = `${RESUMES_DIR}/${jobId}-cover-letter.pdf`;
  const hasCoverLetter = existsSync(clPdfPath);

  let auditData: { overallScore?: number; contentScore?: number; visualScore?: number; contentIssues?: unknown[]; visualIssues?: unknown[] } | null = null;
  const auditPath = `${RESUMES_DIR}/audit/${jobId}-audit.json`;
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
    reasonParagraphs,
    events,
    resumeVersion,
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
     WHERE title IS NOT NULL AND score IS NULL
     ORDER BY id`,
  ).all() as { id: number; title: string | null; company: string | null }[];
  const extractFailed: never[] = []; // scoring doesn't fail, it falls back to deterministic
  const extractDone = (totalJobs - ingestQueued.length - ingestFailed.length) - extractQueued.length;

  // Step 3 results: scored jobs (score IS NOT NULL, includes score=0 deal-breakers)
  const scoredCount = (db.prepare(
    'SELECT COUNT(*) as count FROM jobs WHERE score IS NOT NULL',
  ).get() as { count: number }).count;

  // Step 4 (Score → Compose): only A/B/C tier, exclude D (deal-breakers)
  const composeQueued = db.prepare(
    `SELECT id, title, company FROM jobs
     WHERE status = 'scored' AND score > 0 AND tier != 'D'
     ORDER BY id`,
  ).all() as { id: number; title: string | null; company: string | null }[];
  const composeDone = (db.prepare(
    `SELECT COUNT(*) as count FROM jobs WHERE status IN ('composed', 'audited')`,
  ).get() as { count: number }).count;
  const composeEligible = composeDone + composeQueued.length;
  const dSkipped = (db.prepare(
    `SELECT COUNT(*) as count FROM jobs WHERE status = 'scored' AND tier = 'D'`,
  ).get() as { count: number }).count;

  // Step 5 (Compose → Audit): queued = composed but not audited
  const auditQueued = db.prepare(
    `SELECT id, title, company FROM jobs
     WHERE status = 'composed'
     ORDER BY id`,
  ).all() as { id: number; title: string | null; company: string | null }[];
  const auditDone = (db.prepare(
    `SELECT COUNT(*) as count FROM jobs WHERE status = 'audited'`,
  ).get() as { count: number }).count;

  // Tier distribution (includes all scored jobs)
  const tierRows = db.prepare(`
    SELECT tier, COUNT(*) as count FROM jobs
    WHERE tier IS NOT NULL AND score IS NOT NULL
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
    // Step 4
    composeQueued,
    composeDone,
    composeEligible,
    dSkipped,
    // Step 5
    auditQueued,
    auditDone,
  });
});

// ----- routes: events timeline ----------------------------------------------

app.get('/events', (req, res) => {
  const db = getDb();
  const jobFilter = typeof req.query.job === 'string' ? Number(req.query.job) : null;
  const typeFilter = typeof req.query.type === 'string' ? req.query.type : null;

  let query = `SELECT e.*, j.title as job_title, j.company as job_company
    FROM events e LEFT JOIN jobs j ON e.job_id = j.id`;
  const conditions: string[] = [];
  const params: unknown[] = [];

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

  const eventTypes = (db.prepare(
    'SELECT DISTINCT event_type FROM events ORDER BY event_type',
  ).all() as { event_type: string }[]).map((r) => r.event_type);

  res.render('events', {
    title: 'Event Timeline',
    events,
    eventTypes,
    filters: { job: jobFilter, type: typeFilter },
  });
});

// ----- routes: AI log -------------------------------------------------------

app.get('/ai-log', (_req, res) => {
  const logDir = `${LOCAL_DIR}/logs`;

  interface LogEntry { timestamp: string; operation: string; model: string; provider: string; requestSummary: string; responseSummary: string; totalTokens?: number; durationMs: number; success: boolean; time?: string; duration?: string; error?: string; }

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

  const totalPrompt = entries.reduce((sum: number, e: any) => sum + (e.promptTokens || 0), 0);
  const totalCompletion = entries.reduce((sum: number, e: any) => sum + (e.completionTokens || 0), 0);
  const totalCached = entries.reduce((sum: number, e: any) => sum + (e.cachedTokens || 0), 0);
  const operations = [...new Set(entries.map((e: any) => e.operation))].sort();

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

const PROFILE_FILES = {
  candidate: { path: CANDIDATE_PATH, label: 'Candidate Profile', description: 'Work history, education, skills, links. The source of truth for resume tailoring.' },
  preferences: { path: PREFERENCES_PATH, label: 'Preferences', description: 'Job titles, locations, industries, deal-breakers, and scoring weights.' },
  answers: { path: ANSWERS_PATH, label: 'Application Answers', description: 'Standard application questions. Sensitive — never shared or uploaded.' },
} as const;

type ProfileFile = keyof typeof PROFILE_FILES;

function readProfileYaml(file: ProfileFile): string {
  const p = PROFILE_FILES[file];
  if (!existsSync(p.path)) return '';
  return readFileSync(p.path, 'utf-8');
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
  const candidate = readProfileYaml('candidate');
  const prefs = readProfileYaml('preferences');
  const answers = readProfileYaml('answers');

  res.render('profile', {
    title: 'Profile',
    candidateSize: candidate ? `${candidate.split('\n').length} lines` : 'Not found',
    candidateSections: candidate ? getYamlSections(candidate) : [],
    prefsSize: prefs ? `${prefs.split('\n').length} lines` : 'Not found',
    prefsSections: prefs ? getYamlSections(prefs) : [],
    answersSize: answers ? `${answers.split('\n').length} lines` : 'Not found',
    answersSections: answers ? getYamlSections(answers) : [],
  });
});

app.get('/profile/:file', (req, res) => {
  const file = req.params.file as ProfileFile;
  if (!(file in PROFILE_FILES)) {
    res.status(404).send('Profile file not found');
    return;
  }

  const info = PROFILE_FILES[file];
  const yamlRaw = readProfileYaml(file);

  res.render('profile-edit', {
    title: `${info.label} — Profile`,
    profileLabel: info.label,
    profileFile: file,
    filePath: `local/profile/${file}.yaml`,
    description: info.description,
    yamlRaw,
    yamlEscaped: yamlRaw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  });
});

// ----- routes: profile API --------------------------------------------------

app.put('/api/profile/:file', (req, res) => {
  const file = req.params.file as ProfileFile;
  if (!(file in PROFILE_FILES)) {
    res.status(400).json({ error: 'Invalid profile file' });
    return;
  }

  const { yaml } = req.body as { yaml?: string };
  if (typeof yaml !== 'string') {
    res.status(400).json({ error: 'Missing yaml field' });
    return;
  }

  try {
    writeFileSync(PROFILE_FILES[file].path, yaml, 'utf-8');
    logger.info(`Updated profile: ${file}.yaml`);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/profile/:file/ai-edit', async (req, res) => {
  const file = req.params.file as ProfileFile;
  if (!(file in PROFILE_FILES)) {
    res.status(400).json({ error: 'Invalid profile file' });
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

  const currentYaml = readProfileYaml(file);
  if (!currentYaml) {
    res.status(404).json({ error: `Profile file not found: ${file}.yaml` });
    return;
  }

  const prompt = [
    'You are editing a YAML configuration file. The user will give you an instruction.',
    'Return ONLY the complete updated YAML — keep everything that was not mentioned exactly as-is.',
    'Do NOT add commentary. Do NOT wrap in markdown code fences. Just the raw YAML.',
    '',
    'Rules:',
    '- Only change what the user asks to change.',
    '- Preserve all comments (# lines).',
    '- Preserve all structure, indentation, and formatting.',
    '- If the instruction is unclear, make your best guess and note it in a comment.',
  ].join('\n');

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

// ----- run service state ----------------------------------------------------

interface RunState {
  running: boolean;
  stage: 'idle' | 'extract' | 'score' | 'compose' | 'audit' | 'complete';
  startedAt: string | null;
  current: number;
  total: number;
  succeeded: number;
  failed: number;
  message: string;
}

const runState: RunState = {
  running: false,
  stage: 'idle',
  startedAt: null,
  current: 0,
  total: 0,
  succeeded: 0,
  failed: 0,
  message: '',
};

function resetRunState(): void {
  runState.running = false;
  runState.stage = 'idle';
  runState.startedAt = null;
  runState.current = 0;
  runState.total = 0;
  runState.succeeded = 0;
  runState.failed = 0;
  runState.message = '';
}

// ----- routes: run API (POST-based, launches background pipeline) ------------

app.post('/api/run', async (req, res) => {
  if (runState.running) {
    res.status(409).json({ error: 'Pipeline is already running', ...runState });
    return;
  }

  const { step, jobId } = (req.body || {}) as { step?: string; jobId?: number };

  // Reset and mark running
  resetRunState();
  runState.running = true;
  runState.startedAt = new Date().toISOString();

  // Respond immediately with 202 Accepted
  res.status(202).json({ ok: true, message: 'Pipeline started' });

  // Run in background (don't await — fire and update state)
  (async () => {
    try {
      const { runExtract, runScore, runCompose, runAudit, runJob } = await import('../jobs/run.js');

      if (jobId) {
        // Single job — run through all stages
        runState.stage = 'extract';
        runState.message = `Running pipeline for job #${jobId}`;
        await runJob(jobId);
        runState.stage = 'complete';
        runState.message = `Pipeline complete for job #${jobId}`;
      } else if (step === 'extract') {
        runState.stage = 'extract';
        runState.message = 'Extracting queued jobs...';
        // Patch runExtract to update progress
        await runExtract();
        runState.stage = 'complete';
        runState.message = 'Extract complete';
      } else if (step === 'score') {
        runState.stage = 'score';
        runState.message = 'Scoring queued jobs...';
        await runScore();
        runState.stage = 'complete';
        runState.message = 'Score complete';
      } else if (step === 'compose') {
        runState.stage = 'compose';
        runState.message = 'Composing queued jobs...';
        await runCompose();
        runState.stage = 'complete';
        runState.message = 'Compose complete';
      } else if (step === 'audit') {
        runState.stage = 'audit';
        runState.message = 'Auditing queued jobs...';
        await runAudit();
        runState.stage = 'complete';
        runState.message = 'Audit complete';
      } else {
        // Full pipeline
        runState.stage = 'extract';
        runState.message = 'Extracting...';
        await runExtract();

        runState.stage = 'score';
        runState.message = 'Scoring...';
        await runScore();

        runState.stage = 'compose';
        runState.message = 'Composing...';
        await runCompose();

        runState.stage = 'audit';
        runState.message = 'Auditing...';
        await runAudit();

        runState.stage = 'complete';
        runState.message = 'Full pipeline complete';
      }
    } catch (err) {
      runState.message = err instanceof Error ? err.message : String(err);
      runState.stage = 'idle';
      logger.error('Pipeline run failed', err);
    } finally {
      runState.running = false;
    }
  })();
});

app.get('/api/run/status', (_req, res) => {
  res.json(runState);
});

// Run a single step for a specific job (non-blocking)
app.post('/api/run/step', async (req, res) => {
  const { jobId, step } = (req.body || {}) as { jobId?: number; step?: string };

  if (!jobId || !step) {
    res.status(400).json({ error: 'Requires jobId and step' });
    return;
  }

  // Respond immediately
  res.status(202).json({ ok: true, message: `Running ${step} for job #${jobId}` });

  // Run in background
  (async () => {
    try {
      const { extractJob } = await import('../jobs/extract.js');
      const { composeJob } = await import('../jobs/compose.js');
      const { auditJob } = await import('../jobs/audit.js');

      switch (step) {
        case 'extract': {
          const result = await extractJob(jobId);
          logger.info(`Step extract for #${jobId}: ${result.success ? 'ok' : result.error}`);
          break;
        }
        case 'score': {
          const db = getDb();
          const job = db.prepare('SELECT id, title, company, location, description FROM jobs WHERE id = ?').get(jobId) as any;
          if (!job) break;
          try {
            const { scoreJobWithLLM } = await import('../jobs/scorers/llm.js');
            const r = await scoreJobWithLLM(job);
            db.prepare("UPDATE jobs SET score=?, tier=?, score_reason=?, status='scored', updated_at=datetime('now') WHERE id=?")
              .run(r.score, r.tier, r.reason, jobId);
            // Extract market data after scoring
            const { extractMarketData: emdStep } = await import('../jobs/market-data.js');
            emdStep(job as { id: number; title: string | null; location: string | null; description: string | null });
          } catch (err) {
            const { scoreJobDeterministic } = await import('../jobs/scorers/deterministic.js');
            const prefs: any = { preferred_titles: [], preferred_locations: { remote: false, cities: [] }, preferred_companies: [], preferred_industries: [], deal_breakers: { description: '', keywords: [] }, weights: {}, tiers: { A: 0.8, B: 0.65, C: 0.5, D: 0 } };
            const fallback = scoreJobDeterministic(job, prefs);
            db.prepare("UPDATE jobs SET score=?, tier=?, score_reason=?, status='scored', updated_at=datetime('now') WHERE id=?")
              .run(fallback.score, fallback.tier, fallback.reason, jobId);
          }
          break;
        }
        case 'compose': {
          await composeJob(jobId);
          break;
        }
        case 'audit': {
          await auditJob(jobId);
          break;
        }
      }
    } catch (err) {
      logger.error(`Step ${step} for #${jobId} failed`, err);
    }
  })();
});

// ----- routes: cover letter API ---------------------------------------------

app.post('/api/jobs/:id/cover-letter', async (req, res) => {
  const jobId = Number(req.params.id);
  const { tone } = (req.body || {}) as { tone?: string };
  const validTones = ['professional', 'enthusiastic', 'concise'] as const;
  const resolvedTone = tone && validTones.includes(tone as typeof validTones[number])
    ? (tone as typeof validTones[number])
    : 'professional';

  try {
    const { generateCoverLetter } = await import('../jobs/cover-letter.js');
    const result = await generateCoverLetter(jobId, resolvedTone);
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
  const { step, instruction } = (req.body || {}) as { step?: string; instruction?: string };

  if (!step || !['extract','score','compose','audit'].includes(step)) {
    res.status(400).json({ error: 'Valid step required: extract, score, compose, or audit' });
    return;
  }

  const db = getDb();
  const job = db.prepare('SELECT id, status FROM jobs WHERE id = ?').get(jobId) as { id: number; status: string } | undefined;
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  // Reset status to before the selected step
  const statusBefore: Record<string, string> = {
    extract: 'new',      // clear extracted data for re-extract
    score: 'extracted',  // go back to before scoring
    compose: 'scored',   // go back to before compose
    audit: 'composed',   // go back to before audit
  };

  const newStatus = statusBefore[step]!;
  if (step === 'extract') {
    db.prepare('UPDATE jobs SET title=NULL, company=NULL, location=NULL, description=NULL, apply_url=NULL, status=?, updated_at=datetime(\'now\') WHERE id=?').run(newStatus, jobId);
  } else {
    db.prepare("UPDATE jobs SET status=?, updated_at=datetime('now') WHERE id=?").run(newStatus, jobId);
  }

  // Log event
  db.prepare("INSERT INTO events (job_id, event_type, description, created_at) VALUES (?, 'regenerate', ?, datetime('now'))")
    .run(jobId, `Regenerate ${step}${instruction ? ': ' + instruction : ''}`);

  // Respond immediately
  res.status(202).json({ ok: true, message: `Regenerating ${step} for job #${jobId}` });

  // Run in background
  (async () => {
    try {
      const { extractJob } = await import('../jobs/extract.js');
      const { composeJob } = await import('../jobs/compose.js');
      const { auditJob } = await import('../jobs/audit.js');

      switch (step) {
        case 'extract': {
          await extractJob(jobId);
          break;
        }
        case 'score': {
          const j = db.prepare('SELECT id, title, company, location, description FROM jobs WHERE id=?').get(jobId) as any;
          if (!j) break;
          try {
            const { scoreJobWithLLM } = await import('../jobs/scorers/llm.js');
            const r = instruction
              ? await scoreJobWithLLM(j, instruction)
              : await scoreJobWithLLM(j);
            db.prepare("UPDATE jobs SET score=?, tier=?, score_reason=?, status='scored', updated_at=datetime('now') WHERE id=?")
              .run(r.score, r.tier, r.reason, jobId);
            const { extractMarketData: emdRegen } = await import('../jobs/market-data.js');
            emdRegen(j as { id: number; title: string | null; location: string | null; description: string | null });
          } catch (err) {
            const { scoreJobDeterministic } = await import('../jobs/scorers/deterministic.js');
            const prefs: any = { preferred_titles: [], preferred_locations: {remote:false,cities:[]}, preferred_companies: [], preferred_industries: [], deal_breakers: {description:'',keywords:[]}, weights: {}, tiers: {A:0.8,B:0.65,C:0.5,D:0} };
            const fallback = scoreJobDeterministic(j, prefs);
            db.prepare("UPDATE jobs SET score=?, tier=?, score_reason=?, status='scored', updated_at=datetime('now') WHERE id=?")
              .run(fallback.score, fallback.tier, fallback.reason, jobId);
          }
          break;
        }
        case 'compose': {
          await composeJob(jobId);
          break;
        }
        case 'audit': {
          await auditJob(jobId);
          break;
        }
      }
      // Write event on success
      db.prepare("INSERT INTO events (job_id, event_type, description, created_at) VALUES (?, ?, ?, datetime('now'))")
        .run(jobId, `regenerate_${step}_done`, `Regenerated ${step}${instruction ? ' with instruction: ' + instruction : ''}`);
    } catch (err) {
      logger.error(`Regenerate ${step} for #${jobId} failed`, err);
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
      const r = addUrl(url.trim());
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
  if (runState.running) {
    res.status(409).json({ error: 'Pipeline is already running', ...runState });
    return;
  }

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
      const r = addUrl(url.trim());
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
  resetRunState();
  runState.running = true;
  runState.startedAt = new Date().toISOString();

  res.status(202).json({
    ok: true,
    message: `${addedCount} added, ${duplicateCount} duplicates, ${errorCount} errors. Pipeline starting...`,
    added: addedCount,
    duplicates: duplicateCount,
    errors: errorCount,
    results,
  });

  // Run full pipeline in background
  (async () => {
    try {
      const { runAll: runAllPipeline } = await import('../jobs/run.js');
      await runAllPipeline();
      runState.stage = 'complete';
      runState.message = 'Full pipeline complete';
    } catch (err) {
      runState.message = err instanceof Error ? err.message : String(err);
      runState.stage = 'idle';
      logger.error('Pipeline run failed', err);
    } finally {
      runState.running = false;
    }
  })();
});

// ----- routes: schedule API ------------------------------------------------

app.post('/api/schedule/start', async (req, res) => {
  const { interval } = (req.body || {}) as { interval?: number };
  if (!interval || typeof interval !== 'number' || interval < 1) {
    res.status(400).json({ error: 'Requires interval in minutes (>= 1)' });
    return;
  }
  try {
    const { startSchedule: ss } = await import('../jobs/schedule.js');
    ss(interval);
    res.json({ ok: true, message: `Scheduled every ${interval} minute(s)` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/schedule/stop', async (_req, res) => {
  try {
    const { stopSchedule: ssStop } = await import('../jobs/schedule.js');
    ssStop();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/schedule/status', async (_req, res) => {
  try {
    const { isScheduleActive } = await import('../jobs/schedule.js');
    res.json({ active: isScheduleActive() });
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

  if (!Number.isInteger(jobId) || jobId < 1) {
    res.status(400).json({ error: 'Invalid job ID' });
    return;
  }

  try {
    const result = deleteJob(jobId);
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
      const result = deleteByTier(tier);
      res.json({ ok: true, deleted: result.deleted });
    } else if (status) {
      const result = deleteByStatus(status);
      res.json({ ok: true, deleted: result.deleted });
    } else {
      res.status(400).json({ error: 'Provide tier or status in request body' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ----- start ---------------------------------------------------------------

export function startUi(port: number = PORT): void {
  app.listen(port, () => {
    logger.info(`JobBot UI running at http://localhost:${port}`);
  });
}
