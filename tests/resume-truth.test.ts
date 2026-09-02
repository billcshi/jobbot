import { describe, expect, it } from 'vitest';
import { buildCandidateEvidence } from '../src/domain/resume/evidence.js';
import { normalizeSummaryProvenance } from '../src/domain/resume/provenance.js';
import type { ProvenancedTailoredResumeData } from '../src/domain/resume/types.js';
import {
  createJobRequirements,
  extractJobRequirements,
  requirementCandidateSpans,
  validateRequirementCoverage,
} from '../src/jobs/requirements.js';
import { validateResume } from '../src/resume/validate.js';
import { validateSemanticEntailment } from '../src/resume/entailment.js';
import { preservesInjectedContent } from '../src/jobs/render.js';
import {
  calculateAuditOutcome,
  parseAuditModelOutput,
  parseLocalVisualReview,
  parseLocalVisualReviewSafely,
} from '../src/jobs/audit.js';

const PROFILE = {
  work_experience: [
    {
      company: 'Acme Corp',
      title: 'Software Engineer',
      start: 'January 2022',
      end: null,
      highlights: [
        'Built an API serving 10,000 requests per day with TypeScript and PostgreSQL.',
        'Reduced API latency by 25% through caching.',
      ],
      technologies: ['TypeScript', 'PostgreSQL'],
    },
    {
      company: 'Earlier Co',
      title: 'Engineering Intern',
      start: 'June 2021',
      end: 'August 2021',
      highlights: ['Wrote internal Python automation.'],
      technologies: ['Python'],
    },
  ],
  projects: [
    {
      name: 'Queue Lab',
      highlights: ['Implemented a durable queue in Go.'],
      technologies: ['Go'],
    },
  ],
  skills: {
    languages: ['TypeScript', 'Python', 'Go'],
    databases: ['PostgreSQL'],
    infrastructure: ['AWS'],
  },
};

function validResume(): ProvenancedTailoredResumeData {
  const summary = 'Software engineer who built an API serving 10,000 requests per day.';
  const highlight = 'Built a TypeScript API serving 10,000 requests per day.';
  const projectHighlight = 'Implemented a durable queue in Go.';
  return {
    contract_version: 2,
    job_requirements: [
      {
        id: 'requirement:backend',
        text: 'Build backend APIs',
        kind: 'responsibility',
        priority: 'required',
      },
    ],
    match_plan: [
      {
        requirement_id: 'requirement:backend',
        source_claim_ids: ['experience:0:highlight:0'],
        rationale: 'The source describes API development.',
      },
    ],
    summary,
    summary_source_claim_ids: ['experience:0:highlight:0'],
    selected_experience: [
      {
        source_experience_id: 'experience:0',
        company: 'Acme Corp',
        title: 'Software Engineer',
        start: 'January 2022',
        end: null,
        highlights: [highlight],
      },
    ],
    selected_skills: {
      languages: ['TypeScript'],
      databases: ['PostgreSQL'],
      infrastructure: ['AWS'],
    },
    selected_projects: [
      {
        source_project_id: 'project:0',
        name: 'Queue Lab',
        highlights: [projectHighlight],
        technologies: ['Go'],
      },
    ],
    claim_provenance: [
      {
        claim: summary,
        source_claim_ids: ['experience:0:highlight:0'],
        requirement_ids: ['requirement:backend'],
      },
      {
        claim: highlight,
        source_claim_ids: ['experience:0:highlight:0'],
        requirement_ids: ['requirement:backend'],
      },
      {
        claim: projectHighlight,
        source_claim_ids: ['project:0:highlight:0'],
        requirement_ids: [],
      },
    ],
  };
}

describe('candidate evidence', () => {
  it('creates deterministic, addressable source claims', () => {
    const first = buildCandidateEvidence(PROFILE);
    const second = buildCandidateEvidence(structuredClone(PROFILE));

    expect(first).toEqual(second);
    expect(first.experiences[0]?.id).toBe('experience:0');
    expect(first.claims[0]?.id).toBe('experience:0:highlight:0');
    expect(first.claims.some((claim) => claim.id === 'experience:0:identity')).toBe(true);
    expect(first.claims.some((claim) => claim.id === 'project:0:identity')).toBe(true);
    expect(first.skills).toContain('AWS');
  });
});

