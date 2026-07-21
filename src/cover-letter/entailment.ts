import type { ProvenancedCoverLetter } from '../domain/cover-letter/contract.js';
import type { CoverLetterTruthContext } from '../domain/cover-letter/truth.js';
import { extractUsage, logAiCall } from '../utils/ai-logger.js';
import { getDeepseekKey, getDeepseekModel, getDeepseekThinking } from '../utils/config.js';
import { parseLLMJson } from '../utils/parse-llm-json.js';

export type CoverLetterEntailmentVerdict = 'entailed' | 'unsupported' | 'uncertain';

export interface CoverLetterEntailmentAssessment {
  sentence: string;
  verdict: CoverLetterEntailmentVerdict;
  reason: string;
}

export interface CoverLetterEntailmentResult {
  valid: boolean;
  assessments: CoverLetterEntailmentAssessment[];
}

export interface CoverLetterEntailmentOptions {
  apiKey?: string;
  model?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

interface ReviewInput {
  sentence: string;
  linked_sources: Array<{ id: string; type: 'candidate' | 'job'; text: string }>;
}

const PROMPT = [
  'You are an independent factual entailment gate for a cover letter.',
  'For each sentence, decide whether every externally verifiable assertion is entailed by its linked sources alone.',
  'Subjective intent such as interest or enthusiasm is allowed, but it cannot imply unstated company knowledge or candidate facts.',
  'New metrics, skills, tenure, ownership, scope, causal claims, or impact are unsupported even when plausible.',
  'If support is incomplete or ambiguous, return uncertain. Never give the benefit of the doubt.',
  'Return only JSON: {"assessments":[{"sentence":"exact input sentence","verdict":"entailed|unsupported|uncertain","reason":"..."}]}.',
  'Return exactly one assessment for every input sentence and preserve each sentence exactly.',
].join('\n');

function isVerdict(value: unknown): value is CoverLetterEntailmentVerdict {
  return value === 'entailed' || value === 'unsupported' || value === 'uncertain';
}

export function parseCoverLetterAssessments(
  value: unknown,
  expectedSentences: readonly string[],
): CoverLetterEntailmentAssessment[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cover-letter entailment output must be an object');
  }
  const raw = (value as Record<string, unknown>)['assessments'];
  if (!Array.isArray(raw)) throw new Error('Cover-letter entailment output must contain assessments');
  const assessments = raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`assessments[${index}] must be an object`);
    }
    const item = entry as Record<string, unknown>;
    if (typeof item['sentence'] !== 'string' || !isVerdict(item['verdict'])
      || typeof item['reason'] !== 'string' || !item['reason'].trim()) {
      throw new Error(`assessments[${index}] is malformed`);
    }
    return { sentence: item['sentence'], verdict: item['verdict'], reason: item['reason'].trim() };
  });
  if (assessments.length !== expectedSentences.length) {
    throw new Error(`Expected ${expectedSentences.length} assessments, received ${assessments.length}`);
  }
  const counts = new Map<string, number>();
  assessments.forEach((assessment) => counts.set(assessment.sentence, (counts.get(assessment.sentence) ?? 0) + 1));
  expectedSentences.forEach((sentence) => {
    if (counts.get(sentence) !== 1) {
      throw new Error(`Assessment must contain the exact sentence once: ${JSON.stringify(sentence)}`);
    }
  });
  if (assessments.some((assessment) => !expectedSentences.includes(assessment.sentence))) {
    throw new Error('Assessment returned an unknown sentence');
  }
  return assessments;
}

function reviewInputs(letter: ProvenancedCoverLetter, context: CoverLetterTruthContext): ReviewInput[] {
  const candidate = new Map(context.candidateSources.map((source) => [source.id, source.text]));
  const requirements = new Map(context.requirements.map((source) => [source.id, source.text]));
  return letter.paragraphs.flatMap((paragraph) => paragraph.sentences.map((sentence) => ({
    sentence: sentence.text,
    linked_sources: [
      ...sentence.source_claim_ids.map((id) => {
        const text = candidate.get(id);
        if (text === undefined || !context.allowedSourceClaimIds.has(id)) {
          throw new Error(`Cannot semantically review unbound candidate source ${id}`);
        }
        return { id, type: 'candidate' as const, text };
      }),
      ...sentence.requirement_ids.map((id) => {
        const text = requirements.get(id);
        if (text === undefined) throw new Error(`Cannot semantically review unknown requirement ${id}`);
        return { id, type: 'job' as const, text };
      }),
    ],
  })));
}

/** A separate fail-closed model pass over the already deterministically validated sentences. */
export async function validateCoverLetterEntailment(
  letter: ProvenancedCoverLetter,
  context: CoverLetterTruthContext,
  options: CoverLetterEntailmentOptions = {},
): Promise<CoverLetterEntailmentResult> {
  const inputs = reviewInputs(letter, context);
  if (inputs.length === 0) throw new Error('Cover-letter entailment requires at least one sentence');
  const apiKey = options.apiKey ?? getDeepseekKey();
  if (!apiKey) throw new Error('DeepSeek API key is required for cover-letter entailment validation');
  const model = options.model ?? getDeepseekModel();
  const fetchImpl = options.fetchImpl ?? fetch;
  const startMs = Date.now();
  const request: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: JSON.stringify({ sentences: inputs }, null, 2) },
    ],
    max_tokens: 8192,
  };
  const thinking = getDeepseekThinking('audit-content');
  if (thinking) request['thinking'] = thinking;
  try {
    const response = await fetchImpl('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(request),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`DeepSeek API error ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, number>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Cover-letter entailment returned an empty response');
    const assessments = parseCoverLetterAssessments(
      parseLLMJson(content, 'cover-letter-entailment'),
      inputs.map((input) => input.sentence),
    );
    logAiCall({
      operation: 'cover-letter-entailment', model, provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Validate ${inputs.length} cover-letter sentences against bound evidence`,
      responseSummary: `${assessments.filter((item) => item.verdict === 'entailed').length}/${assessments.length} entailed`,
      ...extractUsage(data as Record<string, unknown>), durationMs: Date.now() - startMs, success: true,
    });
    return { valid: assessments.every((assessment) => assessment.verdict === 'entailed'), assessments };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logAiCall({
      operation: 'cover-letter-entailment', model, provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Validate ${inputs.length} cover-letter sentences against bound evidence`,
      responseSummary: message, durationMs: Date.now() - startMs, success: false, error: message,
    });
    throw error;
  }
}
