import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { validateCoverLetterEntailment } from '../cover-letter/entailment.js';
import { coverLetterBody, parseProvenancedCoverLetter } from '../domain/cover-letter/contract.js';
import { validateCoverLetterTruth, type CoverLetterTruthContext } from '../domain/cover-letter/truth.js';
import { buildCandidateEvidence } from '../domain/resume/evidence.js';
import type { JsonObject, JsonValue } from '../domain/shared/json.js';
import { CoverLetterRepository } from '../repositories/cover-letter-repository.js';
import { getDb } from '../db/client.js';
import { PROJECT_ROOT, jobResumeDir } from '../utils/paths.js';
import { getActiveUserId } from '../utils/user-context.js';
import { getDeepseekKey, getDeepseekModel, getDeepseekThinking } from '../utils/config.js';
import { parseLLMJson } from '../utils/parse-llm-json.js';
import { logAiCall, extractUsage } from '../utils/ai-logger.js';
import { logger } from '../utils/logger.js';

const COVER_LETTER_PROMPT = readFileSync(`${PROJECT_ROOT}/prompts/cover-letter.md`, 'utf-8');
const CL_TEMPLATE = readFileSync(`${PROJECT_ROOT}/resumes/cover-letter.tex`, 'utf-8');
const PROMPT_VERSION = 'cover-letter-v2-provenance';

export type CoverLetterTone = 'professional' | 'enthusiastic' | 'concise';

export interface CoverLetterResult {
  success: boolean;
  jobId: number;
  coverLetterVersionId?: number;
  resumeVersionId?: number;
  pdfPath?: string;
  body?: string;
  error?: string;
}

const TONE_INSTRUCTIONS: Record<CoverLetterTone, string> = {
  professional: 'Use a polished professional tone. Balance confidence with humility.',
  enthusiastic: 'Use a warm, energetic tone while remaining professional.',
  concise: 'Use at most 3 short paragraphs. Be direct and omit filler.',
};

function latexEscape(value: string): string {
  if (!value) return '';
  return value
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/[{}]/g, (match) => match === '{' ? '\\{' : '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function object(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function profileString(profile: JsonObject, ...path: string[]): string {
  let current: JsonValue | undefined = profile;
  for (const part of path) current = object(current)?.[part];
  return typeof current === 'string' ? current : '';
}

function truthError(result: ReturnType<typeof validateCoverLetterTruth>): string {
  return result.issues.slice(0, 10).map((issue) => `${issue.path}: ${issue.message}`).join('; ');
}

/**
 * Generate only from the exact canonical resume version and its frozen
 * profile/job/evidence bindings. Mutable YAML and current job/profile rows are
 * deliberately absent from this data path.
 */
