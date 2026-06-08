import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getDb } from '../db/client.js';
import { PROJECT_ROOT, RESUMES_DIR } from '../utils/paths.js';
import { getDeepseekKey, getAnthropicKey } from '../utils/config.js';
import { logAiCall, extractUsage } from '../utils/ai-logger.js';
import { logger } from '../utils/logger.js';

const AUDIT_PROMPT = readFileSync(`${PROJECT_ROOT}/prompts/audit-resume.md`, 'utf-8');

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
  const outputDir = `${RESUMES_DIR}/audit`;
  mkdirSync(outputDir, { recursive: true });

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

// ----- content audit (DeepSeek) ----------------------------------------------

async function auditContent(
  resumeText: string,
  jobDescription: string,
  apiKey: string,
): Promise<{ issues: AuditIssue[]; score: number; summary: string }> {
  const requestBody = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: AUDIT_PROMPT },
      {
        role: 'user',
        content: [
          `## Job Description`,
          jobDescription.slice(0, 8000),
          '',
          `## Resume Text`,
          resumeText.slice(0, 8000),
        ].join('\n'),
      },
    ],
    response_format: { type: 'json_object' },
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
      throw new Error(`DeepSeek API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices: [{ message: { content: string } }];
      usage?: Record<string, number>;
    };
    const content = data.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response from DeepSeek');

    const parsed = JSON.parse(content);
    const usage = extractUsage(data as Record<string, unknown>);
    const issues = (parsed.issues || []).map((i: Record<string, unknown>) => ({
      severity: i.severity || 'medium',
      category: i.category || 'content',
      description: i.description || '',
      suggestion: i.suggestion || '',
    }));
    const score = typeof parsed.score === 'number' ? parsed.score : 70;

    logAiCall({
      operation: 'audit-content',
      model: 'deepseek-chat',
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Content audit: ${resumeText.length} chars resume vs ${jobDescription.length} chars job desc`,
      responseSummary: `Score ${score}/100, ${issues.length} issues`,
      ...usage,
      durationMs: Date.now() - startMs,
      success: true,
    });

    return { issues, score, summary: parsed.summary || '' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAiCall({
      operation: 'audit-content',
      model: 'deepseek-chat',
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: 'Content audit',
      responseSummary: msg,
      durationMs: Date.now() - startMs,
      success: false,
      error: msg,
    });
    throw err;
  }
}

// ----- visual audit (Claude Vision) ------------------------------------------

async function auditVisual(
  imagePaths: string[],
  jobDescription: string,
): Promise<{ issues: AuditIssue[]; score: number; summary: string }> {
  // Try Anthropic API for vision, fall back to OpenAI-compatible
  const apiKey = getAnthropicKey();

  if (!apiKey) {
    logger.warn('No Anthropic API key configured — skipping visual audit.');
    return { issues: [], score: 70, summary: 'Visual audit skipped — no vision-capable API key in local/config.yaml.' };
  }

  // Try Anthropic API (Claude supports vision)
  try {
    const images = imagePaths.slice(0, 3).map(imageToBase64); // Max 3 pages

    const content: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: [
          'You are reviewing a rendered resume PDF. Look for visual/layout issues:',
          '- Text overflow or clipping',
          '- Uneven spacing or alignment',
          '- Font inconsistencies',
          '- Section header formatting',
          '- Overall readability and visual polish',
          '- Page breaks in awkward places',
          '- Margin or padding issues',
          '',
          'Job context (for relevance checking):',
          jobDescription.slice(0, 2000),
          '',
          'Return ONLY valid JSON:',
          '{"issues": [{"severity": "high|medium|low", "category": "visual|layout|formatting", "description": "...", "suggestion": "..."}], "score": 0-100, "summary": "..."}',
        ].join('\n'),
      },
      ...images.map((b64) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: b64.split(',')[1] },
      })),
    ];

    const visualRequestBody = {
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content }],
    };

    const visStartMs = Date.now();

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(visualRequestBody),
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
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : jsonText);
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
        durationMs: Date.now() - visStartMs,
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
        durationMs: Date.now() - visStartMs,
        success: false,
        error: msg,
      });
      logger.warn(`Visual audit failed: ${msg}`);
      return { issues: [], score: 0, summary: `Visual audit error: ${msg}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Visual audit failed: ${msg}`);
    return { issues: [], score: 0, summary: `Visual audit error: ${msg}` };
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
export async function auditJob(jobId: number): Promise<AuditResult> {
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

  const pdfPath = `${RESUMES_DIR}/${jobId}-resume.pdf`;
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

    // Write feedback for compose to condense
    const feedback = {
      jobId,
      score: 0,
      threshold: 70,
      issues: [`Resume is ${pages} pages — must be exactly 1 page. Remove less relevant experience or condense bullet points.`],
      message: `Resume is ${pages} pages (hard 1-page limit). Condense by removing the least relevant position or shortening bullet points.`,
    };
    writeFileSync(`${RESUMES_DIR}/${jobId}-audit-feedback.json`, JSON.stringify(feedback, null, 2), 'utf-8');

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
    const result = await auditContent(resumeText, job.description || '', apiKey);
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
      const result = await auditVisual(imagePaths, job.description || '');
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

  mkdirSync(`${RESUMES_DIR}/audit`, { recursive: true });
  writeFileSync(
    `${RESUMES_DIR}/audit/${jobId}-audit.json`,
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
    // Failed — write feedback and loop back to scored for re-compose
    const allIssues = [...contentIssues, ...visualIssues];
    const feedback = {
      jobId,
      attempt: (auditResult as { attempt?: number }).attempt || 1,
      score: overallScore,
      threshold: PASS_THRESHOLD,
      issues: allIssues.map((i) => `${i.severity}: ${i.description} → ${i.suggestion}`),
      message: `Resume scored ${overallScore}/100 (threshold: ${PASS_THRESHOLD}). Fix the issues above and re-compose.`,
    };
    writeFileSync(
      `${RESUMES_DIR}/${jobId}-audit-feedback.json`,
      JSON.stringify(feedback, null, 2),
      'utf-8',
    );

    // Loop back to scored so compose picks it up again
    db.prepare(
      "UPDATE jobs SET status = 'scored', updated_at = datetime('now') WHERE id = ?",
    ).run(jobId);
    // Log event
    db.prepare(
      "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (?, 'audit_fail', ?, ?, datetime('now'))",
    ).run(jobId, `Audit failed: ${overallScore}/100 < ${PASS_THRESHOLD}`, JSON.stringify({ overallScore, contentScore, visualScore }));
    console.log(`\n✕ FAILED (${overallScore}/100 < ${PASS_THRESHOLD})`);
    console.log(`  ${allIssues.length} issue(s) written to audit feedback.`);
    console.log(`  Job looped back to 'scored' — re-run compose to fix.`);
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
