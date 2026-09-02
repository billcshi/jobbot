import type { ProvenancedTailoredResumeData, TailoredClaimProvenance } from './types.js';

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Normalize a model response that emitted one provenance row per summary
 * sentence while the V2 contract treats the complete summary as one claim.
 *
 * The merge is deliberately narrow: every source row must be an exact
 * substring of the summary, must not also be an emitted bullet, and together
 * the rows may leave only punctuation or whitespace uncovered.
 */
export function normalizeSummaryProvenance(
  resume: ProvenancedTailoredResumeData,
): ProvenancedTailoredResumeData {
  if (resume.claim_provenance.some((item) => item.claim === resume.summary)) return resume;

  const bulletClaims = new Set([
    ...resume.selected_experience.flatMap((experience) => experience.highlights),
    ...(resume.selected_projects ?? []).flatMap((project) => project.highlights),
  ]);
  const summaryParts = resume.claim_provenance.filter((item) =>
    item.claim.length > 0
      && !bulletClaims.has(item.claim)
      && resume.summary.includes(item.claim),
  );
  if (summaryParts.length === 0) return resume;

  let uncovered = resume.summary;
  for (const part of summaryParts) uncovered = uncovered.replace(part.claim, '');
  if (uncovered.replace(/[\s.,;:!?()[\]{}'"\u2013\u2014-]/g, '').length > 0) return resume;

  const merged: TailoredClaimProvenance = {
    claim: resume.summary,
    source_claim_ids: unique(summaryParts.flatMap((item) => item.source_claim_ids)),
    requirement_ids: unique(summaryParts.flatMap((item) => item.requirement_ids)),
  };
  const summaryPartSet = new Set(summaryParts);
  const remaining = resume.claim_provenance.filter((item) => !summaryPartSet.has(item));

  return {
    ...resume,
    summary_source_claim_ids: merged.source_claim_ids,
    claim_provenance: [merged, ...remaining],
  };
}
