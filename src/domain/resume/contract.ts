import type {
  EvidenceMatch,
  JobRequirement,
  ProvenancedTailoredResumeData,
  RequirementKind,
  RequirementPriority,
  TailoredClaimProvenance,
  TailoredExperience,
  TailoredProject,
  TailoredSkills,
} from './types.js';

export class ResumeContractError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ResumeContractError';
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResumeContractError(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ResumeContractError(path, 'expected an array');
  }
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ResumeContractError(path, 'expected a non-empty string');
  }
  return value.trim();
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return string(value, path);
}

function strings(value: unknown, path: string, allowEmpty = false): string[] {
  const result = array(value, path).map((item, index) => string(item, `${path}[${index}]`));
  if (!allowEmpty && result.length === 0) {
    throw new ResumeContractError(path, 'must contain at least one item');
  }
  return result;
}

function optionalStrings(value: unknown, path: string): string[] | undefined {
  return value === undefined ? undefined : strings(value, path, true);
}

function requirement(value: unknown, path: string): JobRequirement {
  const item = record(value, path);
  const kind = string(item['kind'], `${path}.kind`);
  const priority = string(item['priority'], `${path}.priority`);
  const allowedKinds: RequirementKind[] = [
    'responsibility', 'skill', 'experience', 'education', 'other',
  ];
  const allowedPriorities: RequirementPriority[] = ['required', 'preferred'];
  if (!allowedKinds.includes(kind as RequirementKind)) {
    throw new ResumeContractError(`${path}.kind`, `unsupported requirement kind "${kind}"`);
  }
  if (!allowedPriorities.includes(priority as RequirementPriority)) {
    throw new ResumeContractError(`${path}.priority`, `unsupported priority "${priority}"`);
  }
  return {
    id: string(item['id'], `${path}.id`),
    text: string(item['text'], `${path}.text`),
    kind: kind as RequirementKind,
    priority: priority as RequirementPriority,
    ...(item['sourceSpans'] === undefined
      ? {}
      : { sourceSpans: strings(item['sourceSpans'], `${path}.sourceSpans`) }),
  };
}

function evidenceMatch(value: unknown, path: string): EvidenceMatch {
  const item = record(value, path);
  return {
    requirement_id: string(item['requirement_id'], `${path}.requirement_id`),
    source_claim_ids: strings(item['source_claim_ids'], `${path}.source_claim_ids`, true),
    rationale: string(item['rationale'], `${path}.rationale`),
  };
}

function tailoredExperience(value: unknown, path: string): TailoredExperience {
  const item = record(value, path);
  return {
    source_experience_id: string(item['source_experience_id'], `${path}.source_experience_id`),
    company: string(item['company'], `${path}.company`),
    title: string(item['title'], `${path}.title`),
    start: string(item['start'], `${path}.start`),
    end: nullableString(item['end'], `${path}.end`),
    highlights: strings(item['highlights'], `${path}.highlights`),
  };
}

function tailoredProject(value: unknown, path: string): TailoredProject {
  const item = record(value, path);
  return {
    source_project_id: string(item['source_project_id'], `${path}.source_project_id`),
    name: string(item['name'], `${path}.name`),
    highlights: strings(item['highlights'], `${path}.highlights`),
    technologies: strings(item['technologies'], `${path}.technologies`, true),
  };
}

function tailoredSkills(value: unknown, path: string): TailoredSkills {
  const item = record(value, path);
  return {
    languages: optionalStrings(item['languages'], `${path}.languages`),
    frameworks: optionalStrings(item['frameworks'], `${path}.frameworks`),
    infrastructure: optionalStrings(item['infrastructure'], `${path}.infrastructure`),
    databases: optionalStrings(item['databases'], `${path}.databases`),
    data_processing: optionalStrings(item['data_processing'], `${path}.data_processing`),
  };
}

function provenance(value: unknown, path: string): TailoredClaimProvenance {
  const item = record(value, path);
  return {
    claim: string(item['claim'], `${path}.claim`),
    source_claim_ids: strings(item['source_claim_ids'], `${path}.source_claim_ids`),
    requirement_ids: strings(item['requirement_ids'], `${path}.requirement_ids`, true),
  };
}

/** Parse and validate the complete V2 LLM output contract at runtime. */
export function parseProvenancedTailoredResumeData(value: unknown): ProvenancedTailoredResumeData {
  const root = record(value, '$');
  if (root['contract_version'] !== 2) {
    throw new ResumeContractError('$.contract_version', 'expected 2');
  }

  const selectedProjects = root['selected_projects'] === undefined
    ? undefined
    : array(root['selected_projects'], '$.selected_projects')
      .map((item, index) => tailoredProject(item, `$.selected_projects[${index}]`));

  const keywordAdjustments = root['keyword_adjustments'] === undefined
    ? undefined
    : array(root['keyword_adjustments'], '$.keyword_adjustments').map((value, index) => {
      const path = `$.keyword_adjustments[${index}]`;
      const item = record(value, path);
      return {
        original: string(item['original'], `${path}.original`),
        adjusted: string(item['adjusted'], `${path}.adjusted`),
        reason: string(item['reason'], `${path}.reason`),
      };
    });

  const jobRequirements = array(root['job_requirements'], '$.job_requirements')
    .map((item, index) => requirement(item, `$.job_requirements[${index}]`));
  const requirementIds = new Set<string>();
  jobRequirements.forEach((item, index) => {
    if (requirementIds.has(item.id)) {
      throw new ResumeContractError(
        `$.job_requirements[${index}].id`,
        `duplicate requirement id ${JSON.stringify(item.id)}`,
      );
    }
    requirementIds.add(item.id);
  });

  return {
    contract_version: 2,
    job_requirements: jobRequirements,
    match_plan: array(root['match_plan'], '$.match_plan')
      .map((item, index) => evidenceMatch(item, `$.match_plan[${index}]`)),
    summary: string(root['summary'], '$.summary'),
    summary_source_claim_ids: strings(
      root['summary_source_claim_ids'],
      '$.summary_source_claim_ids',
    ),
    selected_experience: array(root['selected_experience'], '$.selected_experience')
      .map((item, index) => tailoredExperience(item, `$.selected_experience[${index}]`)),
    selected_skills: tailoredSkills(root['selected_skills'], '$.selected_skills'),
    selected_projects: selectedProjects,
    claim_provenance: array(root['claim_provenance'], '$.claim_provenance')
      .map((item, index) => provenance(item, `$.claim_provenance[${index}]`)),
    keyword_adjustments: keywordAdjustments,
  };
}
