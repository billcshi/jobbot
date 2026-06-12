import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getDb } from '../db/client.js';
import { PROJECT_ROOT, jobResumeDir } from '../utils/paths.js';
import { getDeepseekKey, getAnthropicKey, getOpenAIKey, getDeepseekModel, getDeepseekThinking } from '../utils/config.js';
import { parseLLMJson } from '../utils/parse-llm-json.js';
import { logAiCall, extractUsage } from '../utils/ai-logger.js';
import { logger } from '../utils/logger.js';

const AUDIT_ATS = readFileSync(`${PROJECT_ROOT}/prompts/audit-ats.md`, 'utf-8');
const AUDIT_HM = readFileSync(`${PROJECT_ROOT}/prompts/audit-hm.md`, 'utf-8');
const AUDIT_FORMAT = readFileSync(`${PROJECT_ROOT}/prompts/audit-format.md`, 'utf-8');

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

// ----- helpers ---------------------------------------------------------------

/**
 * Count pages in a PDF using pdfinfo.
 */
function pdfPageCount(pdfPath: string): number {
  try {
    const out = execSync(`pdfinfo "${pdfPath}"`, { encoding: 'utf-8', timeout: 5_000 });
    const m = out.match(/Pages:\s+(\d+)/);
    return m && m[1] ? parseInt(m[1], 10) : 1;
  } catch {
    return 1; // assume 1 page if we can't check
  }
}

/**
 * Extract plain text from a PDF using pdftotext.
 */
function pdfToText(pdfPath: string): string {
  return execSync(`pdftotext -layout "${pdfPath}" -`, {
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

/**
 * Convert PDF pages to PNG images using pdftoppm.
 * Returns array of image file paths.
 */
function pdfToImages(pdfPath: string): string[] {
  // Images go in the same directory as the PDF
  const outputDir = path.dirname(pdfPath);

  const baseName = pdfPath.split('/').pop()!.replace('.pdf', '');
  execSync(`pdftoppm -png -r 150 "${pdfPath}" "${outputDir}/${baseName}"`, {
    timeout: 15_000,
  });

  const files = readdirSync(outputDir)
    .filter((f) => f.startsWith(baseName) && f.endsWith('.png'))
    .sort()
    .map((f) => `${outputDir}/${f}`);

  return files;
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
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ issues: AuditIssue[]; score: number; summary: string }> {
  const thinking = getDeepseekThinking('audit-content');
  const requestBody: Record<string, unknown> = {
    model: getDeepseekModel(),
    messages: [
      { role: 'system', content: systemPrompt },
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
        ].join('\n'),
      },
    ],
    max_tokens: 8192,
  };
  if (thinking) requestBody['thinking'] = thinking;

  const startMs = Date.now();

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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

    const parsed = parseLLMJson(content, `audit-${name}`) as Record<string, any>;
    const usage = extractUsage(data as Record<string, unknown>);
    const issues = (parsed.issues || []).map((i: Record<string, unknown>) => ({
      severity: i.severity || 'medium',
      category: i.category || 'content',
      description: i.description || '',
      suggestion: i.suggestion || '',
    }));
    const score = typeof parsed.score === 'number' ? parsed.score : 70;

    logAiCall({
      operation: `audit-${name.toLowerCase().replace(/\s+/g, '-')}`,
      model: getDeepseekModel(),
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `${name}: ${resumeText.length} chars resume`,
      responseSummary: `Score ${score}/100, ${issues.length} issues`,
      ...usage,
      durationMs: Date.now() - startMs,
      success: true,
    });

    return { issues, score, summary: parsed.summary || '' };
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
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ issues: AuditIssue[]; score: number; summary: string }> {
  console.log(`  Committee: ${COMMITTEE.length} reviewers evaluating in parallel...`);

  const settled = await Promise.allSettled(
    COMMITTEE.map((reviewer) =>
      runSingleReviewer(reviewer.name, reviewer.prompt, resumeText, jobDescription, apiKey, signal),
    ),
  );

  // Combine results, skipping failed reviewers
  let weightedScore = 0;
  let totalWeight = 0;
  const allIssues: AuditIssue[] = [];
  const summaries: string[] = [];
  const individualScores: string[] = [];

  for (let i = 0; i < COMMITTEE.length; i++) {
    const reviewer = COMMITTEE[i]!;
    const result = settled[i]!;
    if (result.status === 'rejected') {
      console.log(`    ${reviewer.name}: FAILED`);
      summaries.push(`${reviewer.name}: --`);
      individualScores.push(`${reviewer.name}: --`);
      continue;
    }
    const { issues, score } = result.value;
    weightedScore += score * reviewer.weight;
    totalWeight += reviewer.weight;
    allIssues.push(...issues.map((issue) => ({
      ...issue,
      description: `[${reviewer.name}] ${issue.description}`,
    })));
    summaries.push(`${reviewer.name}: ${score}`);
    individualScores.push(`${reviewer.name} ${score}`);
    console.log(`    ${reviewer.name}: ${score}/100, ${issues.length} issue(s)`);
  }

  if (totalWeight === 0) {
    throw new Error('All committee reviewers failed');
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
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ issues: AuditIssue[]; score: number; summary: string }> {
  // Delegate to committee for all content audits
  return auditContentCommittee(resumeText, jobDescription, apiKey, signal);
}

// ----- visual audit (Anthropic Claude or OpenAI GPT-4o) ----------------------

async function auditVisual(
  imagePaths: string[],
  jobDescription: string,
  signal?: AbortSignal,
): Promise<{ issues: AuditIssue[]; score: number; summary: string }> {
  const anthropicKey = getAnthropicKey();
  const openaiKey = getOpenAIKey();

  // Try Anthropic first, fall back to OpenAI if Anthropic fails or no key.
  if (anthropicKey) {
    const result = await auditVisualAnthropic(imagePaths, jobDescription, anthropicKey, signal);
    // If Anthropic failed (score 0 with error message), try OpenAI before giving up
    if (result.score > 0 || !openaiKey) return result;
    console.log('  Anthropic visual audit failed — falling back to OpenAI GPT-5.5...');
    return auditVisualOpenAI(imagePaths, jobDescription, openaiKey, signal);
  }
  if (openaiKey) {
    return auditVisualOpenAI(imagePaths, jobDescription, openaiKey, signal);
  }

  logger.warn('No Anthropic or OpenAI API key configured — skipping visual audit.');
  return { issues: [], score: 70, summary: 'Visual audit skipped — no vision-capable API key in local/config.yaml. Set api_keys.anthropic or api_keys.openai.' };
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
): Promise<{ issues: AuditIssue[]; score: number; summary: string }> {
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

    const startMs = Date.now();

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      content: [{ text: string }];
      usage?: Record<string, number>;
    };
    const jsonText = data.content[0]?.text || '{}';
    const parsed = parseLLMJson(jsonText, 'audit-visual') as Record<string, any>;
    const usage = extractUsage(data as Record<string, unknown>);

    const result = {
      issues: (parsed.issues || []).map((i: Record<string, unknown>) => ({
        severity: i.severity || 'medium',
        category: i.category || 'visual',
        description: i.description || '',
        suggestion: i.suggestion || '',
      })),
      score: typeof parsed.score === 'number' ? parsed.score : 70,
      summary: parsed.summary || '',
    };

    logAiCall({
      operation: 'audit-visual',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      requestSummary: `Visual audit: ${imagePaths.length} page(s), ${imagePaths.length} image(s)`,
      responseSummary: `Score ${result.score}/100, ${result.issues.length} issues`,
      ...usage,
      durationMs: Date.now() - startMs,
      success: true,
    });

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAiCall({
      operation: 'audit-visual',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      requestSummary: `Visual audit: ${imagePaths.length} page(s)`,
      responseSummary: msg,
      durationMs: 0,
      success: false,
      error: msg,
    });
    logger.warn(`Visual audit (Anthropic) failed: ${msg}`);
    return { issues: [], score: 0, summary: `Visual audit error (Anthropic): ${msg}` };
  }
}

