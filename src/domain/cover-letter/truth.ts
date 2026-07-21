import type { ProvenancedCoverLetter } from './contract.js';

export interface CoverLetterEvidenceSource {
  id: string;
  text: string;
}

export interface CoverLetterTruthContext {
  candidateSources: CoverLetterEvidenceSource[];
  allowedSourceClaimIds: ReadonlySet<string>;
  requirements: CoverLetterEvidenceSource[];
}

export interface CoverLetterTruthIssue {
  path: string;
  message: string;
}

export interface CoverLetterTruthResult {
  valid: boolean;
  issues: CoverLetterTruthIssue[];
}

/** Numeric facts are especially dangerous: each exact metric must exist in linked evidence. */
export function extractMetricTokens(text: string): string[] {
  const matches = text.match(/(?:[$£€]\s*)?\d[\d,.]*(?:\s*(?:%|x|\+|k|m|b|million|billion|thousand|years?|months?|users?|customers?))?/gi) ?? [];
  return [...new Set(matches.map((token) => token.toLowerCase().replace(/\s+/g, '').replace(/[,.](?=\d{3}(?:\D|$))/g, '')))];
}

export function validateCoverLetterTruth(
  letter: ProvenancedCoverLetter,
  context: CoverLetterTruthContext,
): CoverLetterTruthResult {
  const issues: CoverLetterTruthIssue[] = [];
  const candidateById = new Map(context.candidateSources.map((source) => [source.id, source.text]));
  const requirementById = new Map(context.requirements.map((source) => [source.id, source.text]));
  let wordCount = 0;

  letter.paragraphs.forEach((paragraph, paragraphIndex) => {
    paragraph.sentences.forEach((sentence, sentenceIndex) => {
      const path = `$.paragraphs[${paragraphIndex}].sentences[${sentenceIndex}]`;
      wordCount += sentence.text.split(/\s+/).filter(Boolean).length;
      const linkedTexts: string[] = [];
      for (const id of sentence.source_claim_ids) {
        const source = candidateById.get(id);
        if (!context.allowedSourceClaimIds.has(id) || source === undefined) {
          issues.push({ path: `${path}.source_claim_ids`, message: `source ${JSON.stringify(id)} is not evidence bound to the canonical resume version` });
        } else {
          linkedTexts.push(source);
        }
      }
      for (const id of sentence.requirement_ids) {
        const requirement = requirementById.get(id);
        if (requirement === undefined) {
          issues.push({ path: `${path}.requirement_ids`, message: `unknown requirement ${JSON.stringify(id)} for the bound job snapshot` });
        } else {
          linkedTexts.push(requirement);
        }
      }
      const linkedMetrics = new Set(extractMetricTokens(linkedTexts.join(' ')));
      for (const metric of extractMetricTokens(sentence.text)) {
        if (!linkedMetrics.has(metric)) {
          issues.push({ path: `${path}.text`, message: `unsupported metric ${JSON.stringify(metric)}` });
        }
      }
    });
  });
  if (wordCount > 300) {
    issues.push({ path: '$.paragraphs', message: `cover letter body exceeds 300 words (${wordCount})` });
  }
  return { valid: issues.length === 0, issues };
}