describe('summary provenance normalization', () => {
  it('merges exact sentence provenance into the complete summary claim', () => {
    const resume = validResume();
    const first = 'Software engineer who built an API';
    const second = 'serving 10,000 requests per day';
    resume.claim_provenance = [
      {
        claim: first,
        source_claim_ids: ['experience:0:identity'],
        requirement_ids: ['requirement:backend'],
      },
      {
        claim: second,
        source_claim_ids: ['experience:0:highlight:0'],
        requirement_ids: ['requirement:backend'],
      },
      ...resume.claim_provenance.slice(1),
    ];

    const normalized = normalizeSummaryProvenance(resume);
    expect(normalized.claim_provenance[0]).toEqual({
      claim: resume.summary,
      source_claim_ids: ['experience:0:identity', 'experience:0:highlight:0'],
      requirement_ids: ['requirement:backend'],
    });
    expect(normalized.summary_source_claim_ids).toEqual([
      'experience:0:identity',
      'experience:0:highlight:0',
    ]);
  });

  it('does not merge partial provenance that leaves words uncovered', () => {
    const resume = validResume();
    resume.claim_provenance[0] = {
      claim: 'built an API',
      source_claim_ids: ['experience:0:highlight:0'],
      requirement_ids: ['requirement:backend'],
    };

    expect(normalizeSummaryProvenance(resume)).toBe(resume);
  });
});

describe('hash-bound local visual review', () => {
  it('accepts a review bound to the exact job, resume version, and PDF hash', () => {
    expect(parseLocalVisualReview({
      schema_version: 1,
      job_id: 2,
      resume_version_id: 4,
      resume_sha256: 'abc123',
      reviewer_type: 'agent',
      reviewer: 'PDF visual inspection',
      status: 'passed',
      score: 90,
      summary: 'One page with no clipping or overlap.',
      issues: [],
    }, { jobId: 2, resumeVersionId: 4, resumeSha256: 'abc123' })).toMatchObject({
      status: 'passed',
      score: 90,
      reviewer: 'PDF visual inspection',
    });
  });

  it('rejects a stale review after the canonical PDF changes', () => {
    expect(() => parseLocalVisualReview({
      schema_version: 1,
      job_id: 2,
      resume_version_id: 4,
      resume_sha256: 'old-hash',
      reviewer_type: 'agent',
      reviewer: 'PDF visual inspection',
      status: 'passed',
      score: 90,
      summary: 'Reviewed.',
      issues: [],
    }, { jobId: 2, resumeVersionId: 4, resumeSha256: 'new-hash' })).toThrow('PDF hash does not match');
  });

  it('turns an invalid local review into a fallback diagnostic instead of throwing', () => {
    expect(parseLocalVisualReviewSafely({
      schema_version: 1,
      job_id: 2,
      resume_version_id: 4,
      resume_sha256: 'stale',
      reviewer_type: 'human',
      reviewer: 'Reviewer',
      status: 'passed', score: 90, summary: 'Reviewed.', issues: [],
    }, { jobId: 2, resumeVersionId: 4, resumeSha256: 'current' })).toEqual({
      review: null,
      error: 'Local visual review PDF hash does not match',
    });
  });
});

describe('resume truth validation', () => {
  it('accepts a provenanced rewrite backed by candidate evidence', () => {
    expect(validateResume(PROFILE, validResume())).toEqual({ valid: true, issues: [] });
  });

  it('blocks changes to company, title, and dates', () => {
    const output = validResume();
    output.selected_experience[0]!.company = 'Better Acme';
    output.selected_experience[0]!.start = 'January 2020';

    const result = validateResume(PROFILE, output);
    expect(result.valid).toBe(false);
    expect(result.issues.filter((item) => item.code === 'experience_identity_changed')).toHaveLength(2);
  });

  it('blocks invented and approximate numbers', () => {
    const output = validResume();
    const invented = 'Built a TypeScript API serving 12,000+ requests per day.';
    output.selected_experience[0]!.highlights = [invented];
    output.claim_provenance[1]!.claim = invented;

    const result = validateResume(PROFILE, output);
    expect(result.issues.some((item) => item.code === 'unsupported_number')).toBe(true);
  });

  it('blocks a selected skill absent from all candidate evidence', () => {
    const output = validResume();
    output.selected_skills.languages = ['Rust'];

    const result = validateResume(PROFILE, output);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'unsupported_skill' }));
  });

  it('blocks missing provenance and unknown source claims', () => {
    const output = validResume();
    output.claim_provenance = output.claim_provenance.filter(
      (item) => item.claim !== output.summary,
    );
    output.match_plan[0]!.source_claim_ids = ['experience:99:highlight:0'];

    const result = validateResume(PROFILE, output);
    expect(result.issues.some((item) => item.code === 'missing_claim_provenance')).toBe(true);
    expect(result.issues.some((item) => item.code === 'unknown_source_claim')).toBe(true);
  });

  it('rejects duplicate requirement ids that could hide a frozen requirement', () => {
    const output = validResume();
    const backend = output.job_requirements[0]!;
    output.job_requirements = [backend, { ...backend }];
    const requirements = [
      backend,
      {
        id: 'requirement:database',
        text: 'Operate relational databases',
        kind: 'skill' as const,
        priority: 'required' as const,
      },
    ];

    const result = validateResume(PROFILE, output, { requirements });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_contract',
      path: '$.job_requirements[1].id',
    }));
  });

  it('blocks evidence borrowed from a different employer', () => {
    const output = validResume();
    output.claim_provenance[1]!.source_claim_ids = ['experience:1:highlight:0'];

    const result = validateResume(PROFILE, output);
    expect(result.issues.some((item) => item.code === 'cross_source_claim')).toBe(true);
  });

  it('rejects legacy output with a clear contract error instead of silently degrading', () => {
    const legacy = {
      summary: 'Backend engineer',
      selected_experience: [],
      selected_skills: {},
    };

    const result = validateResume(PROFILE, legacy);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe('invalid_contract');
    expect(result.issues[0]?.message).toContain('contract_version');
  });

  it('blocks a tailoring response that edits a frozen requirement', () => {
    const output = validResume();
    const frozen = structuredClone(output.job_requirements);
    output.job_requirements[0]!.text = 'A requirement rewritten by the tailoring model';

    const result = validateResume(PROFILE, output, { requirements: frozen });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'requirement_mismatch' }));
  });
});