export async function generateCoverLetter(
  jobId: number,
  tone: CoverLetterTone = 'professional',
  version?: number,
  userId = getActiveUserId(),
): Promise<CoverLetterResult> {
  const db = getDb();
  const repository = new CoverLetterRepository(db);
  let context;
  try {
    context = repository.loadCanonicalContext(jobId, userId);
  } catch (error) {
    return { success: false, jobId, error: error instanceof Error ? error.message : String(error) };
  }
  const apiKey = getDeepseekKey();
  if (!apiKey) return { success: false, jobId, error: 'DeepSeek API key not set.' };

  const candidateEvidence = buildCandidateEvidence(context.candidate);
  const allowedSourceClaimIds = new Set(context.resumeClaims.flatMap((claim) => claim.sourceClaimIds));
  const candidateSources = candidateEvidence.claims
    .filter((claim) => allowedSourceClaimIds.has(claim.id))
    .map((claim) => ({ id: claim.id, text: claim.text }));
  if (candidateSources.length === 0) {
    return { success: false, jobId, error: 'Canonical resume has no resolvable candidate evidence.' };
  }
  const truthContext: CoverLetterTruthContext = {
    candidateSources,
    allowedSourceClaimIds,
    requirements: context.requirements,
  };

  const candidate = context.candidate;
  const fullName = [profileString(candidate, 'name', 'first'), profileString(candidate, 'name', 'last')]
    .filter(Boolean).join(' ');
  if (!fullName) return { success: false, jobId, error: 'Bound profile revision has no candidate name.' };

  const userMessage = [
    `Today's date: ${new Date().toISOString().split('T')[0]}`,
    `Tone: ${tone}. ${TONE_INSTRUCTIONS[tone]}`,
    '',
    '## Frozen Job Snapshot',
    JSON.stringify(context.job, null, 2),
    '',
    '## Frozen Job Requirements',
    JSON.stringify(context.requirements, null, 2),
    '',
    `## Canonical Resume Version ${context.resumeVersionName} (id=${context.resumeVersionId})`,
    JSON.stringify(context.resumeContent, null, 2),
    '',
    '## Candidate Evidence Allowed By This Resume Version',
    JSON.stringify(candidateSources, null, 2),
    '',
    `Candidate name: ${fullName}`,
    'Return ONLY this JSON contract. Split every body paragraph into factual sentences and cite every sentence:',
    '{"contract_version":1,"greeting":"Dear Hiring Manager,","paragraphs":[{"sentences":[{"text":"...","source_claim_ids":["..."],"requirement_ids":["..."]}]}],"closing":"Sincerely,"}',
    'IDs must be copied exactly from the allowed evidence above. Do not create an uncited sentence.',
  ].join('\n');

  logger.info(`Generating cover letter for job #${jobId} from canonical resume ${context.resumeVersionName}...`);
  if (version !== undefined) {
    const dir = jobResumeDir(jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/cover-letter-prompt-v${version}.txt`,
      `=== SYSTEM PROMPT ===\n${COVER_LETTER_PROMPT}\n\n=== USER MESSAGE ===\n${userMessage}`,
      'utf-8',
    );
  }

  const startMs = Date.now();
  let letter;
  let semantic;
  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: getDeepseekModel(),
        messages: [
          { role: 'system', content: COVER_LETTER_PROMPT },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 16384,
        ...(getDeepseekThinking('cover-letter') ? { thinking: getDeepseekThinking('cover-letter') } : {}),
      }),
    });
    if (!response.ok) throw new Error(`DeepSeek API error ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, number>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response');
    letter = parseProvenancedCoverLetter(parseLLMJson(content, `cover-letter job #${jobId}`));
    const deterministic = validateCoverLetterTruth(letter, truthContext);
    if (!deterministic.valid) throw new Error(`Cover letter failed deterministic truth validation: ${truthError(deterministic)}`);
    semantic = await validateCoverLetterEntailment(letter, truthContext, { apiKey });
    if (!semantic.valid) {
      const failures = semantic.assessments.filter((item) => item.verdict !== 'entailed')
        .map((item) => `${item.verdict}: ${item.sentence} — ${item.reason}`).join('; ');
      throw new Error(`Cover letter failed semantic entailment validation: ${failures}`);
    }
    logAiCall({
      operation: 'cover-letter', model: getDeepseekModel(), provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Cover letter for job #${jobId}, canonical resume #${context.resumeVersionId}`,
      responseSummary: `${letter.paragraphs.flatMap((paragraph) => paragraph.sentences).length} validated sentences`,
      ...extractUsage(data as Record<string, unknown>), durationMs: Date.now() - startMs, success: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logAiCall({
      operation: 'cover-letter', model: getDeepseekModel(), provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Cover letter for job #${jobId}, canonical resume #${context.resumeVersionId}`,
      responseSummary: message, durationMs: Date.now() - startMs, success: false, error: message,
    });
    return { success: false, jobId, resumeVersionId: context.resumeVersionId, error: message };
  }

  const bodyText = coverLetterBody(letter);
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const githubUsername = profileString(candidate, 'links', 'github').split('/').pop() ?? '';
  const linkedinUsername = profileString(candidate, 'links', 'linkedin').split('/').pop() ?? '';
  let tex = CL_TEMPLATE
    .replace(/\{\{name\}\}/g, latexEscape(fullName))
    .replace(/\{\{email\}\}/g, latexEscape(profileString(candidate, 'email')))
    .replace(/\{\{phone\}\}/g, latexEscape(profileString(candidate, 'phone')))
    .replace(/\{\{date\}\}/g, today)
    .replace(/\{\{greeting\}\}/g, latexEscape(letter.greeting))
    .replace(/\{\{body\}\}/g, latexEscape(bodyText).replace(/\n\s*\n/g, '\\\\[\\baselineskip]'))
    .replace(/\{\{closing\}\}/g, latexEscape(letter.closing.replace(
      new RegExp('\\\\n?' + fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'),
      '',
    )))
    .replace(/\{\{company\}\}/g, latexEscape(context.job.company ?? ''));
  const phone = profileString(candidate, 'phone');
  const email = profileString(candidate, 'email');
  tex = tex.replace(/\{\{#phone\}\}([\s\S]*?)\{\{\/phone\}\}/g, phone ? '$1' : '');
  tex = tex.replace(/\{\{#email\}\}([\s\S]*?)\{\{\/email\}\}/g, email ? '$1' : '');
  tex = linkedinUsername
    ? tex.replace(/\{\{#linkedin\}\}([\s\S]*?)\{\{\/linkedin\}\}/g, (_match, inner: string) => inner.replace(/\{\{linkedin\}\}/g, linkedinUsername))
    : tex.replace(/\{\{#linkedin\}\}[\s\S]*?\{\{\/linkedin\}\}/g, '');
  tex = githubUsername
    ? tex.replace(/\{\{#github\}\}([\s\S]*?)\{\{\/github\}\}/g, (_match, inner: string) => inner.replace(/\{\{github\}\}/g, githubUsername))
    : tex.replace(/\{\{#github\}\}[\s\S]*?\{\{\/github\}\}/g, '');
  tex = tex.replace(/\{\{#company_address\}\}[\s\S]*?\{\{\/company_address\}\}/g, '')
    .replace(/\{\{[#/]?\w+\}\}/g, '');

  const dir = jobResumeDir(jobId);
  mkdirSync(dir, { recursive: true });
  const artifactStem = `cover-letter-r${context.resumeVersionId}-${Date.now()}`;
  const texPath = `${dir}/${artifactStem}.tex`;
  const pdfPath = `${dir}/${artifactStem}.pdf`;
  writeFileSync(texPath, tex, 'utf-8');
  try {
    const args = ['-interaction=nonstopmode', `-jobname=${artifactStem}`, `-output-directory=${dir}`, texPath];
    execFileSync('pdflatex', args, { timeout: 30_000, stdio: 'pipe' });
    execFileSync('pdflatex', args, { timeout: 30_000, stdio: 'pipe' });
    if (!existsSync(pdfPath)) throw new Error('pdflatex completed but no PDF produced.');
    const pdfBytes = readFileSync(pdfPath);
    const sha256 = createHash('sha256').update(pdfBytes).digest('hex');
    const coverLetterVersionId = repository.registerValidated({
      context, userId, tone, letter, assessments: semantic.assessments, pdfPath, sha256,
      byteSize: pdfBytes.byteLength, promptVersion: PROMPT_VERSION, model: getDeepseekModel(),
    });
    // UI compatibility only. Apply never trusts or uploads this mutable alias.
    copyFileSync(pdfPath, `${dir}/cover-letter.pdf`);
    db.prepare(`
      INSERT INTO events (job_id, event_type, description, metadata, created_at)
      VALUES (?, 'cover_letter', ?, ?, datetime('now'))
    `).run(
      jobId,
      `Validated cover letter artifact: ${pdfPath}`,
      JSON.stringify({ coverLetterVersionId, resumeVersionId: context.resumeVersionId, sha256 }),
    );
    logger.info(`Cover letter PDF: ${pdfPath}`);
    return {
      success: true, jobId, coverLetterVersionId, resumeVersionId: context.resumeVersionId,
      pdfPath, body: bodyText,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, jobId, resumeVersionId: context.resumeVersionId, error: `Cover-letter render/registration failed: ${message}` };
  }
}
