import type {
  CandidateEvidence,
  CandidateProfileInput,
  SourceClaim,
  SourceExperience,
  SourceProject,
} from './types.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNullableString(value: unknown): string | null {
  const text = asString(value);
  return text.length > 0 ? text : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((item) => item.length > 0);
}

function candidateProfile(value: unknown): CandidateProfileInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as CandidateProfileInput;
}

/**
 * Convert a candidate profile revision into addressable, atomic evidence.
 * IDs use YAML source paths so they are deterministic and easy to inspect.
 */
export function buildCandidateEvidence(value: unknown): CandidateEvidence {
  const profile = candidateProfile(value);
  const claims: SourceClaim[] = [];
  const experiences: SourceExperience[] = [];
  const projects: SourceProject[] = [];
  const skillNames = new Map<string, string>();

  const workExperience = Array.isArray(profile.work_experience)
    ? profile.work_experience
    : [];

  workExperience.forEach((experience, experienceIndex) => {
    const id = `experience:${experienceIndex}`;
    const claimIds: string[] = [];
    asStringArray(experience.highlights).forEach((text, highlightIndex) => {
      const claimId = `${id}:highlight:${highlightIndex}`;
      claims.push({
        id: claimId,
        kind: 'experience',
        text,
        sourcePath: `work_experience[${experienceIndex}].highlights[${highlightIndex}]`,
        experienceId: id,
      });
      claimIds.push(claimId);
    });

    asStringArray(experience.technologies).forEach((text, technologyIndex) => {
      const claimId = `${id}:technology:${technologyIndex}`;
      claims.push({
        id: claimId,
        kind: 'skill',
        text,
        sourcePath: `work_experience[${experienceIndex}].technologies[${technologyIndex}]`,
        experienceId: id,
      });
      claimIds.push(claimId);
      skillNames.set(text.toLocaleLowerCase(), text);
    });

    const company = asString(experience.company);
    const title = asString(experience.title);
    const start = asString(experience.start);
    const end = asNullableString(experience.end);
    const identityClaimId = `${id}:identity`;
    claims.push({
      id: identityClaimId,
      kind: 'experience',
      text: `${title} at ${company}, ${start} to ${end ?? 'Present'}`,
      sourcePath: `work_experience[${experienceIndex}]`,
      experienceId: id,
    });
    claimIds.push(identityClaimId);

    experiences.push({
      id,
      company,
      title,
      start,
      end,
      claimIds,
    });
  });

  const profileProjects = Array.isArray(profile.projects) ? profile.projects : [];
  profileProjects.forEach((project, projectIndex) => {
    const id = `project:${projectIndex}`;
    const claimIds: string[] = [];
    asStringArray(project.highlights).forEach((text, highlightIndex) => {
      const claimId = `${id}:highlight:${highlightIndex}`;
      claims.push({
        id: claimId,
        kind: 'project',
        text,
        sourcePath: `projects[${projectIndex}].highlights[${highlightIndex}]`,
        projectId: id,
      });
      claimIds.push(claimId);
    });

    const technologies = asStringArray(project.technologies);
    technologies.forEach((text, technologyIndex) => {
      const claimId = `${id}:technology:${technologyIndex}`;
      claims.push({
        id: claimId,
        kind: 'skill',
        text,
        sourcePath: `projects[${projectIndex}].technologies[${technologyIndex}]`,
        projectId: id,
      });
      claimIds.push(claimId);
      skillNames.set(text.toLocaleLowerCase(), text);
    });

    const name = asString(project.name);
    const identityClaimId = `${id}:identity`;
    claims.push({
      id: identityClaimId,
      kind: 'project',
      text: `Project: ${name}`,
      sourcePath: `projects[${projectIndex}].name`,
      projectId: id,
    });
    claimIds.push(identityClaimId);

    projects.push({
      id,
      name,
      claimIds,
      technologies,
    });
  });

  if (profile.skills && typeof profile.skills === 'object') {
    Object.entries(profile.skills).forEach(([category, values]) => {
      asStringArray(values).forEach((text, skillIndex) => {
        const claimId = `skill:${category}:${skillIndex}`;
        claims.push({
          id: claimId,
          kind: 'skill',
          text,
          sourcePath: `skills.${category}[${skillIndex}]`,
        });
        skillNames.set(text.toLocaleLowerCase(), text);
      });
    });
  }

  return {
    claims,
    experiences,
    projects,
    skills: [...skillNames.values()],
  };
}

/** Compact JSON-safe context intended to be embedded in an LLM prompt. */
export function evidencePromptContext(evidence: CandidateEvidence): object {
  return {
    experiences: evidence.experiences,
    projects: evidence.projects,
    allowed_skills: evidence.skills,
    source_claims: evidence.claims,
  };
}