describe('job requirement normalization', () => {
  it('treats The Muse section headings and newsletter copy as structure, not requirements', () => {
    const spans = requirementCandidateSpans([
      "What You'll Be Doing",
      'Build and ship services powering subscription tiering.',
      'Want more jobs like this?',
      'Get Software Engineering jobs delivered to your inbox every week.',
      'Email Address*Send me The Muse newsletters.',
      'Qualifications',
      'Professional Experience: 5+ years of backend software development.',
      'Preferred Skills',
      'Experience with consumer subscription products.',
      "Why You'll Love Working Here:",
      'Flexible PTO and employee discounts.',
      'What We Offer',
      'We provide an inclusive environment.',
    ].join('\n'));

    expect(spans).toContain('Build and ship services powering subscription tiering.');
    expect(spans).toContain('Professional Experience: 5+ years of backend software development.');
    expect(spans).toContain('Experience with consumer subscription products.');
    expect(spans).not.toContain("What You'll Be Doing");
    expect(spans).not.toContain('Want more jobs like this?');
    expect(spans).not.toContain('Flexible PTO and employee discounts.');
    expect(spans).not.toContain('We provide an inclusive environment.');
  });

  it('deduplicates requirements and generates stable IDs', () => {
    const requirements = createJobRequirements([
      { text: ' Build backend APIs ', kind: 'responsibility' },
      { text: 'Build   backend APIs', kind: 'responsibility' },
    ]);

    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.id).toMatch(/^requirement:[a-f0-9]{12}$/);
  });

  it('extracts requirements in an independent structured call', async () => {
    const drafts = [{
      text: 'Build backend APIs',
      kind: 'responsibility' as const,
      priority: 'required' as const,
    }];
    const requirement = createJobRequirements(drafts)[0]!;
    let call = 0;
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      call += 1;
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = call === 1
        ? { requirements: drafts }
        : { coverage: [{
          source_text: 'You must build backend APIs.',
          requirement_ids: [requirement.id],
          covered: true,
          reason: 'The extracted responsibility preserves the explicit must statement.',
        }] };
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await extractJobRequirements('You must build backend APIs.', {
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl,
    });
    expect(result).toEqual([
      expect.objectContaining({ text: 'Build backend APIs', id: expect.stringMatching(/^requirement:/) }),
    ]);
    expect(call).toBe(2);
    expect(requestBodies[0]?.['thinking']).toEqual({ type: 'disabled' });
    expect(requestBodies[1]?.['thinking']).toEqual(requestBodies[0]?.['thinking']);
    const extractionMessages = requestBodies[0]?.['messages'] as Array<{ content: string }>;
    const extractionInput = JSON.parse(extractionMessages[1]!.content) as Record<string, unknown>;
    expect(extractionInput['normative_spans_to_cover']).toEqual(['You must build backend APIs.']);
  });

  it('refuses to freeze an extraction that misses a normative JD span', async () => {
    const jobDescription = [
      'You must build backend APIs.',
      'You must operate PostgreSQL in production.',
    ].join('\n');
    const requirements = createJobRequirements([{
      text: 'Build backend APIs', kind: 'responsibility', priority: 'required',
    }]);
    const spans = requirementCandidateSpans(jobDescription);
    expect(spans).toHaveLength(2);
    expect(() => validateRequirementCoverage(spans, requirements, {
      coverage: [
        {
          source_text: spans[0], requirement_ids: [requirements[0]!.id], covered: true,
          reason: 'Covered by the API responsibility.',
        },
        {
          source_text: spans[1], requirement_ids: [], covered: false,
          reason: 'No extracted requirement covers PostgreSQL.',
        },
      ],
    })).toThrow('uncovered');
  });
});

