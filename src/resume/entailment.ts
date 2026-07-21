import { buildCandidateEvidence } from '../domain/resume/evidence.js';
import type { ProvenancedTailoredResumeData } from '../domain/resume/types.js';
import { extractUsage, logAiCall } from '../utils/ai-logger.js';
import { getDeepseekKey, getDeepseekModel, getDeepseekThinking } from '../utils/config.js';
import { parseLLMJson } from '../utils/parse-llm-json.js';

export type EntailmentVerdict = 'entailed' | 'unsupported' | 'uncertain';

export interface EntailmentAssessment {
  claim: string;
  verdict: EntailmentVerdict;
  reason: string;
}

export interface SemanticEntailmentResult {
  valid: boolean;
  assessments: EntailmentAssessment[];
}

export interface SemanticEntailmentOptions {
  apiKey?: string;
  model?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

interface ClaimReviewInput {
  claim: string;
  linked_sources: Array<{ id: string; text: string }>;
}

const ENTAILMENT_PROMPT = [
  'You are an independent factual entailment gate for a resume.',
  'For each claim, decide whether every factual and semantic assertion is entailed by its linked source text alone.',
  'The job description is intentionally absent and cannot be used as evidence.',
  'Ownership upgrades, new scope, new technologies, causal claims, or impact absent from sources are unsupported even when plausible.',
  'If wording is ambiguous or support is incomplete, verdict must be uncertain. Never give the benefit of the doubt.',
  'Return only JSON: {"assessments":[{"claim":"exact input claim","verdict":"entailed|unsupported|uncertain","reason":"..."}]}.',
  'Return exactly one assessment for every input claim, preserve each claim string exactly, and do not add claims.',
].join('\n');

function isVerdict(value: unknown): value is EntailmentVerdict {
  return value === 'entailed' || value === 'unsupported' || value === 'uncertain';
}

export function parseEntailmentAssessments(
  value: unknown,
  expectedClaims: readonly string[],
): EntailmentAssessment[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Semantic entailment output must be an object');
  }
  const rawAssessments = (value as Record<string, unknown>)['assessments'];
  if (!Array.isArray(rawAssessments)) {
    throw new Error('Semantic entailment output must contain assessments');
  }
  const assessments = rawAssessments.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`assessments[${index}] must be an object`);
    }
    const item = raw as Record<string, unknown>;
    if (typeof item['claim'] !== 'string') {
      throw new Error(`assessments[${index}].claim must be a string`);
    }
    if (!isVerdict(item['verdict'])) {
      throw new Error(`assessments[${index}].verdict is invalid`);
    }
    if (typeof item['reason'] !== 'string' || item['reason'].trim().length === 0) {
      throw new Error(`assessments[${index}].reason must be a non-empty string`);
    }
    return {
      claim: item['claim'],
      verdict: item['verdict'],
      reason: item['reason'].trim(),
    };
  });

  if (assessments.length !== expectedClaims.length) {
    throw new Error(`Expected ${expectedClaims.length} semantic assessments, received ${assessments.length}`);
  }
  const counts = new Map<string, number>();
  assessments.forEach((assessment) => {
    counts.set(assessment.claim, (counts.get(assessment.claim) ?? 0) + 1);
  });
  expectedClaims.forEach((claim) => {
    if (counts.get(claim) !== 1) {
      throw new Error(`Semantic assessment must contain the exact claim once: ${JSON.stringify(claim)}`);
    }
  });
  for (const assessment of assessments) {
    if (!expectedClaims.includes(assessment.claim)) {
      throw new Error(`Semantic assessment returned an unknown claim: ${JSON.stringify(assessment.claim)}`);
    }
  }
  return assessments;
}

function buildReviewInputs(
  candidateProfile: unknown,
  resume: ProvenancedTailoredResumeData,
): ClaimReviewInput[] {
  const evidence = buildCandidateEvidence(candidateProfile);
  const byId = new Map(evidence.claims.map((claim) => [claim.id, claim]));
  return resume.claim_provenance.map((provenance) => ({
    claim: provenance.claim,
    linked_sources: provenance.source_claim_ids.map((id) => {
      const source = byId.get(id);
      if (!source) throw new Error(`Cannot semantically review unknown source claim ${id}`);
      return { id, text: source.text };
    }),
  }));
}

/**
 * Run a separate model call after deterministic validation. API errors,
 * malformed responses, unsupported claims, and uncertainty all block.
 */
export async function validateSemanticEntailment(
  candidateProfile: unknown,
  resume: ProvenancedTailoredResumeData,
  options: SemanticEntailmentOptions = {},
): Promise<SemanticEntailmentResult> {
  const reviewInputs = buildReviewInputs(candidateProfile, resume);
  if (reviewInputs.length === 0) throw new Error('Semantic entailment requires at least one resume claim');
  const apiKey = options.apiKey ?? getDeepseekKey();
  if (!apiKey) throw new Error('DeepSeek API key is required for semantic entailment validation');
  const model = options.model ?? getDeepseekModel();
  const fetchImpl = options.fetchImpl ?? fetch;
  const thinking = getDeepseekThinking('audit-content');
  const requestBody: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: ENTAILMENT_PROMPT },
      { role: 'user', content: JSON.stringify({ claims: reviewInputs }, null, 2) },
    ],
    max_tokens: 8192,
  };
  if (thinking) requestBody['thinking'] = thinking;
  const startMs = Date.now();

  try {
    const response = await fetchImpl('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, number>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Semantic entailment returned an empty response');
    const expectedClaims = reviewInputs.map((item) => item.claim);
    const assessments = parseEntailmentAssessments(
      parseLLMJson(content, 'semantic-entailment'),
      expectedClaims,
    );
    const result = {
      valid: assessments.every((assessment) => assessment.verdict === 'entailed'),
      assessments,
    };
    logAiCall({
      operation: 'semantic-entailment',
      model,
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Validate ${reviewInputs.length} resume claims against linked sources`,
      responseSummary: `${assessments.filter((item) => item.verdict === 'entailed').length}/${assessments.length} entailed`,
      ...extractUsage(data as Record<string, unknown>),
      durationMs: Date.now() - startMs,
      success: true,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logAiCall({
      operation: 'semantic-entailment',
      model,
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Validate ${reviewInputs.length} resume claims against linked sources`,
      responseSummary: message,
      durationMs: Date.now() - startMs,
      success: false,
      error: message,
    });
    throw error;
  }
}
