import { createHash } from 'node:crypto';
import type {
  JobRequirement,
  RequirementKind,
  RequirementPriority,
} from '../domain/resume/types.js';
import { getDeepseekKey, getDeepseekModel, getDeepseekThinking } from '../utils/config.js';
import { extractUsage, logAiCall } from '../utils/ai-logger.js';
import { parseLLMJson } from '../utils/parse-llm-json.js';

export interface RequirementDraft {
  text: string;
  kind?: RequirementKind;
  priority?: RequirementPriority;
}

export interface StoredRequirement {
  category: string;
  text: string;
  importance: 'required' | 'preferred' | 'context';
  sourceSpans?: string[];
}

export interface RequirementExtractionOptions {
  apiKey?: string;
  model?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface RequirementCoverageEntry {
  source_text: string;
  requirement_ids: string[];
  covered: boolean;
  reason: string;
}

function normalizedText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function requirementId(text: string): string {
  const digest = createHash('sha256')
    .update(normalizedText(text).toLocaleLowerCase())
    .digest('hex')
    .slice(0, 12);
  return `requirement:${digest}`;
}

const NORMATIVE_LANGUAGE = /\b(must|required|requirement|qualification|responsibilit|you will|you'll|need(?:ed)? to|minimum|preferred|nice to have|experience (?:with|in)|proficien|ability to|degree|\d+\+? years?|work permit|authorized to work)\b/i;

/** Deterministically identify JD spans that need an explicit coverage decision. */
export function requirementCandidateSpans(jobDescription: string): string[] {
  const candidates: string[] = [];
  let inRequirementSection = false;
  for (const rawLine of jobDescription.split(/\r?\n/)) {
    const line = normalizedText(rawLine.replace(/^\s*[-*•]\s*/, ''));
    if (!line) continue;
    const heading = line.replace(/:$/, '');
    if (/^(requirements?|qualifications?|responsibilities|what you(?:'ll| will) do|what we(?:'re| are) looking for)$/i.test(heading)) {
      inRequirementSection = true;
      continue;
    }
    if (/^[A-Z][A-Za-z &/]{2,40}:$/.test(rawLine.trim()) && !NORMATIVE_LANGUAGE.test(line)) {
      inRequirementSection = false;
    }
    const sentences = line.split(/(?<=[.!?])\s+/).map(normalizedText);
    for (const sentence of sentences) {
      if (sentence.split(/\s+/).length >= 3 && (inRequirementSection || NORMATIVE_LANGUAGE.test(sentence))) {
        candidates.push(sentence);
      }
    }
  }
  return [...new Set(candidates)];
}

function meaningfulTokens(value: string): Set<string> {
  const ignored = new Set([
    'must', 'required', 'requirement', 'requirements', 'preferred', 'minimum',
    'experience', 'years', 'with', 'from', 'your', 'will', 'have', 'ability',
    'responsibilities', 'qualification', 'qualifications', 'need', 'needed',
  ]);
  return new Set(normalizedText(value).toLowerCase().split(/[^a-z0-9+#.]+/)
    .filter((token) => token.length >= 3 && !ignored.has(token)));
}

/** Parse and fail closed on an incomplete or laundered coverage assessment. */
export function validateRequirementCoverage(
  candidateSpans: readonly string[],
  requirements: readonly JobRequirement[],
  value: unknown,
): RequirementCoverageEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Requirement coverage output must be an object');
  }
  const rawCoverage = (value as Record<string, unknown>)['coverage'];
  if (!Array.isArray(rawCoverage)) throw new Error('Requirement coverage must be an array');
  const requirementById = new Map(requirements.map((item) => [item.id, item]));
  const expected = new Set(candidateSpans);
  const seen = new Set<string>();
  const coverage = rawCoverage.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`coverage[${index}] must be an object`);
    }
    const item = raw as Record<string, unknown>;
    const sourceText = item['source_text'];
    const ids = item['requirement_ids'];
    const covered = item['covered'];
    const reason = item['reason'];
    if (typeof sourceText !== 'string' || !expected.has(sourceText) || seen.has(sourceText)) {
      throw new Error(`coverage[${index}].source_text is unexpected or duplicated`);
    }
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      throw new Error(`coverage[${index}].requirement_ids must be a string array`);
    }
    if (typeof covered !== 'boolean' || typeof reason !== 'string' || !reason.trim()) {
      throw new Error(`coverage[${index}] needs covered and a non-empty reason`);
    }
    if (!covered || ids.length === 0) {
      throw new Error(`Requirement extraction left JD span uncovered: ${JSON.stringify(sourceText)}`);
    }
    const spanTokens = meaningfulTokens(sourceText);
    for (const id of ids) {
      const requirement = requirementById.get(id);
      if (!requirement) throw new Error(`coverage[${index}] references unknown requirement ${id}`);
      const overlaps = [...meaningfulTokens(requirement.text)].some((token) => spanTokens.has(token));
      if (!overlaps) {
        throw new Error(`Requirement ${id} has no textual support in covered JD span`);
      }
    }
    seen.add(sourceText);
    return { source_text: sourceText, requirement_ids: ids, covered, reason };
  });
  const missing = candidateSpans.filter((span) => !seen.has(span));
  if (missing.length > 0) {
    throw new Error(`Requirement coverage omitted ${missing.length} JD span(s): ${JSON.stringify(missing)}`);
  }
  return coverage;
}

