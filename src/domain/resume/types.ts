/**
 * Domain contracts for truthful resume tailoring.
 *
 * The legacy renderer still consumes `highlights: string[]`. Provenance is
 * deliberately stored beside those strings so adopting this contract does not
 * require a renderer or template migration.
 */

export type EvidenceKind = 'experience' | 'project' | 'skill';

export interface SourceClaim {
  /** Stable within a profile revision; generated from the source path. */
  id: string;
  kind: EvidenceKind;
  text: string;
  sourcePath: string;
  experienceId?: string;
  projectId?: string;
}

export interface SourceExperience {
  id: string;
  company: string;
  title: string;
  start: string;
  end: string | null;
  claimIds: string[];
}

export interface SourceProject {
  id: string;
  name: string;
  claimIds: string[];
  technologies: string[];
}

export interface CandidateEvidence {
  claims: SourceClaim[];
  experiences: SourceExperience[];
  projects: SourceProject[];
  skills: string[];
}

export type RequirementKind =
  | 'responsibility'
  | 'skill'
  | 'experience'
  | 'education'
  | 'other';

export type RequirementPriority = 'required' | 'preferred';

export interface JobRequirement {
  id: string;
  text: string;
  kind: RequirementKind;
  priority: RequirementPriority;
  /** Exact normative JD spans independently verified before freezing. */
  sourceSpans?: string[];
}

export interface EvidenceMatch {
  requirement_id: string;
  source_claim_ids: string[];
  /** Explain relevance only; this field may not add candidate facts. */
  rationale: string;
}

export interface TailoredClaimProvenance {
  /** Must exactly equal one emitted summary, experience, or project claim. */
  claim: string;
  source_claim_ids: string[];
  requirement_ids: string[];
}

export interface TailoredExperience {
  source_experience_id: string;
  company: string;
  title: string;
  start: string;
  end: string | null;
  highlights: string[];
}

export interface TailoredProject {
  source_project_id: string;
  name: string;
  highlights: string[];
  technologies: string[];
}

export interface TailoredSkills {
  languages?: string[];
  frameworks?: string[];
  infrastructure?: string[];
  databases?: string[];
  data_processing?: string[];
}

/**
 * V2 output contract. Existing rendering fields remain unchanged while the
 * additional fields make every generated claim auditable.
 */
export interface ProvenancedTailoredResumeData {
  contract_version: 2;
  job_requirements: JobRequirement[];
  match_plan: EvidenceMatch[];
  summary: string;
  summary_source_claim_ids: string[];
  selected_experience: TailoredExperience[];
  selected_skills: TailoredSkills;
  selected_projects?: TailoredProject[];
  claim_provenance: TailoredClaimProvenance[];
  keyword_adjustments?: {
    original: string;
    adjusted: string;
    reason: string;
  }[];
}

/** Shape accepted from the existing candidate YAML document. */
export interface CandidateProfileInput {
  work_experience?: {
    company?: unknown;
    title?: unknown;
    start?: unknown;
    end?: unknown;
    highlights?: unknown;
    technologies?: unknown;
  }[];
  projects?: {
    name?: unknown;
    highlights?: unknown;
    technologies?: unknown;
  }[];
  skills?: Record<string, unknown>;
}

export type TruthIssueCode =
  | 'invalid_contract'
  | 'missing_source_experience'
  | 'experience_identity_changed'
  | 'missing_source_project'
  | 'project_identity_changed'
  | 'unknown_source_claim'
  | 'cross_source_claim'
  | 'missing_claim_provenance'
  | 'provenance_claim_mismatch'
  | 'unknown_requirement'
  | 'requirement_mismatch'
  | 'unsupported_number'
  | 'unsupported_skill';

export interface TruthIssue {
  code: TruthIssueCode;
  path: string;
  message: string;
}

export interface TruthValidationResult {
  valid: boolean;
  issues: TruthIssue[];
}
