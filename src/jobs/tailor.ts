import { getDb } from '../db/client.js';
import { readFileSync } from 'node:fs';
import { PROMPTS_DIR } from '../utils/paths.js';
import { readCandidate, readPreferences } from '../utils/profile-store.js';
import { getActiveUserId } from '../utils/user-context.js';
import { getDeepseekKey, getDeepseekModel, getDeepseekThinking } from '../utils/config.js';
import { parseLLMJson } from '../utils/parse-llm-json.js';
import { logAiCall, extractUsage } from '../utils/ai-logger.js';
import { logger } from '../utils/logger.js';
import { buildCandidateEvidence, evidencePromptContext } from '../domain/resume/evidence.js';
import { parseProvenancedTailoredResumeData } from '../domain/resume/contract.js';
import type { ProvenancedTailoredResumeData } from '../domain/resume/types.js';
import { validateResume } from '../resume/validate.js';
import { validateSemanticEntailment, type SemanticEntailmentResult } from '../resume/entailment.js';
import {
  extractJobRequirements,
  storedRequirementsToDomain,
} from './requirements.js';
import yaml from 'js-yaml';
import { createHash } from 'node:crypto';
import { ProfileRepository } from '../repositories/profile-repository.js';
import { JobKnowledgeRepository } from '../repositories/job-knowledge-repository.js';
import { ResumeRepository, type ResumeClaimInput } from '../repositories/resume-repository.js';
import { toJsonObject, type JsonObject } from '../domain/shared/json.js';
import { rethrowAbort, throwIfAborted } from '../utils/abort.js';

const BASE_TAILOR_PROMPT = readFileSync(`${PROMPTS_DIR}/tailor-resume.md`, 'utf-8');

function jsonObject(value: unknown, label: string): JsonObject {
  return toJsonObject(JSON.parse(JSON.stringify(value)) as unknown, label);
}

/**
 * Build a dynamic tailor prompt that adjusts highlight count requirements
 * based on how many work experiences the candidate has.
 *
 * - 1 position → 6-8 highlights (go deep on the sole role)
 * - 2 positions → 4-5 highlights each
 * - 3+ positions → 3 highlights each (default)
 */
function buildTailorPrompt(candidateYaml: string): string {
  let expCount = 3; // default assumption
  try {
    const parsed = yaml.load(candidateYaml) as { work_experience?: unknown[] } | undefined;
    expCount = Array.isArray(parsed?.work_experience) ? parsed.work_experience.length : 3;
  } catch { /* keep default */ }

  const highlightPerPos = expCount <= 1 ? '6–8' : expCount <= 2 ? '4–5' : '3';
  const minHighlights = expCount <= 1 ? '5' : '3';
  const totalBullets = expCount <= 1 ? '7–9' : expCount <= 2 ? '8–10' : '9';
  const posCount = expCount <= 1 ? 'all available' : expCount <= 2 ? 'all available' : '3';

  let prompt = BASE_TAILOR_PROMPT;

  // Replace the per-position highlight rule (line 27)
  prompt = prompt.replace(
    /-\s+\*\*Each position must have exactly 3 highlights\.\*\*[^\n]*/,
    `- **Each position must have ${highlightPerPos} highlights.** Never leave a position with fewer than ${minHighlights}.`
  );

  // Replace the total bullet count constraint (line 36)
  prompt = prompt.replace(
    /-\s+Include \d+ positions with \d+ highlights each[^.]*\./,
    `- Include ${posCount} positions with ${highlightPerPos} highlights each (${totalBullets} bullets total). Each bullet: 2-3 lines with rich, specific detail — what you did, how, the impact.`
  );

  return prompt;
}

export interface TailorResult {
  success: boolean;
  jobId: number;
  versionName?: string;
  summary?: string;
  resumeVersionId?: number;
  error?: string;
}

/**
 * Customize a resume for a specific job using DeepSeek LLM.
 *
 * Reads the job description + candidate profile, sends to LLM,
 * and writes the customized resume data to the resume_versions table.
 *
 * @param jobId Job to customize for
 * @param auditFeedback Optional JSON string from a previous audit failure.
 *   When provided, it's injected at the TOP of the prompt so the LLM prioritizes fixes.
 * @param variant Optional resume variant name (e.g., "backend", "full-stack").
 *   When provided, the LLM customizes the resume with that focus.
 * @param version Optional compose version number. When provided, the full LLM
 *   prompt is written to <jobResumeDir>/tailor-prompt-v<version>.txt for debugging.
 * @param previousOutput Optional YAML string of the previous tailored output.
 *   When provided (retry), the LLM can see what it produced before and make
 *   targeted edits instead of starting from scratch.
 */