/**
 * Turn extracted JD requirement drafts into stable, deduplicated domain data.
 * The extraction itself may use an LLM; identity and normalization do not.
 */
export function createJobRequirements(drafts: readonly RequirementDraft[]): JobRequirement[] {
  const byId = new Map<string, JobRequirement>();
  drafts.forEach((draft) => {
    const text = normalizedText(draft.text);
    if (text.length === 0) return;
    const id = requirementId(text);
    if (byId.has(id)) return;
    byId.set(id, {
      id,
      text,
      kind: draft.kind ?? 'other',
      priority: draft.priority ?? 'required',
    });
  });
  return [...byId.values()];
}

function isRequirementKind(value: string): value is RequirementKind {
  return value === 'responsibility' || value === 'skill' || value === 'experience'
    || value === 'education' || value === 'other';
}

function isRequirementPriority(value: string): value is RequirementPriority {
  return value === 'required' || value === 'preferred';
}

/** Rebuild stable domain IDs from frozen database rows. */
export function storedRequirementsToDomain(rows: readonly StoredRequirement[]): JobRequirement[] {
  return createJobRequirements(rows.map((row) => ({
    text: row.text,
    kind: isRequirementKind(row.category) ? row.category : 'other',
    priority: row.importance === 'required' ? 'required' : 'preferred',
    sourceSpans: row.sourceSpans ?? [],
  })));
}

export function parseRequirementDrafts(value: unknown): RequirementDraft[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Requirement extraction output must be an object');
  }
  const requirements = (value as Record<string, unknown>)['requirements'];
  if (!Array.isArray(requirements) || requirements.length === 0) {
    throw new Error('Requirement extraction must return at least one requirement');
  }
  return requirements.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`requirements[${index}] must be an object`);
    }
    const item = raw as Record<string, unknown>;
    const text = item['text'];
    const kind = item['kind'];
    const priority = item['priority'];
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error(`requirements[${index}].text must be a non-empty string`);
    }
    if (typeof kind !== 'string' || !isRequirementKind(kind)) {
      throw new Error(`requirements[${index}].kind is invalid`);
    }
    if (typeof priority !== 'string' || !isRequirementPriority(priority)) {
      throw new Error(`requirements[${index}].priority is invalid`);
    }
    return { text, kind, priority };
  });
}

const REQUIREMENT_EXTRACTION_PROMPT = [
  'Extract explicit job requirements from the supplied posting.',
  'Do not evaluate a candidate and do not infer requirements absent from the posting.',
  'Return only JSON: {"requirements":[{"text":"...","kind":"responsibility|skill|experience|education|other","priority":"required|preferred"}]}.',
  'Preserve the posting meaning. Use required only for mandatory language; use preferred for optional or nice-to-have language.',
].join('\n');

