export interface CoverLetterSentence {
  text: string;
  source_claim_ids: string[];
  requirement_ids: string[];
}

export interface CoverLetterParagraph {
  sentences: CoverLetterSentence[];
}

export interface ProvenancedCoverLetter {
  contract_version: 1;
  greeting: string;
  paragraphs: CoverLetterParagraph[];
  closing: string;
}

export class CoverLetterContractError extends Error {
  public constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'CoverLetterContractError';
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoverLetterContractError(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CoverLetterContractError(path, 'expected a non-empty string');
  }
  return value.trim();
}

function ids(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new CoverLetterContractError(path, 'expected an array');
  const result = value.map((item, index) => text(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new CoverLetterContractError(path, 'must not contain duplicate IDs');
  }
  return result;
}

/** Strict runtime contract for model output. Every factual sentence carries provenance. */
export function parseProvenancedCoverLetter(value: unknown): ProvenancedCoverLetter {
  const root = record(value, '$');
  const sentenceTexts = new Set<string>();
  if (root['contract_version'] !== 1) {
    throw new CoverLetterContractError('$.contract_version', 'expected 1');
  }
  if (!Array.isArray(root['paragraphs']) || root['paragraphs'].length === 0
    || root['paragraphs'].length > 4) {
    throw new CoverLetterContractError('$.paragraphs', 'expected 1 to 4 paragraphs');
  }
  const paragraphs = root['paragraphs'].map((rawParagraph, paragraphIndex) => {
    const paragraphPath = `$.paragraphs[${paragraphIndex}]`;
    const paragraph = record(rawParagraph, paragraphPath);
    if (!Array.isArray(paragraph['sentences']) || paragraph['sentences'].length === 0) {
      throw new CoverLetterContractError(`${paragraphPath}.sentences`, 'must contain at least one sentence');
    }
    return {
      sentences: paragraph['sentences'].map((rawSentence, sentenceIndex) => {
        const sentencePath = `${paragraphPath}.sentences[${sentenceIndex}]`;
        const sentence = record(rawSentence, sentencePath);
        const parsed = {
          text: text(sentence['text'], `${sentencePath}.text`),
          source_claim_ids: ids(sentence['source_claim_ids'], `${sentencePath}.source_claim_ids`),
          requirement_ids: ids(sentence['requirement_ids'], `${sentencePath}.requirement_ids`),
        };
        if (parsed.source_claim_ids.length === 0 && parsed.requirement_ids.length === 0) {
          throw new CoverLetterContractError(sentencePath, 'must cite candidate evidence or a job requirement');
        }
        if (sentenceTexts.has(parsed.text)) {
          throw new CoverLetterContractError(`${sentencePath}.text`, 'sentence text must be unique for exact semantic assessment');
        }
        sentenceTexts.add(parsed.text);
        return parsed;
      }),
    };
  });
  return {
    contract_version: 1,
    greeting: text(root['greeting'], '$.greeting'),
    paragraphs,
    closing: text(root['closing'], '$.closing'),
  };
}

export function coverLetterBody(letter: ProvenancedCoverLetter): string {
  return letter.paragraphs
    .map((paragraph) => paragraph.sentences.map((sentence) => sentence.text).join(' '))
    .join('\n\n');
}
