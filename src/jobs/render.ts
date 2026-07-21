import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getDb } from '../db/client.js';
import { PROJECT_ROOT, RESUMES_DIR, jobResumeDir } from '../utils/paths.js';
import { getActiveUserId } from '../utils/user-context.js';
import { logger } from '../utils/logger.js';
import { createHash } from 'node:crypto';
import { parseProvenancedTailoredResumeData } from '../domain/resume/contract.js';
import type { ProvenancedTailoredResumeData } from '../domain/resume/types.js';
import { ProfileRepository } from '../repositories/profile-repository.js';
import { JobKnowledgeRepository } from '../repositories/job-knowledge-repository.js';
import { storedRequirementsToDomain } from './requirements.js';
import { validateResume } from '../resume/validate.js';
import { rethrowAbort, throwIfAborted } from '../utils/abort.js';

const LATEX_TEMPLATE_PATH = `${PROJECT_ROOT}/resumes/master.tex`;

/** Escape special LaTeX characters in user-provided text. */
function latexEscape(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/[&]/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/[{}]/g, (m) => m === '{' ? '\\{' : '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

export interface RenderResult {
  success: boolean;
  jobId: number;
  pdfPath?: string;
  texPath?: string;
  error?: string;
  latexFixed?: boolean;
}

/** Legacy guard retained for callers: fail closed on every full-document rewrite. */
export function preservesInjectedContent(
  originalTex: string,
  fixedTex: string,
  _protectedContent: readonly string[],
): boolean {
  return originalTex === fixedTex;
}

interface CandidateProfile {
  name: { first: string; last: string };
  email: string;
  phone: string;
  location: { city: string; state: string; country: string };
  work_experience: {
    company: string;
    title: string;
    start: string;
    end: string | null;
    location?: string;
    highlights: string[];
  }[];
  education: {
    school: string;
    degree: string;
    start: string;
    end: string | null;
    location?: string;
    notes?: string;
  }[];
  projects?: {
    name: string;
    highlights: string[];
    technologies: string[];
  }[];
  skills: {
    languages: string[];
    frameworks: string[];
    infrastructure: string[];
    databases: string[];
  };
  links: {
    github?: string;
    linkedin?: string;
    website?: string;
  };
}

/**
 * Render a tailored resume to PDF using LaTeX.
 *
 * Steps:
 * 1. Resolve a canonical resume version and its immutable content_json
 * 2. Read its bound profile revision and frozen job requirements
 * 3. Re-run truth/provenance validation and require valid resume_claims
 * 4. Read the LaTeX template
 * 5. Inject data into the template
 * 6. Compile with pdflatex
 */
export async function renderJob(jobId: number, visualFeedback?: string[], _composeVersion?: number, userId?: number, resumeVersionId?: number, signal?: AbortSignal): Promise<RenderResult> {
  throwIfAborted(signal);
  const resolvedUserId = userId ?? getActiveUserId();
  const db = getDb();
  const job = db.prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(jobId, resolvedUserId) as
    | { id: number }
    | undefined;

  if (!job) {
    return { success: false, jobId, error: `Job not found: id=${jobId}` };
  }

  const canonicalVersion = (resumeVersionId === undefined
    ? db.prepare(`
        SELECT id, draft_id, profile_revision_id, job_snapshot_id, content_json
        FROM resume_versions
        WHERE job_id = ? AND user_id = ? AND content_json IS NOT NULL
        ORDER BY id DESC LIMIT 1
      `).get(jobId, resolvedUserId)
    : db.prepare(`
        SELECT id, draft_id, profile_revision_id, job_snapshot_id, content_json
        FROM resume_versions
        WHERE id = ? AND job_id = ? AND user_id = ? AND content_json IS NOT NULL
      `).get(resumeVersionId, jobId, resolvedUserId)) as {
        id: number;
        draft_id: number | null;
        profile_revision_id: number | null;
        job_snapshot_id: number | null;
        content_json: string;
      } | undefined;
  if (!canonicalVersion || canonicalVersion.profile_revision_id === null || canonicalVersion.job_snapshot_id === null) {
    return { success: false, jobId, error: 'No fully bound canonical resume version exists. Tailor first.' };
  }

  let tailored: ProvenancedTailoredResumeData;
  let candidate: CandidateProfile;
  try {
    tailored = parseProvenancedTailoredResumeData(JSON.parse(canonicalVersion.content_json) as unknown);
    const revision = new ProfileRepository(db).getRevision(canonicalVersion.profile_revision_id);
    if (!revision) throw new Error(`Profile revision ${canonicalVersion.profile_revision_id} does not exist`);
    candidate = revision.candidate as unknown as CandidateProfile;
    const requirements = storedRequirementsToDomain(
      new JobKnowledgeRepository(db).listRequirements(canonicalVersion.job_snapshot_id),
    );
    if (requirements.length === 0) throw new Error('Canonical job snapshot has no frozen requirements');
    const truth = validateResume(revision.candidate, tailored, { requirements });
    if (!truth.valid) {
      throw new Error(truth.issues.map((item) => `${item.path}: ${item.message}`).join('; '));
    }

    const claimRows = db.prepare(`
      SELECT rendered_text, source_claim_ids_json, validation_status
      FROM resume_claims WHERE resume_version_id = ? ORDER BY section, ordinal
    `).all(canonicalVersion.id) as Array<{
      rendered_text: string;
      source_claim_ids_json: string;
      validation_status: string;
    }>;
    if (claimRows.length !== tailored.claim_provenance.length) {
      throw new Error('Canonical resume claim rows do not match content provenance');
    }
    const unusedRows = [...claimRows];
    for (const provenance of tailored.claim_provenance) {
      const rowIndex = unusedRows.findIndex((row) => row.rendered_text === provenance.claim);
      if (rowIndex < 0) throw new Error(`Missing canonical claim row for ${JSON.stringify(provenance.claim)}`);
      const row = unusedRows.splice(rowIndex, 1)[0]!;
      if (row.validation_status !== 'valid') {
        throw new Error(`Resume claim is not valid: ${JSON.stringify(provenance.claim)}`);
      }
      const ids = JSON.parse(row.source_claim_ids_json) as unknown;
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
        throw new Error('Canonical resume claim has invalid source IDs');
      }
      if ([...ids].sort().join('\n') !== [...provenance.source_claim_ids].sort().join('\n')) {
        throw new Error(`Canonical claim provenance differs for ${JSON.stringify(provenance.claim)}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, jobId, error: `Canonical resume validation failed: ${msg}` };
  }

  // Read LaTeX template
  let template: string;
  try {
    template = readFileSync(LATEX_TEMPLATE_PATH, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, jobId, error: `Failed to read LaTeX template: ${msg}` };
  }

  // ---- Build template data ----

  const fullName = `${candidate.name.first} ${candidate.name.last}`;
  const locationStr = `${candidate.location.city}, ${candidate.location.state}`;
  const githubUsername = candidate.links.github?.split('/').pop() ?? '';
  const linkedinUsername = candidate.links.linkedin?.split('/').pop() ?? '';

  /** Format a YYYY-MM date to "Month Year" (e.g., "2025-04" → "April 2025"). */
  function formatDate(ym: string | null | undefined): string {
    if (!ym) return 'Present';
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const m = ym.match(/^(\d{4})-(\d{2})$/);
    if (!m || !m[1] || !m[2]) return ym;
    const month = months[parseInt(m[2], 10) - 1];
    return `${month} ${m[1]}`;
  }

  /** Format a date range: "April 2025 – Present" or "September 2023 – June 2024". */
  function formatDateRange(start: string | null | undefined, end: string | null | undefined): string {
    const s = formatDate(start);
    const e = formatDate(end);
    // Both missing — show nothing
    if (!start && !end) return '';
    // Only end date known (e.g., graduation year) — show just the end date
    if (!start && end) return e;
    // End is null or "Present" — ongoing (job or in-progress degree)
    if (!end || e === 'Present') return `${s} -- Present`;
    return `${s} -- ${e}`;
  }

  // Inject the data into the template
  let tex = template;
  const inject = (value: string | null | undefined): string => {
    return latexEscape(value);
  };

  // Simple replacements
  tex = tex.replace(/\{\{name\}\}/g, inject(fullName));
  tex = tex.replace(/\{\{email\}\}/g, inject(candidate.email));
  tex = tex.replace(/\{\{phone\}\}/g, inject(candidate.phone));
  tex = tex.replace(/\{\{location\}\}/g, inject(locationStr));

  // ---- Build experience section ----
  const experienceItems = tailored.selected_experience;
  const expSectionMatch = tex.match(/\{\{#experience\}\}([\s\S]*?)\{\{\/experience\}\}/);
  if (expSectionMatch && experienceItems.length > 0) {
    const itemTemplate = expSectionMatch[1]!;
    const expContent = experienceItems.map((exp) => {
      let item = itemTemplate;
      item = item.replace(/\{\{company\}\}/g, inject(exp.company));
      item = item.replace(/\{\{title\}\}/g, inject(exp.title));
      item = item.replace(/\{\{date_range\}\}/g, inject(formatDateRange(exp.start, exp.end)));

      // Build highlights
      const hlMatch = item.match(/\{\{#highlights\}\}([\s\S]*?)\{\{\/highlights\}\}/);
      if (hlMatch) {
        const hlTemplate = hlMatch[1]!;
        const hlContent = exp.highlights.map((h) => hlTemplate.replace(/\{\{\.\}\}/g, inject(h))).join('\n');
        item = item.replace(hlMatch[0], hlContent);
      }

      // Remove any remaining mustache placeholders
      item = item.replace(/\{\{[#/]?\w+\}\}/g, '');

      return item;
    }).join('\n');
    tex = tex.replace(expSectionMatch[0], expContent);
  } else if (expSectionMatch) {
    tex = tex.replace(expSectionMatch[0], '');
  }

  // ---- Build education section ----
  const eduSectionMatch = tex.match(/\{\{#education\}\}([\s\S]*?)\{\{\/education\}\}/);
  if (eduSectionMatch && candidate.education.length > 0) {
    const itemTemplate = eduSectionMatch[1]!;
    const eduContent = candidate.education.map((edu) => {
      let item = itemTemplate;
      item = item.replace(/\{\{school\}\}/g, inject(edu.school));
      item = item.replace(/\{\{degree\}\}/g, inject(edu.degree));
      item = item.replace(/\{\{date_range\}\}/g, inject(formatDateRange(edu.start, edu.end)));
      item = item.replace(/\{\{location\}\}/g, inject(edu.location || ''));

      // Handle notes conditional — truncate long coursework lists
      const notesMatch = item.match(/\{\{#notes\}\}([\s\S]*?)\{\{\/notes\}\}/);
      if (notesMatch) {
        if (edu.notes) {
          let notesText = edu.notes;
          // Truncate verbose coursework: keep only the first ~8 items for experienced candidates
          if (notesText.length > 200 && notesText.includes(',')) {
            const items = notesText.split(',');
            if (items.length > 8) {
              notesText = items.slice(0, 6).join(',') + ', ...';
            }
          }
          item = item.replace(notesMatch[0], notesMatch[1]!.replace(/\{\{notes\}\}/g, inject(notesText)));
        } else {
          item = item.replace(notesMatch[0], '');
        }
      }

      item = item.replace(/\{\{[#/]?\w+\}\}/g, '');
      return item;
    }).join('\n');
    tex = tex.replace(eduSectionMatch[0], eduContent);
  } else if (eduSectionMatch) {
    tex = tex.replace(eduSectionMatch[0], '');
  }

  // ---- Build skills section ----
  const skills = tailored.selected_skills;
  const skillsSectionMatch = tex.match(/\{\{#skills\}\}([\s\S]*?)\{\{\/skills\}\}/);
  if (skillsSectionMatch) {
    const itemTemplate = skillsSectionMatch[1]!;
    const skillsList: { category: string; skills_list: string }[] = [];
    if (skills.languages && skills.languages.length > 0) {
      skillsList.push({ category: 'Languages', skills_list: skills.languages.join(', ') });
    }
    if (skills.frameworks && skills.frameworks.length > 0) {
      skillsList.push({ category: 'Frameworks', skills_list: skills.frameworks.join(', ') });
    }
    if (skills.infrastructure && skills.infrastructure.length > 0) {
      skillsList.push({ category: 'Infrastructure', skills_list: skills.infrastructure.join(', ') });
    }
    if (skills.databases && skills.databases.length > 0) {
      skillsList.push({ category: 'Databases', skills_list: skills.databases.join(', ') });
    }
    if (skills.data_processing && skills.data_processing.length > 0) {
      skillsList.push({ category: 'Data Processing', skills_list: skills.data_processing.join(', ') });
    }

    if (skillsList.length > 0) {
      const skillsContent = skillsList.map((s) => {
        let item = itemTemplate;
        item = item.replace(/\{\{category\}\}/g, inject(s.category));
        item = item.replace(/\{\{skills_list\}\}/g, inject(s.skills_list));
        item = item.replace(/\{\{[#/]?\w+\}\}/g, '');
        return item;
      }).join('\n');
      tex = tex.replace(skillsSectionMatch[0], skillsContent);
    } else {
      tex = tex.replace(skillsSectionMatch[0], '');
    }
  }

  // ---- Build projects section (optional) ----
  const projSectionMatch = tex.match(/\{\{#has_projects\}\}([\s\S]*?)\{\{\/has_projects\}\}/);
  if (projSectionMatch) {
    // Only render projects selected in the canonical, validated resume. Falling
    // back to profile content would bypass the resume claim gate.
    const displayProjects = (tailored.selected_projects ?? []).slice(0, 1);
    if (displayProjects.length > 0) {
      const sectionTemplate = projSectionMatch[1]!;
      // Now iterate each project against the inner {{#projects}}...{{/projects}} block
      const projItemMatch = sectionTemplate.match(/\{\{#projects\}\}([\s\S]*?)\{\{\/projects\}\}/);
      let sectionContent = sectionTemplate;
      if (projItemMatch) {
        const itemTemplate = projItemMatch[1]!;
        const projContent = displayProjects.map((proj) => {
          let item = itemTemplate;
          item = item.replace(/\{\{project_name\}\}/g, inject(proj.name));
          item = item.replace(/\{\{technologies\}\}/g, inject(proj.technologies.join(', ')));
          const hlMatch = item.match(/\{\{#highlights\}\}([\s\S]*?)\{\{\/highlights\}\}/);
          if (hlMatch && proj.highlights.length > 0) {
            const hlTemplate = hlMatch[1]!;
            const hlContent = proj.highlights.slice(0, 2).map((h) => hlTemplate.replace(/\{\{\.\}\}/g, inject(h))).join('\n');
            item = item.replace(hlMatch[0], hlContent);
          }
          item = item.replace(/\{\{[#/]?\w+\}\}/g, '');
          return item;
        }).join('\n');
        sectionContent = sectionContent.replace(projItemMatch[0], projContent);
      }
      sectionContent = sectionContent.replace(/\{\{[#/]?\w+\}\}/g, '');
      tex = tex.replace(projSectionMatch[0], sectionContent);
    } else {
      tex = tex.replace(projSectionMatch[0], '');
    }
  }

  // ---- Handle summary/objective ----
  const objSectionMatch = tex.match(/\{\{#objective\}\}([\s\S]*?)\{\{\/objective\}\}/);
  if (objSectionMatch) {
    if (tailored.summary) {
      tex = tex.replace(objSectionMatch[0], objSectionMatch[1]!.replace(/\{\{objective\}\}/g, inject(tailored.summary)));
    } else {
      tex = tex.replace(objSectionMatch[0], '');
    }
  }

  // ---- Handle contact conditionals (phone, email, linkedin, github) ----
  // Phone conditional
  const phoneCondMatch = tex.match(/\{\{#phone\}\}([\s\S]*?)\{\{\/phone\}\}/);
  if (phoneCondMatch) {
    if (candidate.phone) {
      tex = tex.replace(phoneCondMatch[0], phoneCondMatch[1]!);
    } else {
      tex = tex.replace(phoneCondMatch[0], '');
    }
  }

  // Email conditional
  const emailCondMatch = tex.match(/\{\{#email\}\}([\s\S]*?)\{\{\/email\}\}/);
  if (emailCondMatch) {
    if (candidate.email) {
      tex = tex.replace(emailCondMatch[0], emailCondMatch[1]!);
    } else {
      tex = tex.replace(emailCondMatch[0], '');
    }
  }

  // Linkedin conditional
  const linkedinCondMatch = tex.match(/\{\{#linkedin\}\}([\s\S]*?)\{\{\/linkedin\}\}/);
  if (linkedinCondMatch) {
    if (linkedinUsername) {
      tex = tex.replace(linkedinCondMatch[0], linkedinCondMatch[1]!.replace(/\{\{linkedin\}\}/g, inject(linkedinUsername)));
    } else {
      tex = tex.replace(linkedinCondMatch[0], '');
    }
  }

  // Github conditional
  const githubCondMatch = tex.match(/\{\{#github\}\}([\s\S]*?)\{\{\/github\}\}/);
  if (githubCondMatch) {
    if (githubUsername) {
      tex = tex.replace(githubCondMatch[0], githubCondMatch[1]!.replace(/\{\{github\}\}/g, inject(githubUsername)));
    } else {
      tex = tex.replace(githubCondMatch[0], '');
    }
  }

  // Clean up any remaining mustache placeholders and escaped braces
  tex = tex.replace(/\{\{[#/]?\w+\}\}/g, '');
  tex = tex.replace(/\{\{(\w+)\}\}/g, '');

  // Full-document model rewrites are intentionally disabled: they can add
  // unprovenanced resume claims. Layout changes belong in the reviewed template.
  const latexFixed = false;
  if (visualFeedback && visualFeedback.length > 0) {
    logger.warn(
      `Skipped ${visualFeedback.length} automatic LaTeX rewrite(s); `
      + 'edit the reviewed template for layout-only changes.',
    );
  }

  // ---- Write .tex file ----
  mkdirSync(RESUMES_DIR, { recursive: true });
  const texPath = `${jobResumeDir(jobId)}/resume-${canonicalVersion.id}.tex`;
  throwIfAborted(signal);
  writeFileSync(texPath, tex, 'utf-8');
  logger.info(`Wrote LaTeX: ${texPath}`);

  // ---- Compile with pdflatex ----
  try {
    // Run pdflatex twice for proper layout (TOC, cross-refs etc.)
    const outputDir = jobResumeDir(jobId);
    execSync(`pdflatex -interaction=nonstopmode -output-directory="${outputDir}" "${texPath}"`, {
      timeout: 30_000,
      stdio: 'pipe',
    });
    throwIfAborted(signal);
    execSync(`pdflatex -interaction=nonstopmode -output-directory="${outputDir}" "${texPath}"`, {
      timeout: 30_000,
      stdio: 'pipe',
    });

    const pdfPath = `${jobResumeDir(jobId)}/resume-${canonicalVersion.id}.pdf`;
    if (!existsSync(pdfPath)) {
      return { success: false, jobId, texPath, error: 'pdflatex completed but PDF was not produced. Check LaTeX log for errors.' };
    }

    const artifact = (type: string, filePath: string): void => {
      const data = readFileSync(filePath);
      db.prepare(
        `INSERT OR REPLACE INTO artifacts
           (resume_draft_id, resume_version_id, artifact_type, path, sha256, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        canonicalVersion.draft_id,
        canonicalVersion.id,
        type,
        filePath,
        createHash('sha256').update(data).digest('hex'),
        data.byteLength,
      );
    };

    db.transaction(() => {
      throwIfAborted(signal);
      db.prepare('UPDATE resume_versions SET tex_path = ?, pdf_path = ? WHERE id = ?')
        .run(texPath, pdfPath, canonicalVersion.id);
      if (canonicalVersion.draft_id !== null) {
        db.prepare("UPDATE resume_drafts SET status = 'rendered', updated_at = datetime('now') WHERE id = ?")
          .run(canonicalVersion.draft_id);
      }
      artifact('tex', texPath);
      artifact('pdf', pdfPath);
    })();

    // Note: status change to 'composed' is handled by compose.ts.
    // When render is called standalone, we leave status as-is.
    db.prepare(
      "UPDATE jobs SET updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    ).run(jobId, resolvedUserId);

    logger.info(`PDF rendered: ${pdfPath}`);
    return { success: true, jobId, pdfPath, texPath, latexFixed };
  } catch (err) {
    rethrowAbort(err, signal);
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, jobId, texPath, error: `pdflatex failed: ${msg}` };
  }
}