describe('semantic entailment gate', () => {
  it('blocks non-numeric fabrication reproduced by the audit', async () => {
    const output = validResume();
    const fabricated = 'Led a global engineering organization and owned its platform strategy.';
    output.selected_experience[0]!.highlights = [fabricated];
    output.claim_provenance[1]!.claim = fabricated;

    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        assessments: output.claim_provenance.map((item) => ({
          claim: item.claim,
          verdict: item.claim === fabricated ? 'unsupported' : 'entailed',
          reason: item.claim === fabricated
            ? 'The linked source says only that an API was built; it does not support leadership or global ownership.'
            : 'The linked source entails the claim.',
        })),
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const result = await validateSemanticEntailment(PROFILE, output, {
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl,
    });
    expect(result.valid).toBe(false);
    expect(result.assessments).toContainEqual(expect.objectContaining({
      claim: fabricated,
      verdict: 'unsupported',
    }));
  });

  it('fails closed when the semantic reviewer omits a claim', async () => {
    const output = validResume();
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"assessments":[]}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    await expect(validateSemanticEntailment(PROFILE, output, {
      apiKey: 'test-key', model: 'test-model', fetchImpl,
    })).rejects.toThrow('Expected');
  });
});

describe('render and audit safety gates', () => {
  it('rejects a LaTeX layout fix that changes injected content', () => {
    const original = String.raw`\item Built an API \& reduced latency`;
    const changed = String.raw`\item Led an API \& reduced latency`;
    expect(preservesInjectedContent(original, changed, ['Built an API \\& reduced latency'])).toBe(false);
    expect(preservesInjectedContent(original, original, ['Built an API \\& reduced latency'])).toBe(true);
  });

  it('rejects a LaTeX fix that moves intact content under another item', () => {
    const original = 'Acme Corp\nBuilt API\nEarlier Co\nWrote automation';
    const moved = 'Acme Corp\nWrote automation\nEarlier Co\nBuilt API';
    const protectedContent = ['Acme Corp', 'Built API', 'Earlier Co', 'Wrote automation'];
    expect(preservesInjectedContent(original, moved, protectedContent)).toBe(false);
  });

  it('rejects a LaTeX fix that moves intact content into another section', () => {
    const original = String.raw`\section{Experience}
Acme Corp
Built API
\section{Education}
State University`;
    const moved = String.raw`\section{Experience}
Acme Corp
\section{Education}
Built API
State University`;
    expect(preservesInjectedContent(original, moved, ['Acme Corp', 'Built API', 'State University']))
      .toBe(false);
  });

  it('rejects a LaTeX fix that appends an unprovenanced claim', () => {
    const original = String.raw`\section{Experience}\item Built API`;
    const added = String.raw`\section{Experience}\item Built API\item Led 100 engineers`;
    expect(preservesInjectedContent(original, added, ['Built API'])).toBe(false);
  });

  it('rejects malformed audit results instead of assigning a default score', () => {
    expect(() => parseAuditModelOutput({ issues: [], summary: 'missing score' })).toThrow('score');
    expect(() => parseAuditModelOutput({ issues: [], score: 70 })).toThrow('summary');
  });

  it('accepts the shared audit contract required by every committee prompt', () => {
    expect(parseAuditModelOutput({
      score: 82,
      summary: 'Clear and relevant, with minor density concerns.',
      issues: [{
        severity: 'low',
        category: 'content',
        description: 'One section is dense.',
        suggestion: 'Trim one bullet.',
      }],
    })).toEqual({
      score: 82,
      summary: 'Clear and relevant, with minor density concerns.',
      issues: [{
        severity: 'low',
        category: 'content',
        description: 'One section is dense.',
        suggestion: 'Trim one bullet.',
      }],
    });
  });

  it('cannot pass when visual review failed or is unavailable', () => {
    expect(calculateAuditOutcome(100, true, 0, 'unavailable')).toEqual({
      overallScore: 0, passed: false,
    });
    expect(calculateAuditOutcome(100, true, 0, 'failed')).toEqual({
      overallScore: 0, passed: false,
    });
    expect(calculateAuditOutcome(90, true, 90, 'passed')).toEqual({
      overallScore: 90, passed: true,
    });
  });
});
