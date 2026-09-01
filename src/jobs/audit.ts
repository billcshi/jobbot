import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/client.js';
import { PROJECT_ROOT, jobResumeDir } from '../utils/paths.js';
import { getDeepseekKey, getAnthropicKey, getOpenAIKey, getDeepseekModel, getDeepseekThinking } from '../utils/config.js';
import { parseLLMJson } from '../utils/parse-llm-json.js';
import { logAiCall, extractUsage } from '../utils/ai-logger.js';
import { logger } from '../utils/logger.js';
import { getActiveUserId } from '../utils/user-context.js';
import { buildCandidateEvidence, evidencePromptContext } from '../domain/resume/evidence.js';
import { parseProvenancedTailoredResumeData } from '../domain/resume/contract.js';
import { ProfileRepository } from '../repositories/profile-repository.js';
import { requestAiJson } from '../utils/http-json.js';

const AUDIT_ATS = readFileSync(`${PROJECT_ROOT}/prompts/audit-ats.md`, 'utf-8');
const AUDIT_HM = readFileSync(`${PROJECT_ROOT}/prompts/audit-hm.md`, 'utf-8');
const AUDIT_FORMAT = readFileSync(`${PROJECT_ROOT}/prompts/audit-format.md`, 'utf-8');

const SHARED_AUDIT_OUTPUT_CONTRACT = [
  'Your JSON response MUST include: score (number 0-100), summary (string), and issues (array).',
  'Every issue severity MUST be exactly one of: high, medium, low.',
  'Every issue category MUST be exactly one of: accuracy, formatting, keywords, layout, visual, content.',
  'Do not use synonyms such as moderate, major, minor, experience, or contact as enum values.',
].join('\n');

/** Committee reviewers: each has a name, prompt, and weight in the combined score. */
const COMMITTEE: { name: string; prompt: string; weight: number }[] = [
  { name: 'ATS Screener', prompt: AUDIT_ATS, weight: 0.30 },
  { name: 'Hiring Manager', prompt: AUDIT_HM, weight: 0.40 },
  { name: 'Format Reviewer', prompt: AUDIT_FORMAT, weight: 0.30 },
];

/** Maximum compose→audit retry attempts before giving up. */
const MAX_AUDIT_ATTEMPTS = 3;

export interface AuditIssue {
  severity: 'high' | 'medium' | 'low';
  category: 'accuracy' | 'formatting' | 'keywords' | 'layout' | 'visual' | 'content';
  description: string;
  suggestion: string;
}

export interface AuditResult {
  success: boolean;
  jobId: number;
  contentIssues: AuditIssue[];
  visualIssues: AuditIssue[];
  overallScore: number; // 0–100
  summary: string;
  error?: string;
}

export type VisualAuditStatus = 'passed' | 'failed' | 'unavailable';

interface VisualAuditResult {
  status: VisualAuditStatus;
  issues: AuditIssue[];
  score: number;
  summary: string;
}

export function parseLocalVisualReview(
  value: unknown,
  expected: { jobId: number; resumeVersionId: number; resumeSha256: string },
): VisualAuditResult & { reviewer: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Local visual review must be an object');
  }
  const root = value as Record<string, unknown>;
  if (root['schema_version'] !== 1) throw new Error('Local visual review schema_version must be 1');
  if (root['job_id'] !== expected.jobId) throw new Error('Local visual review job does not match');
  if (root['resume_version_id'] !== expected.resumeVersionId) {
    throw new Error('Local visual review resume version does not match');
  }
  if (root['resume_sha256'] !== expected.resumeSha256) {
    throw new Error('Local visual review PDF hash does not match');
  }
  if (root['status'] !== 'passed') throw new Error('Local visual review status must be passed');
  if (root['reviewer_type'] !== 'human' && root['reviewer_type'] !== 'agent') {
    throw new Error('Local visual review reviewer_type must be human or agent');
  }
  if (typeof root['reviewer'] !== 'string' || root['reviewer'].trim().length === 0) {
    throw new Error('Local visual review requires a reviewer');
  }
  const parsed = parseAuditModelOutput(root);
  return { status: 'passed', ...parsed, reviewer: root['reviewer'].trim() };
}