async function auditVisualOpenAI(
  imagePaths: string[],
  jobDescription: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ issues: AuditIssue[]; score: number; summary: string }> {
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

    const startMs = Date.now();

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
      throw new Error(`OpenAI API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices: [{ message: { content: string } }];
      usage?: Record<string, number>;
    };
    const jsonText = data.choices[0]?.message?.content || '{}';
    const parsed = parseLLMJson(jsonText, 'audit-visual') as Record<string, any>;
    const usage = extractUsage(data as Record<string, unknown>);

    const result = {
      issues: (parsed.issues || []).map((i: Record<string, unknown>) => ({
        severity: i.severity || 'medium',
        category: i.category || 'visual',
        description: i.description || '',
        suggestion: i.suggestion || '',
      })),
      score: typeof parsed.score === 'number' ? parsed.score : 70,
      summary: parsed.summary || '',
    };

    logAiCall({
      operation: 'audit-visual',
      model: 'gpt-5.5',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      requestSummary: `Visual audit: ${imagePaths.length} page(s), ${imagePaths.length} image(s)`,
      responseSummary: `Score ${result.score}/100, ${result.issues.length} issues`,
      ...usage,
      durationMs: Date.now() - startMs,
      success: true,
    });

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAiCall({
      operation: 'audit-visual',
      model: 'gpt-5.5',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      requestSummary: `Visual audit: ${imagePaths.length} page(s)`,
      responseSummary: msg,
      durationMs: 0,
      success: false,
      error: msg,
    });
    logger.warn(`Visual audit (OpenAI) failed: ${msg}`);
    return { issues: [], score: 0, summary: `Visual audit error (OpenAI): ${msg}` };
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
export async function auditJob(jobId: number, signal?: AbortSignal): Promise<AuditResult> {
  const db = getDb();
  const job = db.prepare(
    'SELECT id, title, company, description, status FROM jobs WHERE id = ?',
  ).get(jobId) as {
    id: number; title: string | null; company: string | null;
    description: string | null; status: string;
  } | undefined;

  if (!job) {
    return { success: false, jobId, contentIssues: [], visualIssues: [], overallScore: 0, summary: '', error: `Job not found: id=${jobId}` };
  }

  if (job.status !== 'composed') {
    return { success: false, jobId, contentIssues: [], visualIssues: [], overallScore: 0, summary: '', error: `Job must be composed first (status is "${job.status}"). Run: pnpm jobbot compose --job ${jobId}` };
  }

  const pdfPath = `${jobResumeDir(jobId)}/resume.pdf`;
  if (!existsSync(pdfPath)) {
    return { success: false, jobId, contentIssues: [], visualIssues: [], overallScore: 0, summary: '', error: `PDF not found at ${pdfPath}. Run compose first.` };
  }

  const apiKey = getDeepseekKey();
  if (!apiKey) {
    return { success: false, jobId, contentIssues: [], visualIssues: [], overallScore: 0, summary: '', error: 'DeepSeek API key not set. Add to local/config.yaml.' };
  }

  console.log(`Auditing job #${jobId}: "${job.title}" at ${job.company}...\n`);

  // --- Page count check (hard requirement: must be 1 page) ---
  const pages = pdfPageCount(pdfPath);
  console.log(`--- Page Count: ${pages} page(s) ---`);
  if (pages > 1) {
    console.log(`  ✕ FAILED: Resume is ${pages} pages — must be exactly 1 page.`);

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

    db.prepare("UPDATE jobs SET status = 'scored', updated_at = datetime('now') WHERE id = ?").run(jobId);
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
  let contentScore = 70;

  try {
    const resumeText = pdfToText(pdfPath);
    const result = await auditContent(resumeText, job.description || '', apiKey, signal);
    contentIssues = result.issues;
    contentScore = result.score;
    console.log(`  Score: ${contentScore}/100, ${contentIssues.length} issue(s)`);
    for (const issue of contentIssues) {
      console.log(`  [${issue.severity}] ${issue.category}: ${issue.description}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Content audit failed: ${msg}`);
  }

  // --- Visual audit ---
  console.log('\n--- Visual Audit (Vision LLM) ---');
  let visualIssues: AuditIssue[] = [];
  let visualScore = 0;

  try {
    const imagePaths = pdfToImages(pdfPath);
    if (imagePaths.length > 0) {
      console.log(`  Converted ${imagePaths.length} page(s) to images`);
      const result = await auditVisual(imagePaths, job.description || '', signal);
      visualIssues = result.issues;
      visualScore = result.score;
      console.log(`  Score: ${visualScore}/100, ${visualIssues.length} issue(s)`);
      for (const issue of visualIssues) {
        console.log(`  [${issue.severity}] ${issue.category}: ${issue.description}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Visual audit failed: ${msg}`);
  }

  // --- Combined result ---
  const overallScore = visualScore > 0
    ? Math.round(contentScore * 0.6 + visualScore * 0.4)
    : contentScore;

  // Write audit result to a JSON file
  const auditResult = {
    jobId,
    auditedAt: new Date().toISOString(),
    contentScore,
    visualScore,
    overallScore,
    contentIssues,
    visualIssues,
  };

  writeFileSync(
    `${jobResumeDir(jobId)}/audit.json`,
    JSON.stringify(auditResult, null, 2),
    'utf-8',
  );

  // ----- Quality gate -----
  const PASS_THRESHOLD = 70;
  const passed = overallScore >= PASS_THRESHOLD;

  if (passed) {
    // Passed — advance to audited, ready for apply
    db.prepare(
      "UPDATE jobs SET status = 'audited', updated_at = datetime('now') WHERE id = ?",
    ).run(jobId);
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
        "UPDATE jobs SET status = 'audit_failed', updated_at = datetime('now') WHERE id = ?",
      ).run(jobId);
      db.prepare(
        "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (?, 'audit_gave_up', ?, ?, datetime('now'))",
      ).run(jobId, `Audit failed after ${attempt} attempts: ${overallScore}/100 < ${PASS_THRESHOLD}`, JSON.stringify({ overallScore, contentScore, visualScore, attempt }));
      console.log(`\n✕ GAVE UP after ${attempt} attempts (${overallScore}/100 < ${PASS_THRESHOLD}) — manual review needed.`);
    } else {
      // Loop back to scored so compose picks it up again
      db.prepare(
        "UPDATE jobs SET status = 'scored', updated_at = datetime('now') WHERE id = ?",
      ).run(jobId);
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
    visualScore > 0
      ? `Visual: ${visualScore}/100 (${visualIssues.length} issues)`
      : 'Visual: skipped',
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