export async function tailorJob(jobId: number, auditFeedback?: string, variant?: string, signal?: AbortSignal, version?: number, previousOutput?: string, userId?: number): Promise<TailorResult> {
  throwIfAborted(signal);
  const resolvedUserId = userId ?? getActiveUserId();
  const db = getDb();
  const job = db.prepare(
    'SELECT id, url, apply_url, title, company, location, description FROM jobs WHERE id = ? AND user_id = ?',
  ).get(jobId, resolvedUserId) as {
    id: number; title: string | null; company: string | null;
    url: string; apply_url: string | null; location: string | null; description: string | null;
  } | undefined;

  if (!job) {
    return { success: false, jobId, error: `Job not found: id=${jobId}` };
  }

  if (!job.description) {
    return { success: false, jobId, error: 'Job has no description. Extract first.' };
  }

  const apiKey = getDeepseekKey();
  if (!apiKey) {
    return { success: false, jobId, error: 'DeepSeek API key not set. Add to local/config.yaml or set ANTHROPIC_AUTH_TOKEN env var.' };
  }

  // Read candidate profile
  let candidateYaml: string;
  try {
    candidateYaml = readCandidate(resolvedUserId);
  } catch {
    return { success: false, jobId, error: 'Candidate profile not found. Run init-db first.' };
  }

  let candidateProfile: unknown;
  try {
    candidateProfile = yaml.load(candidateYaml);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, jobId, error: `Candidate profile YAML is invalid: ${message}` };
  }
  const candidateEvidence = buildCandidateEvidence(candidateProfile);
  if (candidateEvidence.claims.length === 0) {
    return {
      success: false,
      jobId,
      error: 'Candidate profile has no addressable experience, project, or skill evidence.',
    };
  }

  // Freeze all generation inputs before calling the model. Files are artifacts;
  // these immutable rows are the canonical provenance chain.
  const profiles = new ProfileRepository(db);
  let profileRevision = profiles.getActiveRevision(resolvedUserId);
  if (!profileRevision) {
    profileRevision = profiles.createRevision({
      userId: resolvedUserId,
      candidate: jsonObject(candidateProfile, 'candidate profile'),
      preferences: jsonObject(yaml.load(readPreferences(resolvedUserId)) ?? {}, 'preferences'),
      source: 'import',
    });
  }
  const knowledge = new JobKnowledgeRepository(db);
  const jobSnapshot = knowledge.captureSnapshot({
    jobId,
    userId: resolvedUserId,
    sourceUrl: job.url,
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description,
    applyUrl: job.apply_url,
  });

  // Requirements are extracted and frozen before the tailoring model sees the
  // candidate. A tailoring response can reference them, but cannot define or
  // replace them.
  let frozenRequirements = storedRequirementsToDomain(knowledge.listRequirements(jobSnapshot.id));
  if (frozenRequirements.length === 0) {
    let extractedRequirements;
    try {
      extractedRequirements = await extractJobRequirements(jobSnapshot.description, {
        apiKey,
        signal,
      });
    } catch (error) {
      rethrowAbort(error, signal);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, jobId, error: `Requirement extraction failed: ${message}` };
    }
    throwIfAborted(signal);
    // Atomic initialize-only persistence handles a concurrent run that may
    // have frozen the snapshot while this extraction request was in flight.
    knowledge.initializeRequirements(
      jobSnapshot.id,
      extractedRequirements.map((requirement, ordinal) => ({
        key: requirement.id,
        category: requirement.kind,
        text: requirement.text,
        importance: requirement.priority,
        keywords: [],
        ordinal,
        sourceSpans: requirement.sourceSpans ?? [],
      })),
    );
    frozenRequirements = storedRequirementsToDomain(knowledge.listRequirements(jobSnapshot.id));
  }
  if (frozenRequirements.length === 0) {
    return { success: false, jobId, error: 'Requirement extraction produced no frozen requirements.' };
  }

  const jobInfo = [
    `## Job Posting`,
    `Title: ${job.title || 'Unknown'}`,
    `Company: ${job.company || 'Unknown'}`,
    `Location: ${job.location || 'Unknown'}`,
    ``,
    `Description:`,
    `${(job.description || '').slice(0, 10_000)}`,
  ].join('\n');

  const isRetry = !!auditFeedback;
  logger.info(`Customizing resume for job #${jobId}: "${job.title}" at ${job.company}${isRetry ? ' (retry with audit feedback)' : ''}...`);

  // Build user message — audit feedback goes FIRST so the LLM prioritizes it
  const userMessage = [
    `Today's date: ${new Date().toISOString().split('T')[0]}`,
    '',
    // Audit feedback at TOP — highest priority
    auditFeedback ? [
      '## ⚠️ PREVIOUS AUDIT FEEDBACK (ADDRESS EVERY ISSUE)',
      'The previous version of this resume failed audit. You MUST fix these specific issues in your output:',
      '```json',
      auditFeedback,
      '```',
      'Fix every issue listed above. This is the highest priority. Stay truthful to the candidate profile.',
      '',
    ].join('\n') : '',
    // Previous output so the LLM can see what it wrote and make targeted edits
    previousOutput ? [
      '## Your Previous Output (for reference)',
      'This is what you produced last time. The audit found issues with it (see feedback above).',
      'Make targeted edits — keep what worked, fix only what the audit flagged.',
      '```yaml',
      previousOutput,
      '```',
      '',
    ].join('\n') : '',
    jobInfo,
    '',
    '## Frozen Job Requirements (COPY EXACTLY; DO NOT ADD, REMOVE, OR EDIT)',
    'These requirements were extracted in a separate stage before tailoring.',
    '```json',
    JSON.stringify(frozenRequirements, null, 2),
    '```',
    '',
    variant && variant !== 'general' ? [
      '## Resume Variant',
      `Use the "${variant}" resume variant. Focus on experience and skills relevant to ${variant} roles.`,
      '',
    ].join('\n') : '',
    '## Candidate Profile',
    '```yaml',
    candidateYaml,
    '```',
    '',
    '## Candidate Evidence (AUTHORITATIVE FOR ALL RESUME CLAIMS)',
    'Use only the IDs and facts in this JSON when constructing claim provenance.',
    '```json',
    JSON.stringify(evidencePromptContext(candidateEvidence), null, 2),
    '```',
  ].filter(Boolean).join('\n');

  // Build dynamic system prompt based on candidate's experience count
  const systemPrompt = buildTailorPrompt(candidateYaml);

  const thinking = getDeepseekThinking('customize');
  const requestBody: Record<string, unknown> = {
    model: getDeepseekModel(),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: isRetry ? 32768 : 16384,  // more tokens for retries to allow thorough fixes
  };
  if (thinking) requestBody['thinking'] = thinking;

  const startMs = Date.now();
  let llmOutput: ProvenancedTailoredResumeData;
  let semanticValidation: SemanticEntailmentResult;

  // Log prompt for debugging when version is provided
  if (version !== undefined) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { jobResumeDir } = await import('../utils/paths.js');
    const dir = jobResumeDir(jobId);
    mkdirSync(dir, { recursive: true });
    const promptDump = [
      '=== SYSTEM PROMPT ===',
      systemPrompt,
      '',
      '=== USER MESSAGE ===',
      userMessage,
    ].join('\n');
    writeFileSync(`${dir}/tailor-prompt-v${version}.txt`, promptDump, 'utf-8');
    console.log(`  📝 Wrote tailor prompt: ${dir}/tailor-prompt-v${version}.txt`);
  }

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
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
      throw new Error(`DeepSeek API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices: [{ message: { content: string } }];
      usage?: Record<string, number>;
    };
    const content = data.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response from DeepSeek');

    const parsedOutput = parseLLMJson(content, `tailor job #${jobId}`);
    llmOutput = parseProvenancedTailoredResumeData(parsedOutput);
    const truthValidation = validateResume(candidateProfile, llmOutput, {
      requirements: frozenRequirements,
    });
    if (!truthValidation.valid) {
      const details = truthValidation.issues
        .slice(0, 10)
        .map((item) => `${item.path}: ${item.message}`)
        .join('; ');
      const remaining = truthValidation.issues.length - 10;
      const suffix = remaining > 0 ? `; plus ${remaining} more issue(s)` : '';
      throw new Error(`Tailored resume failed truth validation: ${details}${suffix}`);
    }
    semanticValidation = await validateSemanticEntailment(candidateProfile, llmOutput, {
      apiKey,
      signal,
    });
    throwIfAborted(signal);
    if (!semanticValidation.valid) {
      const failed = semanticValidation.assessments
        .filter((assessment) => assessment.verdict !== 'entailed')
        .map((assessment) => `${assessment.verdict}: ${assessment.claim} — ${assessment.reason}`)
        .join('; ');
      throw new Error(`Tailored resume failed semantic entailment validation: ${failed}`);
    }
    const usage = extractUsage(data as Record<string, unknown>);

    logAiCall({
      operation: 'customize',
      model: getDeepseekModel(),
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Customize resume for job #${jobId} "${job.title}" at ${job.company}${auditFeedback ? ' (audit retry)' : ''}`,
      responseSummary: `${llmOutput.selected_experience.length} positions, summary ${llmOutput.summary.length} chars`,
      ...usage,
      durationMs: Date.now() - startMs,
      success: true,
    });
  } catch (err) {
    rethrowAbort(err, signal);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Tailor LLM failed for job ${jobId}: ${msg}`);
    logAiCall({
      operation: 'customize',
      model: getDeepseekModel(),
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Customize resume for job #${jobId}`,
      responseSummary: msg,
      durationMs: Date.now() - startMs,
      success: false,
      error: msg,
    });
    return { success: false, jobId, error: msg };
  }

  // Enforce reverse-chronological order (most recent first).
  // The LLM sometimes reorders by relevance; this guarantees correct date order.
  llmOutput.selected_experience.sort((a, b) => {
    const dateVal = (dateStr: string | undefined): number => {
      if (!dateStr) return 0;
      const s = dateStr.trim().toLowerCase();
      if (s === 'present') return Infinity; // current job → always first
      // Parse "Month YYYY" or "YYYY" into a comparable number
      const months: Record<string, number> = {
        january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
        july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
      };
      const m = s.match(/([a-z]+)\s+(\d{4})/i);
      if (m) return (parseInt(m[2]!, 10) * 100) + (months[m[1]!.toLowerCase()] || 0);
      const y = s.match(/(\d{4})/);
      if (y) return parseInt(y[1]!, 10) * 100;
      return 0;
    };
    return dateVal(b.start) - dateVal(a.start);
  });

  // Serialize to YAML for storage
  const versionName = `tailored-v2-${Date.now()}`;
  const yamlData = yaml.dump(llmOutput);

  // Write the compatibility artifact first, then atomically record its
  // canonical draft/version/provenance metadata.
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { jobResumeDir } = await import('../utils/paths.js');
  mkdirSync(jobResumeDir(jobId), { recursive: true });
  const tailoredPath = `${jobResumeDir(jobId)}/tailored.yaml`;
  const texPath = `${jobResumeDir(jobId)}/resume.tex`;
  throwIfAborted(signal);
  writeFileSync(tailoredPath, yamlData, 'utf-8');

  let canonicalResumeVersionId: number | undefined;
  db.transaction(() => {
    throwIfAborted(signal);
    const resumes = new ResumeRepository(db);
    const content = jsonObject(llmOutput, 'tailored resume');
    const draft = resumes.createDraft({
      jobId,
      userId: resolvedUserId,
      profileRevisionId: profileRevision.id,
      jobSnapshotId: jobSnapshot.id,
      plan: jsonObject({
        requirements: frozenRequirements,
        matches: llmOutput.match_plan,
      }, 'resume plan'),
      promptVersion: 'tailor-resume-v2',
      model: getDeepseekModel(),
    });
    resumes.updateDraft(draft.id, 'validated', content);
    const resumeVersionId = resumes.createVersion({
      jobId,
      userId: resolvedUserId,
      draftId: draft.id,
      profileRevisionId: profileRevision.id,
      jobSnapshotId: jobSnapshot.id,
      versionName,
      texPath,
      content,
      promptVersion: 'tailor-resume-v2',
      model: getDeepseekModel(),
    });
    canonicalResumeVersionId = resumeVersionId;

    const sectionOrdinals = new Map<string, number>();
    const claims: ResumeClaimInput[] = llmOutput.claim_provenance.map((provenance) => {
      let section = 'summary';
      const experienceIndex = llmOutput.selected_experience.findIndex((experience) => experience.highlights.includes(provenance.claim));
      const projectIndex = (llmOutput.selected_projects ?? []).findIndex((project) => project.highlights.includes(provenance.claim));
      if (experienceIndex >= 0) section = `experience:${experienceIndex}`;
      else if (projectIndex >= 0) section = `project:${projectIndex}`;
      const ordinal = sectionOrdinals.get(section) ?? 0;
      sectionOrdinals.set(section, ordinal + 1);
      return {
        section,
        ordinal,
        renderedText: provenance.claim,
        sourceClaimIds: provenance.source_claim_ids,
        transformation: 'rewrite',
      };
    });
    resumes.replaceClaims(resumeVersionId, claims);
    const markClaimValid = db.prepare(`
      UPDATE resume_claims
      SET validation_status = 'valid', validation_notes = ?
      WHERE resume_version_id = ? AND rendered_text = ?
    `);
    semanticValidation.assessments.forEach((assessment) => {
      markClaimValid.run(
        `deterministic truth validation passed; semantic entailment: ${assessment.reason}`,
        resumeVersionId,
        assessment.claim,
      );
    });
    resumes.addArtifact({
      draftId: draft.id,
      resumeVersionId,
      type: 'tailored-yaml',
      path: tailoredPath,
      sha256: createHash('sha256').update(yamlData).digest('hex'),
      byteSize: Buffer.byteLength(yamlData),
    });

    db.prepare("UPDATE jobs SET updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .run(jobId, resolvedUserId);
  })();

  // Note: status change to 'composed' is handled by compose.ts.
  // When tailor is called standalone, we leave status as-is.

  return {
    success: true,
    jobId,
    versionName,
    resumeVersionId: canonicalResumeVersionId,
    summary: llmOutput.summary,
  };
}