export function parseLocalVisualReviewSafely(
  value: unknown,
  expected: { jobId: number; resumeVersionId: number; resumeSha256: string },
): { review: (VisualAuditResult & { reviewer: string }) | null; error?: string } {
  try {
    return { review: parseLocalVisualReview(value, expected) };
  } catch (error) {
    return { review: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function loadLocalVisualReview(
  jobId: number,
  resumeVersionId: number,
  resumeSha256: string,
): { review: (VisualAuditResult & { reviewer: string }) | null; error?: string } {
  const reviewPath = `${jobResumeDir(jobId)}/visual-review.json`;
  if (!existsSync(reviewPath)) return { review: null };
  try {
    return parseLocalVisualReviewSafely(JSON.parse(readFileSync(reviewPath, 'utf-8')) as unknown, {
      jobId,
      resumeVersionId,
      resumeSha256,
    });
  } catch (error) {
    return { review: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function calculateAuditOutcome(
  contentScore: number,
  contentSucceeded: boolean,
  visualScore: number,
  visualStatus: VisualAuditStatus,
  threshold = 70,
): { overallScore: number; passed: boolean } {
  const overallScore = contentSucceeded && visualStatus === 'passed'
    ? Math.round(contentScore * 0.6 + visualScore * 0.4)
    : 0;
  return { overallScore, passed: overallScore >= threshold && visualStatus === 'passed' };
}

function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
  const namedAbort = error instanceof Error && error.name === 'AbortError';
  if (!signal?.aborted && !namedAbort) return;
  if (error instanceof Error) throw error;
  if (signal?.reason instanceof Error) throw signal.reason;
  const abort = new Error('Audit cancelled');
  abort.name = 'AbortError';
  throw abort;
}

function isSeverity(value: unknown): value is AuditIssue['severity'] {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isCategory(value: unknown): value is AuditIssue['category'] {
  return value === 'accuracy' || value === 'formatting' || value === 'keywords'
    || value === 'layout' || value === 'visual' || value === 'content';
}

export function parseAuditModelOutput(value: unknown): {
  issues: AuditIssue[];
  score: number;
  summary: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Audit output must be an object');
  }
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root['issues'])) throw new Error('Audit output issues must be an array');
  if (typeof root['score'] !== 'number' || !Number.isFinite(root['score'])
      || root['score'] < 0 || root['score'] > 100) {
    throw new Error('Audit output score must be a number from 0 to 100');
  }
  if (typeof root['summary'] !== 'string') throw new Error('Audit output summary must be a string');
  const issues = root['issues'].map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Audit issue ${index} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    if (!isSeverity(item['severity'])) throw new Error(`Audit issue ${index} has invalid severity`);
    if (!isCategory(item['category'])) throw new Error(`Audit issue ${index} has invalid category`);
    if (typeof item['description'] !== 'string' || item['description'].trim().length === 0) {
      throw new Error(`Audit issue ${index} needs a description`);
    }
    if (typeof item['suggestion'] !== 'string') throw new Error(`Audit issue ${index} needs a suggestion`);
    return {
      severity: item['severity'],
      category: item['category'],
      description: item['description'],
      suggestion: item['suggestion'],
    };
  });
  return { issues, score: root['score'], summary: root['summary'] };
}

// ----- helpers ---------------------------------------------------------------

/**
 * Count pages in a PDF using pdfinfo.
 */
function pdfPageCount(pdfBytes: Buffer): number {
  const out = execFileSync('pdfinfo', ['-'], {
    input: pdfBytes, encoding: 'utf-8', timeout: 5_000,
  });
  const m = out.match(/Pages:\s+(\d+)/);
  if (!m?.[1]) throw new Error('pdfinfo did not report a page count');
  return parseInt(m[1], 10);
}

/**
 * Extract plain text from a PDF using pdftotext.
 */
function pdfToText(pdfBytes: Buffer): string {
  return execFileSync('pdftotext', ['-layout', '-', '-'], {
    input: pdfBytes, encoding: 'utf-8', timeout: 10_000,
  });
}

/**
 * Convert PDF pages to PNG images using pdftoppm.
 * Returns array of image file paths.
 */
function pdfToImages(pdfBytes: Buffer, outputDir: string, baseName: string): string[] {
  execFileSync('pdftoppm', ['-png', '-r', '150', '-', `${outputDir}/${baseName}`], {
    input: pdfBytes, timeout: 15_000,
  });

  const files = readdirSync(outputDir)
    .filter((f) => f.startsWith(baseName) && f.endsWith('.png'))
    .sort()
    .map((f) => `${outputDir}/${f}`);

  return files;
}

export function verifyCanonicalPdf(
  db: Database.Database,
  versionId: number,
  pdfPath: string,
  expectedSha256: string,
): Buffer {
  const artifact = db.prepare(`
    SELECT sha256 FROM artifacts
    WHERE resume_version_id = ? AND artifact_type = 'pdf' AND path = ?
    ORDER BY id DESC LIMIT 1
  `).get(versionId, pdfPath) as { sha256: string } | undefined;
  if (!artifact || artifact.sha256 !== expectedSha256 || !existsSync(pdfPath)) {
    throw new Error('Canonical PDF metadata changed during audit');
  }
  const bytes = readFileSync(pdfPath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) throw new Error('Canonical PDF hash mismatch during audit');
  return bytes;
}

/**
 * Read an image file as a base64 data URI.
 */
function imageToBase64(imagePath: string): string {
  const data = readFileSync(imagePath);
  const b64 = data.toString('base64');
  return `data:image/png;base64,${b64}`;
}

// ----- committee content audit (multiple reviewers in parallel) ----------------

async function runSingleReviewer(
  name: string,
  systemPrompt: string,
  resumeText: string,
  jobDescription: string,
  evidenceContext: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ issues: AuditIssue[]; score: number; summary: string }> {
  const thinking = getDeepseekThinking('audit-content');
  const requestBody: Record<string, unknown> = {
    model: getDeepseekModel(),
    messages: [
      { role: 'system', content: `${systemPrompt}\n\n${SHARED_AUDIT_OUTPUT_CONTRACT}` },
      {
        role: 'user',
        content: [
          `Today's date: ${new Date().toISOString().split('T')[0]}`,
          '',
          `## Job Description`,
          jobDescription.slice(0, 8000),
          '',
          `## Resume Text`,
          resumeText.slice(0, 8000),
          '',
          '## Authoritative Candidate Evidence',
          'Every resume claim must be entailed by its linked candidate evidence. Flag unsupported or inflated wording as a high-severity accuracy issue.',
          evidenceContext.slice(0, 12_000),
        ].join('\n'),
      },
    ],
    max_tokens: 8192,
  };
  if (thinking) requestBody['thinking'] = thinking;

  const startMs = Date.now();

  try {
    const request = await requestAiJson<{
      choices: [{ message: { content: string } }];
      usage?: Record<string, number>;
    }>('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
    }, { signal, label: `DeepSeek ${name} audit` });
    const data = request.data;
    const content = data.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response from DeepSeek');

    const parsed = parseAuditModelOutput(parseLLMJson(content, `audit-${name}`));
    const usage = extractUsage(data as Record<string, unknown>);
    const issues = parsed.issues;
    const score = parsed.score;

    logAiCall({
      operation: `audit-${name.toLowerCase().replace(/\s+/g, '-')}`,
      model: getDeepseekModel(),
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `${name}: ${resumeText.length} chars resume`,
      responseSummary: `Score ${score}/100, ${issues.length} issues`,
      ...usage,
      durationMs: request.durationMs,
      success: true,
    });

    return { issues, score, summary: parsed.summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAiCall({
      operation: `audit-${name.toLowerCase().replace(/\s+/g, '-')}`,
      model: getDeepseekModel(),
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `${name} audit`,
      responseSummary: msg,
      durationMs: Date.now() - startMs,
      success: false,
      error: msg,
    });
    throw err;
  }
}

async function auditContentCommittee(
  resumeText: string,
  jobDescription: string,
  evidenceContext: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ issues: AuditIssue[]; score: number; summary: string }> {
  console.log(`  Committee: ${COMMITTEE.length} reviewers evaluating in parallel...`);

  const settled = await Promise.allSettled(
    COMMITTEE.map((reviewer) =>
      runSingleReviewer(reviewer.name, reviewer.prompt, resumeText, jobDescription, evidenceContext, apiKey, signal),
    ),
  );
  rethrowIfAborted(undefined, signal);

  // Combine results, skipping failed reviewers
  let weightedScore = 0;
  let totalWeight = 0;
  let successfulReviewers = 0;
  const allIssues: AuditIssue[] = [];
  const individualScores: string[] = [];

  for (let i = 0; i < COMMITTEE.length; i++) {
    const reviewer = COMMITTEE[i]!;
    const result = settled[i]!;
    if (result.status === 'rejected') {
      console.log(`    ${reviewer.name}: FAILED`);
      individualScores.push(`${reviewer.name}: --`);
      continue;
    }
    const { issues, score } = result.value;
    successfulReviewers += 1;
    weightedScore += score * reviewer.weight;
    totalWeight += reviewer.weight;
    allIssues.push(...issues.map((issue) => ({
      ...issue,
      description: `[${reviewer.name}] ${issue.description}`,
    })));
    individualScores.push(`${reviewer.name} ${score}`);
    console.log(`    ${reviewer.name}: ${score}/100, ${issues.length} issue(s)`);
  }

  if (successfulReviewers < 2) {
    throw new Error(`Content audit requires at least 2 successful reviewers; received ${successfulReviewers}`);
  }

  const combinedScore = Math.round(weightedScore / totalWeight);
  const combinedSummary = individualScores.join(' | ') + ` → Overall ${combinedScore}/100`;
  console.log(`  Committee: ${combinedSummary}`);

  return { issues: allIssues, score: combinedScore, summary: combinedSummary };
}

// ----- content audit (single reviewer, kept for backward compat) ----------------

async function auditContent(
  resumeText: string,
  jobDescription: string,
  evidenceContext: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ issues: AuditIssue[]; score: number; summary: string }> {
  // Delegate to committee for all content audits
  return auditContentCommittee(resumeText, jobDescription, evidenceContext, apiKey, signal);
}

// ----- visual audit (Anthropic Claude or OpenAI GPT-4o) ----------------------

async function auditVisual(
  imagePaths: string[],
  jobDescription: string,
  signal?: AbortSignal,
): Promise<VisualAuditResult> {
  const anthropicKey = getAnthropicKey();
  const openaiKey = getOpenAIKey();

  // Try Anthropic first, fall back to OpenAI if Anthropic fails or no key.
  if (anthropicKey) {
    const result = await auditVisualAnthropic(imagePaths, jobDescription, anthropicKey, signal);
    // If Anthropic failed (score 0 with error message), try OpenAI before giving up
    if (result.status === 'passed' || !openaiKey) return result;
    console.log('  Anthropic visual audit failed — falling back to OpenAI GPT-5.5...');
    return auditVisualOpenAI(imagePaths, jobDescription, openaiKey, signal);
  }
  if (openaiKey) {
    return auditVisualOpenAI(imagePaths, jobDescription, openaiKey, signal);
  }

  logger.warn('No Anthropic or OpenAI API key configured — skipping visual audit.');
  return { status: 'unavailable', issues: [], score: 0, summary: 'Visual audit unavailable — no vision-capable API key in local/config.yaml. Set api_keys.anthropic or api_keys.openai.' };
}

const VISUAL_PROMPT = [
  'You are reviewing a rendered resume PDF. Look for visual/layout issues:',
  '- Text overflow or clipping',
  '- Uneven spacing or alignment',
  '- Font inconsistencies',
  '- Section header formatting',
  '- Overall readability and visual polish',
  '- Page breaks in awkward places',
  '- Margin or padding issues',
  '',
  'Return ONLY valid JSON:',
  '{"issues": [{"severity": "high|medium|low", "category": "visual|layout|formatting", "description": "...", "suggestion": "..."}], "score": 0-100, "summary": "..."}',
].join('\n');

async function auditVisualAnthropic(
  imagePaths: string[],
  jobDescription: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<VisualAuditResult> {
  const startMs = Date.now();
  try {
    const images = imagePaths.slice(0, 3).map(imageToBase64);

    const content: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: [
          VISUAL_PROMPT,
          '',
          'Job context (for relevance checking):',
          jobDescription.slice(0, 2000),
        ].join('\n'),
      },
      ...images.map((b64) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: b64.split(',')[1] },
      })),
    ];

    const requestBody = {
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content }],
    };

    const request = await requestAiJson<{
      content: [{ text: string }];
      usage?: Record<string, number>;
    }>('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    }, { signal, label: 'Anthropic visual audit' });
    const data = request.data;
    const jsonText = data.content[0]?.text || '{}';
    const parsed = parseAuditModelOutput(parseLLMJson(jsonText, 'audit-visual'));
    const usage = extractUsage(data as Record<string, unknown>);

    const result = parsed;

    logAiCall({
      operation: 'audit-visual',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      requestSummary: `Visual audit: ${imagePaths.length} page(s), ${imagePaths.length} image(s)`,
      responseSummary: `Score ${result.score}/100, ${result.issues.length} issues`,
      ...usage,
      durationMs: request.durationMs,
      success: true,
    });

    return { status: 'passed', ...result };
  } catch (err) {
    rethrowIfAborted(err, signal);
    const msg = err instanceof Error ? err.message : String(err);
    logAiCall({
      operation: 'audit-visual',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      requestSummary: `Visual audit: ${imagePaths.length} page(s)`,
      responseSummary: msg,
      durationMs: Date.now() - startMs,
      success: false,
      error: msg,
    });
    logger.warn(`Visual audit (Anthropic) failed: ${msg}`);
    return { status: 'failed', issues: [], score: 0, summary: `Visual audit error (Anthropic): ${msg}` };
  }
}

