import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getDb } from '../db/client.js';
import { PROJECT_ROOT, RESUMES_DIR, CANDIDATE_PATH } from '../utils/paths.js';
import { readYamlFile } from '../utils/yaml.js';
import { logger } from '../utils/logger.js';

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

interface TailoredData {
  summary: string;
  selected_experience: {
    company: string;
    title: string;
    start: string;
    end: string | null;
    highlights: string[];
  }[];
  selected_skills: {
    languages?: string[];
    frameworks?: string[];
    infrastructure?: string[];
    databases?: string[];
  };
  keyword_adjustments?: {
    original: string;
    adjusted: string;
    reason: string;
  }[];
}

/**
 * Render a tailored resume to PDF using LaTeX.
 *
 * Steps:
 * 1. Read the tailored YAML from local/resumes/
 * 2. Read the candidate profile
 * 3. Read the LaTeX template
 * 4. Inject data into the template
 * 5. Compile with pdflatex
 */
export async function renderJob(jobId: number): Promise<RenderResult> {
  const db = getDb();
  const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(jobId) as
    | { id: number }
    | undefined;

  if (!job) {
    return { success: false, jobId, error: `Job not found: id=${jobId}` };
  }

  // Check if tailored data exists
  const tailoredYamlPath = `${RESUMES_DIR}/${jobId}-tailored.yaml`;
  if (!existsSync(tailoredYamlPath)) {
    return {
      success: false,
      jobId,
      error: 'No tailored resume data found. Run "pnpm jobbot tailor --job" first.',
    };
  }

  let tailored: TailoredData;
  try {
    tailored = readYamlFile<TailoredData>(tailoredYamlPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, jobId, error: `Failed to read tailored YAML: ${msg}` };
  }

  // Read candidate profile
  let candidate: CandidateProfile;
  try {
    candidate = readYamlFile<CandidateProfile>(CANDIDATE_PATH);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, jobId, error: `Failed to read candidate profile: ${msg}` };
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
    if (!end) return `${s} -- Present`;
    return `${s} -- ${formatDate(end)}`;
  }

  // Inject the data into the template
  let tex = template;

  // Simple replacements
  tex = tex.replace(/\{\{name\}\}/g, fullName);
  tex = tex.replace(/\{\{email\}\}/g, candidate.email);
  tex = tex.replace(/\{\{phone\}\}/g, candidate.phone);
  tex = tex.replace(/\{\{location\}\}/g, locationStr);

  // ---- Build experience section ----
  const experienceItems = tailored.selected_experience;
  const expSectionMatch = tex.match(/\{\{#experience\}\}([\s\S]*?)\{\{\/experience\}\}/);
  if (expSectionMatch && experienceItems.length > 0) {
    const itemTemplate = expSectionMatch[1]!;
    const expContent = experienceItems.map((exp) => {
      let item = itemTemplate;
      item = item.replace(/\{\{company\}\}/g, latexEscape(exp.company));
      item = item.replace(/\{\{title\}\}/g, latexEscape(exp.title));
      item = item.replace(/\{\{date_range\}\}/g, latexEscape(formatDateRange(exp.start, exp.end)));

      // Build highlights
      const hlMatch = item.match(/\{\{#highlights\}\}([\s\S]*?)\{\{\/highlights\}\}/);
      if (hlMatch) {
        const hlTemplate = hlMatch[1]!;
        const hlContent = exp.highlights.map((h) => hlTemplate.replace(/\{\{\.\}\}/g, latexEscape(h))).join('\n');
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
      item = item.replace(/\{\{school\}\}/g, latexEscape(edu.school));
      item = item.replace(/\{\{degree\}\}/g, latexEscape(edu.degree));
      item = item.replace(/\{\{date_range\}\}/g, latexEscape(formatDateRange(edu.start, edu.end)));
      item = item.replace(/\{\{location\}\}/g, latexEscape(edu.location || ''));

      // Handle notes conditional
      const notesMatch = item.match(/\{\{#notes\}\}([\s\S]*?)\{\{\/notes\}\}/);
      if (notesMatch) {
        if (edu.notes) {
          item = item.replace(notesMatch[0], notesMatch[1]!.replace(/\{\{notes\}\}/g, latexEscape(edu.notes!)));
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

    if (skillsList.length > 0) {
      const skillsContent = skillsList.map((s) => {
        let item = itemTemplate;
        item = item.replace(/\{\{category\}\}/g, latexEscape(s.category));
        item = item.replace(/\{\{skills_list\}\}/g, latexEscape(s.skills_list));
        item = item.replace(/\{\{[#/]?\w+\}\}/g, '');
        return item;
      }).join('\n');
      tex = tex.replace(skillsSectionMatch[0], skillsContent);
    } else {
      tex = tex.replace(skillsSectionMatch[0], '');
    }
  }

  // ---- Build projects section (optional) ----
  const projSectionMatch = tex.match(/\{\{#projects\}\}([\s\S]*?)\{\{\/projects\}\}/);
  if (projSectionMatch) {
    if (candidate.projects && candidate.projects.length > 0) {
      const itemTemplate = projSectionMatch[1]!;
      const projContent = candidate.projects.map((proj) => {
        let item = itemTemplate;
        item = item.replace(/\{\{name\}\}/g, latexEscape(proj.name));
        item = item.replace(/\{\{technologies\}\}/g, latexEscape(proj.technologies.join(', ')));
        const hlMatch = item.match(/\{\{#highlights\}\}([\s\S]*?)\{\{\/highlights\}\}/);
        if (hlMatch) {
          const hlTemplate = hlMatch[1]!;
          const hlContent = proj.highlights.map((h) => hlTemplate.replace(/\{\{\.\}\}/g, latexEscape(h))).join('\n');
          item = item.replace(hlMatch[0], hlContent);
        }
        item = item.replace(/\{\{[#/]?\w+\}\}/g, '');
        return item;
      }).join('\n');
      tex = tex.replace(projSectionMatch[0], projContent);
    } else {
      tex = tex.replace(projSectionMatch[0], '');
    }
  }

  // ---- Handle summary/objective ----
  const objSectionMatch = tex.match(/\{\{#objective\}\}([\s\S]*?)\{\{\/objective\}\}/);
  if (objSectionMatch) {
    if (tailored.summary) {
      tex = tex.replace(objSectionMatch[0], objSectionMatch[1]!.replace(/\{\{objective\}\}/g, latexEscape(tailored.summary)));
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
      tex = tex.replace(linkedinCondMatch[0], linkedinCondMatch[1]!.replace(/\{\{linkedin\}\}/g, linkedinUsername));
    } else {
      tex = tex.replace(linkedinCondMatch[0], '');
    }
  }

  // Github conditional
  const githubCondMatch = tex.match(/\{\{#github\}\}([\s\S]*?)\{\{\/github\}\}/);
  if (githubCondMatch) {
    if (githubUsername) {
      tex = tex.replace(githubCondMatch[0], githubCondMatch[1]!.replace(/\{\{github\}\}/g, githubUsername));
    } else {
      tex = tex.replace(githubCondMatch[0], '');
    }
  }

  // Clean up any remaining mustache placeholders and escaped braces
  tex = tex.replace(/\{\{[#/]?\w+\}\}/g, '');
  tex = tex.replace(/\{\{(\w+)\}\}/g, '');

  // ---- Write .tex file ----
  mkdirSync(RESUMES_DIR, { recursive: true });
  const texPath = `${RESUMES_DIR}/${jobId}-resume.tex`;
  writeFileSync(texPath, tex, 'utf-8');
  logger.info(`Wrote LaTeX: ${texPath}`);

  // ---- Compile with pdflatex ----
  try {
    // Run pdflatex twice for proper layout (TOC, cross-refs etc.)
    const outputDir = RESUMES_DIR;
    execSync(`pdflatex -interaction=nonstopmode -output-directory="${outputDir}" "${texPath}"`, {
      timeout: 30_000,
      stdio: 'pipe',
    });
    execSync(`pdflatex -interaction=nonstopmode -output-directory="${outputDir}" "${texPath}"`, {
      timeout: 30_000,
      stdio: 'pipe',
    });

    const pdfPath = `${RESUMES_DIR}/${jobId}-resume.pdf`;
    if (!existsSync(pdfPath)) {
      return { success: false, jobId, texPath, error: 'pdflatex completed but PDF was not produced. Check LaTeX log for errors.' };
    }

    // Update resume_versions with the PDF path
    // Update the most recent resume_version for this job
    db.prepare(
      "UPDATE resume_versions SET pdf_path = ?, created_at = datetime('now') WHERE job_id = ? AND id = (SELECT MAX(id) FROM resume_versions WHERE job_id = ?)",
    ).run(pdfPath, jobId, jobId);

    // Note: status change to 'composed' is handled by compose.ts.
    // When render is called standalone, we leave status as-is.
    db.prepare(
      "UPDATE jobs SET updated_at = datetime('now') WHERE id = ?",
    ).run(jobId);

    logger.info(`PDF rendered: ${pdfPath}`);
    return { success: true, jobId, pdfPath, texPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, jobId, texPath, error: `pdflatex failed: ${msg}` };
  }
}