const REQUIREMENT_COVERAGE_PROMPT = [
  'Independently verify that extracted requirements cover every supplied normative JD span.',
  'Do not invent spans or requirement IDs. Mark covered=false when no extracted requirement preserves the span meaning.',
  'Return only JSON: {"coverage":[{"source_text":"exact supplied span","requirement_ids":["requirement:..."],"covered":true,"reason":"..."}]}.',
  'Return exactly one entry for every supplied span.',
].join('\n');

/**
 * Independent, fail-closed requirement extraction stage. The returned IDs are
 * deterministic; callers must freeze these requirements before tailoring.
 */
export async function extractJobRequirements(
  jobDescription: string,
  options: RequirementExtractionOptions = {},
): Promise<JobRequirement[]> {
  if (!jobDescription.trim()) throw new Error('Cannot extract requirements from an empty job description');
  const apiKey = options.apiKey ?? getDeepseekKey();
  if (!apiKey) throw new Error('DeepSeek API key is required for requirement extraction');
  const model = options.model ?? getDeepseekModel();
  const fetchImpl = options.fetchImpl ?? fetch;
  const thinking = getDeepseekThinking('extract');
  const requestBody: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: REQUIREMENT_EXTRACTION_PROMPT },
      { role: 'user', content: jobDescription.slice(0, 20_000) },
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
    if (!content) throw new Error('Requirement extraction returned an empty response');
    const requirements = createJobRequirements(parseRequirementDrafts(parseLLMJson(content, 'requirements')));
    if (requirements.length === 0) throw new Error('Requirement extraction returned no usable requirements');
    const candidateSpans = requirementCandidateSpans(jobDescription);
    if (candidateSpans.length === 0) {
      throw new Error('No normative JD spans were identified; requirements cannot be frozen safely');
    }
    const coverageResponse = await fetchImpl('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: REQUIREMENT_COVERAGE_PROMPT },
          { role: 'user', content: JSON.stringify({ candidate_spans: candidateSpans, requirements }) },
        ],
        max_tokens: 8192,
      }),
      signal: options.signal,
    });
    if (!coverageResponse.ok) {
      const body = await coverageResponse.text();
      throw new Error(`Requirement coverage API error ${coverageResponse.status}: ${body.slice(0, 200)}`);
    }
    const coverageData = await coverageResponse.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const coverageContent = coverageData.choices?.[0]?.message?.content;
    if (!coverageContent) throw new Error('Requirement coverage returned an empty response');
    const coverage = validateRequirementCoverage(
      candidateSpans,
      requirements,
      parseLLMJson(coverageContent, 'requirement-coverage'),
    );
    requirements.forEach((requirement) => {
      requirement.sourceSpans = coverage
        .filter((entry) => entry.requirement_ids.includes(requirement.id))
        .map((entry) => entry.source_text);
      if (requirement.sourceSpans.length === 0) {
        throw new Error(`Extracted requirement ${requirement.id} has no independently verified JD source span`);
      }
    });
    logAiCall({
      operation: 'extract-requirements',
      model,
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Extract requirements from ${jobDescription.length} characters`,
      responseSummary: `${requirements.length} frozen requirements`,
      ...extractUsage(data as Record<string, unknown>),
      durationMs: Date.now() - startMs,
      success: true,
    });
    return requirements;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logAiCall({
      operation: 'extract-requirements',
      model,
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Extract requirements from ${jobDescription.length} characters`,
      responseSummary: message,
      durationMs: Date.now() - startMs,
      success: false,
      error: message,
    });
    throw error;
  }
}

/** JSON schema fragment for a structured JD requirement extraction call. */
export const JOB_REQUIREMENTS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requirements'],
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'kind', 'priority'],
        properties: {
          text: { type: 'string', minLength: 1 },
          kind: {
            type: 'string',
            enum: ['responsibility', 'skill', 'experience', 'education', 'other'],
          },
          priority: { type: 'string', enum: ['required', 'preferred'] },
        },
      },
    },
  },
} as const;