async function auditVisualOpenAI(
  imagePaths: string[],
  jobDescription: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<VisualAuditResult> {
  const startMs = Date.now();
  try {
    const images = imagePaths.slice(0, 3).map(imageToBase64);

    const content: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: [
          VISUAL_PROMPT,
          '',
          'Job context (for relevance checking):',
          jobDescription.slice(0, 2000),
        ].join('\n'),
      },
      ...images.map((b64) => ({
        type: 'image_url',
        image_url: { url: b64 },
      })),
    ];

    const requestBody = {
      model: 'gpt-5.5',
      max_completion_tokens: 4096,
      messages: [{ role: 'user', content }],
    };

    const request = await requestAiJson<{
      choices: [{ message: { content: string } }];
      usage?: Record<string, number>;
    }>('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    }, { signal, label: 'OpenAI visual audit' });
    const data = request.data;
    const jsonText = data.choices[0]?.message?.content || '{}';
    const parsed = parseAuditModelOutput(parseLLMJson(jsonText, 'audit-visual'));
    const usage = extractUsage(data as Record<string, unknown>);

    const result = parsed;

    logAiCall({
      operation: 'audit-visual',
      model: 'gpt-5.5',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      requestSummary: `Visual audit: ${imagePaths.length} page(s), ${imagePaths.length} image(s)`,
      responseSummary: `Score ${result.score}/100, ${result.issues.length} issues`,
      ...usage,
      durationMs: request.durationMs,
      success: true,
    });

    return { status: 'passed', ...result };
  } catch (err) {
    rethrowIfAborted(err, signal);
    const msg = err instanceof Error ? err.message : String(err);
    logAiCall({
      operation: 'audit-visual',
      model: 'gpt-5.5',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      requestSummary: `Visual audit: ${imagePaths.length} page(s)`,
      responseSummary: msg,
      durationMs: Date.now() - startMs,
      success: false,
      error: msg,
    });
    logger.warn(`Visual audit (OpenAI) failed: ${msg}`);
    return { status: 'failed', issues: [], score: 0, summary: `Visual audit error (OpenAI): ${msg}` };
  }
}

