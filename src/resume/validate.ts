import { parseProvenancedTailoredResumeData, ResumeContractError } from '../domain/resume/contract.js';
import { buildCandidateEvidence } from '../domain/resume/evidence.js';
import type {
  CandidateEvidence,
  JobRequirement,
  ProvenancedTailoredResumeData,
  SourceClaim,
  TailoredClaimProvenance,
  TruthIssue,
  TruthValidationResult,
} from '../domain/resume/types.js';

export interface TruthValidationOptions {
  /** Requirements extracted from the immutable job snapshot, when available. */
  requirements?: readonly JobRequirement[];
}

function issue(
  issues: TruthIssue[],
  code: TruthIssue['code'],
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function numericFacts(text: string): string[] {
  const matches = text.match(/[$€£]?\d[\d,.]*(?:\s?(?:%|\+|[kKmMbB]))?/g) ?? [];
  return matches.map((value) => value
    .toLocaleLowerCase()
    .replace(/[\s,]/g, '')
    .replace(/[.,]+$/, ''));
}

function checkNumbers(
  claim: string,
  sources: readonly SourceClaim[],
  path: string,
  issues: TruthIssue[],
): void {
  const allowedNumbers = new Set(sources.flatMap((source) => numericFacts(source.text)));
  for (const number of numericFacts(claim)) {
    if (!allowedNumbers.has(number)) {
      issue(
        issues,
        'unsupported_number',
        path,
        `Numeric fact "${number}" does not appear verbatim in the linked source claims`,
      );
    }
  }
}

function linkedClaims(
  ids: readonly string[],
  claimById: ReadonlyMap<string, SourceClaim>,
  path: string,
  issues: TruthIssue[],
): SourceClaim[] {
  const result: SourceClaim[] = [];
  ids.forEach((id, index) => {
    const source = claimById.get(id);
    if (!source) {
      issue(
        issues,
        'unknown_source_claim',
        `${path}[${index}]`,
        `Source claim "${id}" does not exist in this candidate profile revision`,
      );
      return;
    }
    result.push(source);
  });
  return result;
}

function findProvenance(
  claim: string,
  provenance: readonly TailoredClaimProvenance[],
  path: string,
  issues: TruthIssue[],
): TailoredClaimProvenance | undefined {
  const matches = provenance.filter((item) => item.claim === claim);
  if (matches.length === 0) {
    issue(
      issues,
      'missing_claim_provenance',
      path,
      'Every emitted claim must have an exact claim_provenance entry',
    );
    return undefined;
  }
  if (matches.length > 1) {
    issue(
      issues,
      'provenance_claim_mismatch',
      path,
      'An emitted claim must have exactly one claim_provenance entry',
    );
  }
  return matches[0];
}

function validateIdentity(
  output: ProvenancedTailoredResumeData,
  evidence: CandidateEvidence,
  issues: TruthIssue[],
): void {
  output.selected_experience.forEach((experience, index) => {
    const path = `$.selected_experience[${index}]`;
    const source = evidence.experiences.find((item) => item.id === experience.source_experience_id);
    if (!source) {
      issue(
        issues,
        'missing_source_experience',
        `${path}.source_experience_id`,
        `Experience "${experience.source_experience_id}" does not exist`,
      );
      return;
    }

    const immutableFields = [
      ['company', experience.company, source.company],
      ['title', experience.title, source.title],
      ['start', experience.start, source.start],
      ['end', experience.end, source.end],
    ] as const;
    immutableFields.forEach(([field, actual, expected]) => {
      if (actual !== expected) {
        issue(
          issues,
          'experience_identity_changed',
          `${path}.${field}`,
          `${field} must exactly equal the source value ${JSON.stringify(expected)}`,
        );
      }
    });
  });

  (output.selected_projects ?? []).forEach((project, index) => {
    const path = `$.selected_projects[${index}]`;
    const source = evidence.projects.find((item) => item.id === project.source_project_id);
    if (!source) {
      issue(
        issues,
        'missing_source_project',
        `${path}.source_project_id`,
        `Project "${project.source_project_id}" does not exist`,
      );
      return;
    }
    if (project.name !== source.name) {
      issue(
        issues,
        'project_identity_changed',
        `${path}.name`,
        `Project name must exactly equal the source value ${JSON.stringify(source.name)}`,
      );
    }
    const allowedTechnologies = new Set(
      source.technologies.map((technology) => technology.toLocaleLowerCase()),
    );
    project.technologies.forEach((technology, technologyIndex) => {
      if (!allowedTechnologies.has(technology.toLocaleLowerCase())) {
        issue(
          issues,
          'unsupported_skill',
          `${path}.technologies[${technologyIndex}]`,
          `Technology "${technology}" is not listed for source project "${source.name}"`,
        );
      }
    });
  });
}

function validateClaim(
  claim: string,
  path: string,
  owner: { experienceId?: string; projectId?: string },
  output: ProvenancedTailoredResumeData,
  claimById: ReadonlyMap<string, SourceClaim>,
  validRequirementIds: ReadonlySet<string>,
  issues: TruthIssue[],
): void {
  const provenance = findProvenance(claim, output.claim_provenance, path, issues);
  if (!provenance) return;
  const sources = linkedClaims(
    provenance.source_claim_ids,
    claimById,
    `${path}.source_claim_ids`,
    issues,
  );

  sources.forEach((source) => {
    const wrongExperience = owner.experienceId && source.experienceId !== owner.experienceId;
    const wrongProject = owner.projectId && source.projectId !== owner.projectId;
    if (wrongExperience || wrongProject) {
      issue(
        issues,
        'cross_source_claim',
        path,
        `Source claim "${source.id}" belongs to a different profile item`,
      );
    }
  });

  provenance.requirement_ids.forEach((id, index) => {
    if (!validRequirementIds.has(id)) {
      issue(
        issues,
        'unknown_requirement',
        `${path}.requirement_ids[${index}]`,
        `Requirement "${id}" is not part of the job snapshot`,
      );
    }
  });
  checkNumbers(claim, sources, path, issues);
}

/**
 * Deterministically enforce the resume truth boundary.
 *
 * This validator makes no LLM calls. Any issue is blocking: callers should not
 * render or submit a resume until `valid` is true.
 */
export function validateResume(
  candidateProfile: unknown,
  tailoredResume: unknown,
  options: TruthValidationOptions = {},
): TruthValidationResult {
  let output: ProvenancedTailoredResumeData;
  try {
    output = parseProvenancedTailoredResumeData(tailoredResume);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const path = error instanceof ResumeContractError ? error.path : '$';
    return {
      valid: false,
      issues: [{ code: 'invalid_contract', path, message }],
    };
  }

  const evidence = buildCandidateEvidence(candidateProfile);
  const issues: TruthIssue[] = [];
  const claimById = new Map(evidence.claims.map((claim) => [claim.id, claim]));
  const requirements = options.requirements ?? output.job_requirements;
  const validRequirementIds = new Set(requirements.map((requirement) => requirement.id));

  if (options.requirements) {
    if (output.job_requirements.length !== options.requirements.length) {
      issue(
        issues,
        'requirement_mismatch',
        '$.job_requirements',
        `Tailored output must copy all ${options.requirements.length} frozen requirements exactly`,
      );
    }
    const frozenById = new Map(options.requirements.map((requirement) => [requirement.id, requirement]));
    const outputIds = new Set(output.job_requirements.map((requirement) => requirement.id));
    options.requirements.forEach((requirement) => {
      if (!outputIds.has(requirement.id)) {
        issue(
          issues,
          'requirement_mismatch',
          '$.job_requirements',
          `Frozen requirement "${requirement.id}" is missing from the tailored output`,
        );
      }
    });
    output.job_requirements.forEach((requirement, index) => {
      const frozen = frozenById.get(requirement.id);
      if (!frozen) {
        issue(
          issues,
          'unknown_requirement',
          `$.job_requirements[${index}].id`,
          `Requirement "${requirement.id}" is not part of the immutable job snapshot`,
        );
      } else if (
        requirement.text !== frozen.text
        || requirement.kind !== frozen.kind
        || requirement.priority !== frozen.priority
      ) {
        issue(
          issues,
          'requirement_mismatch',
          `$.job_requirements[${index}]`,
          `Requirement "${requirement.id}" must be copied verbatim from the immutable job snapshot`,
        );
      }
    });
  }

  validateIdentity(output, evidence, issues);

  linkedClaims(
    output.summary_source_claim_ids,
    claimById,
    '$.summary_source_claim_ids',
    issues,
  );
  validateClaim(output.summary, '$.summary', {}, output, claimById, validRequirementIds, issues);
  const summaryProvenance = output.claim_provenance.find((item) => item.claim === output.summary);
  if (summaryProvenance) {
    const declared = [...output.summary_source_claim_ids].sort().join('\n');
    const linked = [...summaryProvenance.source_claim_ids].sort().join('\n');
    if (declared !== linked) {
      issue(
        issues,
        'provenance_claim_mismatch',
        '$.summary_source_claim_ids',
        'Summary source IDs must exactly match its claim_provenance source IDs',
      );
    }
  }

  output.selected_experience.forEach((experience, experienceIndex) => {
    experience.highlights.forEach((claim, highlightIndex) => {
      validateClaim(
        claim,
        `$.selected_experience[${experienceIndex}].highlights[${highlightIndex}]`,
        { experienceId: experience.source_experience_id },
        output,
        claimById,
        validRequirementIds,
        issues,
      );
    });
  });

  (output.selected_projects ?? []).forEach((project, projectIndex) => {
    project.highlights.forEach((claim, highlightIndex) => {
      validateClaim(
        claim,
        `$.selected_projects[${projectIndex}].highlights[${highlightIndex}]`,
        { projectId: project.source_project_id },
        output,
        claimById,
        validRequirementIds,
        issues,
      );
    });
  });

  const emittedClaims = new Set([
    output.summary,
    ...output.selected_experience.flatMap((experience) => experience.highlights),
    ...(output.selected_projects ?? []).flatMap((project) => project.highlights),
  ]);
  output.claim_provenance.forEach((provenance, index) => {
    if (!emittedClaims.has(provenance.claim)) {
      issue(
        issues,
        'provenance_claim_mismatch',
        `$.claim_provenance[${index}].claim`,
        'Provenance claim does not exactly match any emitted resume claim',
      );
    }
  });

  output.match_plan.forEach((match, index) => {
    if (!validRequirementIds.has(match.requirement_id)) {
      issue(
        issues,
        'unknown_requirement',
        `$.match_plan[${index}].requirement_id`,
        `Requirement "${match.requirement_id}" is not part of the job snapshot`,
      );
    }
    linkedClaims(
      match.source_claim_ids,
      claimById,
      `$.match_plan[${index}].source_claim_ids`,
      issues,
    );
  });

  const allowedSkills = new Set(evidence.skills.map((skill) => skill.toLocaleLowerCase()));
  const selectedSkillGroups: [string, readonly string[] | undefined][] = [
    ['languages', output.selected_skills.languages],
    ['frameworks', output.selected_skills.frameworks],
    ['infrastructure', output.selected_skills.infrastructure],
    ['databases', output.selected_skills.databases],
    ['data_processing', output.selected_skills.data_processing],
  ];
  selectedSkillGroups.forEach(([category, skills]) => {
    (skills ?? []).forEach((skill: string, index: number) => {
      if (!allowedSkills.has(skill.toLocaleLowerCase())) {
        issue(
          issues,
          'unsupported_skill',
          `$.selected_skills.${category}[${index}]`,
          `Skill "${skill}" does not exist in the candidate profile`,
        );
      }
    });
  });

  return { valid: issues.length === 0, issues };
}

export function assertTruthfulResume(
  candidateProfile: unknown,
  tailoredResume: unknown,
  options: TruthValidationOptions = {},
): ProvenancedTailoredResumeData {
  const result = validateResume(candidateProfile, tailoredResume, options);
  if (!result.valid) {
    const details = result.issues.map((item) => `${item.path}: ${item.message}`).join('\n');
    throw new Error(`Tailored resume failed truth validation:\n${details}`);
  }
  return parseProvenancedTailoredResumeData(tailoredResume);
}