// ----- main audit function ---------------------------------------------------

/**
 * Audit a composed resume PDF.
 *
 * Runs two checks:
 * 1. Content audit (DeepSeek) — reviews resume text against job description
 * 2. Visual audit (Claude Vision) — reviews the rendered PDF pages as images
 */
export async function auditJob(jobId: number, signal?: AbortSignal, userId = getActiveUserId()): Promise<AuditResult> {
  rethrowIfAborted(undefined, signal);
  const db = getDb();
  const job = db.prepare(
    'SELECT id, title, company, description, status FROM jobs WHERE id = ? AND user_id = ?',
  ).get(jobId, userId) as {
    id: number; title: string | null; company: string | null;
    description: string | null; status: string;
  } | undefined;

  if (!job) {
    return { success: false, jobId, contentIssues: [], visualIssues: [], overallScore: 0, summary: '', error: `Job not found: id=${jobId}` };
  }

  if (job.status !== 'composed') {
    return { success: false, jobId, contentIssues: [], visualIssues: [], overallScore: 0, summary: '', error: `Job must be composed first (status is "${job.status}"). Run: pnpm jobbot compose --job ${jobId}` };
  }

  const canonicalVersion = db.prepare(`
    SELECT rv.id, rv.pdf_path, rv.profile_revision_id, rv.content_json, a.sha256
    FROM resume_versions rv
    JOIN artifacts a ON a.resume_version_id = rv.id
      AND a.artifact_type = 'pdf' AND a.path = rv.pdf_path
    WHERE rv.job_id = ? AND rv.user_id = ? AND rv.pdf_path IS NOT NULL
      AND rv.profile_revision_id IS NOT NULL AND rv.content_json IS NOT NULL
    ORDER BY rv.id DESC, a.id DESC LIMIT 1
  `).get(jobId, userId) as {
    id: number;
    pdf_path: string;
    profile_revision_id: number;
    content_json: string;
    sha256: string;
  } | undefined;
  if (!canonicalVersion) {
    return { success: false, jobId, contentIssues: [], visualIssues: [], overallScore: 0, summary: '', error: 'No rendered canonical resume version exists. Run compose first.' };
  }
  const pdfPath = canonicalVersion.pdf_path;
  if (!existsSync(pdfPath)) {
    return { success: false, jobId, contentIssues: [], visualIssues: [], overallScore: 0, summary: '', error: `PDF not found at ${pdfPath}. Run compose first.` };
  }
  let pdfBytes: Buffer;
  try {
    pdfBytes = verifyCanonicalPdf(
      db, canonicalVersion.id, pdfPath, canonicalVersion.sha256,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, jobId, contentIssues: [], visualIssues: [], overallScore: 0, summary: '', error: message };
  }

  const apiKey = getDeepseekKey();
  if (!apiKey) {
    return { success: false, jobId, contentIssues: [], visualIssues: [], overallScore: 0, summary: '', error: 'DeepSeek API key not set. Add to local/config.yaml.' };
  }

  console.log(`Auditing job #${jobId}: "${job.title}" at ${job.company}...\n`);

  // --- Page count check (hard requirement: must be 1 page) ---
  let pages: number;
  try {
    pages = pdfPageCount(pdfBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, jobId, contentIssues: [], visualIssues: [], overallScore: 0, summary: '', error: `Page-count validation failed: ${message}` };
  }
  rethrowIfAborted(undefined, signal);
  console.log(`--- Page Count: ${pages} page(s) ---`);
  if (pages > 1) {
    console.log(`  ✕ FAILED: Resume is ${pages} pages — must be exactly 1 page.`);

    try {
      verifyCanonicalPdf(db, canonicalVersion.id, pdfPath, canonicalVersion.sha256);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, jobId, contentIssues: [], visualIssues: [], overallScore: 0, summary: '', error: message };
    }

    // Read previous attempt count from existing feedback file
    let previousAttempt = 0;
    const feedbackPath = `${jobResumeDir(jobId)}/audit-feedback.json`;
    if (existsSync(feedbackPath)) {
      try {
        const prev = JSON.parse(readFileSync(feedbackPath, 'utf-8'));
        previousAttempt = prev.attempt || 0;
      } catch { /* corrupt — start fresh */ }
    }
    const attempt = previousAttempt + 1;

    // Write feedback for compose to condense
    const feedback = {
      jobId,
      attempt,
      score: 0,
      threshold: 70,
      issues: [
        `Resume is ${pages} pages — hard 1-page limit. Fix in this priority order: (1) tighten EVERY bullet to exactly 1 line — cut filler words, (2) trim education coursework to 4 courses max, (3) shorten summary to 35 words, (4) if still >1 page, drop EITHER the project OR the internship — not both.`,
      ],
      message: `Resume is ${pages} pages (hard 1-page limit). First: make every bullet 1 line. Then: trim coursework. Then: shorter summary. Last resort: drop project OR internship.`,
    };
    writeFileSync(feedbackPath, JSON.stringify(feedback, null, 2), 'utf-8');

    db.prepare("UPDATE jobs SET status = 'scored', updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .run(jobId, userId);
    db.prepare("INSERT INTO events (job_id, event_type, description, created_at) VALUES (?, 'audit_fail', ?, datetime('now'))")
      .run(jobId, `Audit failed: ${pages} pages (1-page limit)`);

    return {
      success: true, jobId,
      contentIssues: [{ severity: 'high', category: 'formatting', description: `Resume is ${pages} pages — must be exactly 1 page`, suggestion: 'Remove least relevant experience or condense bullet points to fit 1 page.' }],
      visualIssues: [],
      overallScore: 0,
      summary: `FAIL: ${pages} pages (1-page hard limit)`,
    };
  }

  // --- Content audit ---
  console.log('--- Content Audit (DeepSeek) ---');
  let contentIssues: AuditIssue[] = [];
  let contentScore = 0;
  let contentAuditSucceeded = false;

  try {
    const resumeText = pdfToText(pdfBytes);
    const profileRevision = new ProfileRepository(db).getRevision(canonicalVersion.profile_revision_id);
    if (!profileRevision) throw new Error(`Profile revision ${canonicalVersion.profile_revision_id} does not exist`);
    const tailoredContract = parseProvenancedTailoredResumeData(
      JSON.parse(canonicalVersion.content_json) as unknown,
    );
    const evidenceContext = JSON.stringify({
      candidate_evidence: evidencePromptContext(buildCandidateEvidence(profileRevision.candidate)),
      tailored_claim_provenance: tailoredContract,
    }, null, 2);
    const result = await auditContent(resumeText, job.description || '', evidenceContext, apiKey, signal);
    contentIssues = result.issues;
    contentScore = result.score;
    contentAuditSucceeded = true;
    console.log(`  Score: ${contentScore}/100, ${contentIssues.length} issue(s)`);
    for (const issue of contentIssues) {
      console.log(`  [${issue.severity}] ${issue.category}: ${issue.description}`);
    }
  } catch (err) {
    rethrowIfAborted(err, signal);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Content audit failed: ${msg}`);
    contentScore = 0;
    contentIssues = [{
      severity: 'high',
      category: 'content',
      description: `Content audit could not complete: ${msg}`,
      suggestion: 'Resolve the audit failure and rerun; this resume cannot pass while content review is incomplete.',
    }];
  }

  // --- Visual audit ---
  console.log('\n--- Visual Audit (Vision LLM) ---');
  let visualIssues: AuditIssue[] = [];
  let visualScore = 0;
  let visualStatus: VisualAuditStatus = 'failed';
  let visualSummary = 'Visual audit did not complete';

  try {
    const localReviewAttempt = loadLocalVisualReview(
      jobId,
      canonicalVersion.id,
      canonicalVersion.sha256,
    );
    if (localReviewAttempt.error) {
      logger.warn(`Ignoring invalid local visual review: ${localReviewAttempt.error}`);
    }

    let result: VisualAuditResult;
    if (localReviewAttempt.review) {
      console.log(`  Using hash-bound local visual review by ${localReviewAttempt.review.reviewer}`);
      result = localReviewAttempt.review;
    } else {
      const imagePaths = pdfToImages(
        pdfBytes,
        jobResumeDir(jobId),
        `audit-${canonicalVersion.id}-${canonicalVersion.sha256.slice(0, 12)}`,
      );
      if (imagePaths.length === 0) throw new Error('PDF conversion produced no images');
      console.log(`  Converted ${imagePaths.length} page(s) to images`);
      result = await auditVisual(imagePaths, job.description || '', signal);
    }

      visualIssues = result.issues;
      visualScore = result.score;
      visualStatus = result.status;
      visualSummary = result.summary;
      if (result.status !== 'passed' && visualIssues.length === 0) {
        visualIssues = [{
          severity: 'high', category: 'visual',
          description: result.summary,
          suggestion: result.status === 'unavailable'
            ? 'Configure a vision provider or record an explicit human visual approval.'
            : 'Resolve the visual provider failure and rerun the audit.',
        }];
      }
      console.log(`  Score: ${visualScore}/100, ${visualIssues.length} issue(s)`);
      for (const issue of visualIssues) {
        console.log(`  [${issue.severity}] ${issue.category}: ${issue.description}`);
      }
  } catch (err) {
    rethrowIfAborted(err, signal);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Visual audit failed: ${msg}`);
    visualStatus = 'failed';
    visualSummary = msg;
    visualIssues = [{
      severity: 'high', category: 'visual',
      description: `Visual audit could not complete: ${msg}`,
      suggestion: 'Resolve the visual audit failure or record an explicit human visual approval.',
    }];
  }
  rethrowIfAborted(undefined, signal);

  // --- Combined result ---
  const PASS_THRESHOLD = 70;
  const { overallScore, passed } = calculateAuditOutcome(
    contentScore, contentAuditSucceeded, visualScore, visualStatus, PASS_THRESHOLD,
  );

  try {
    verifyCanonicalPdf(db, canonicalVersion.id, pdfPath, canonicalVersion.sha256);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, jobId, contentIssues, visualIssues, overallScore: 0, summary: '', error: message };
  }

  // Write audit result to a JSON file
  const auditResult = {
    jobId,
    auditedAt: new Date().toISOString(),
    contentScore,
    contentAuditSucceeded,
    visualScore,
    visualStatus,
    visualSummary,
    overallScore,
    resumeVersionId: canonicalVersion.id,
    resumeSha256: canonicalVersion.sha256,
    contentIssues,
    visualIssues,
  };

  writeFileSync(
    `${jobResumeDir(jobId)}/audit.json`,
    JSON.stringify(auditResult, null, 2),
    'utf-8',
  );

  // ----- Quality gate -----
  if (passed) {
    // Passed — advance to audited, ready for apply
    db.prepare(
      "UPDATE jobs SET status = 'audited', updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    ).run(jobId, userId);
    // Log event
    db.prepare(
      "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (?, 'audit_pass', ?, ?, datetime('now'))",
    ).run(jobId, `Audit passed: ${overallScore}/100`, JSON.stringify({ overallScore, contentScore, visualScore }));
    console.log(`\n✓ PASSED (${overallScore}/100 ≥ ${PASS_THRESHOLD}) — ready for apply.`);
  } else {
    // Failed — write feedback. If under max attempts, loop back to scored
    // for re-compose. If max reached, mark as terminal failure.
    const allIssues = [...contentIssues, ...visualIssues];

    // Read previous attempt count from existing feedback file
    let previousAttempt = 0;
    const feedbackPath = `${jobResumeDir(jobId)}/audit-feedback.json`;
    if (existsSync(feedbackPath)) {
      try {
        const prev = JSON.parse(readFileSync(feedbackPath, 'utf-8'));
        previousAttempt = prev.attempt || 0;
      } catch { /* corrupt — start fresh */ }
    }
    const attempt = previousAttempt + 1;

    const feedback = {
      jobId,
      attempt,
      score: overallScore,
      threshold: PASS_THRESHOLD,
      issues: allIssues.map((i) => `${i.severity}: ${i.description} → ${i.suggestion}`),
      message: `Resume scored ${overallScore}/100 (threshold: ${PASS_THRESHOLD}). Fix the issues above and re-compose.`,
    };
    writeFileSync(feedbackPath, JSON.stringify(feedback, null, 2), 'utf-8');

    if (attempt >= MAX_AUDIT_ATTEMPTS) {
      // Terminal — give up, mark for manual review
      db.prepare(
        "UPDATE jobs SET status = 'audit_failed', updated_at = datetime('now') WHERE id = ? AND user_id = ?",
      ).run(jobId, userId);
      db.prepare(
        "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (?, 'audit_gave_up', ?, ?, datetime('now'))",
      ).run(jobId, `Audit failed after ${attempt} attempts: ${overallScore}/100 < ${PASS_THRESHOLD}`, JSON.stringify({ overallScore, contentScore, visualScore, attempt }));
      console.log(`\n✕ GAVE UP after ${attempt} attempts (${overallScore}/100 < ${PASS_THRESHOLD}) — manual review needed.`);
    } else {
      // Loop back to scored so compose picks it up again
      db.prepare(
        "UPDATE jobs SET status = 'scored', updated_at = datetime('now') WHERE id = ? AND user_id = ?",
      ).run(jobId, userId);
      db.prepare(
        "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (?, 'audit_fail', ?, ?, datetime('now'))",
      ).run(jobId, `Audit failed (attempt ${attempt}/${MAX_AUDIT_ATTEMPTS}): ${overallScore}/100 < ${PASS_THRESHOLD}`, JSON.stringify({ overallScore, contentScore, visualScore, attempt }));
      console.log(`\n✕ FAILED (attempt ${attempt}/${MAX_AUDIT_ATTEMPTS}, ${overallScore}/100 < ${PASS_THRESHOLD})`);
      console.log(`  ${allIssues.length} issue(s) written to audit feedback.`);
      console.log(`  Job looped back to 'scored' — re-run compose to fix.`);
    }
  }

  const summary = [
    passed ? 'PASS' : 'FAIL',
    `Content: ${contentScore}/100 (${contentIssues.length} issues)`,
    `Visual: ${visualStatus} ${visualScore}/100 (${visualIssues.length} issues)`,
    `Overall: ${overallScore}/100 (threshold: ${PASS_THRESHOLD})`,
  ].join(' | ');

  console.log(`\n=== Audit Complete: ${summary} ===`);

  return {
    success: true,
    jobId,
    contentIssues,
    visualIssues,
    overallScore,
    summary,
  };
}
