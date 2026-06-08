import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getDb } from '../db/client.js';
import { PROJECT_ROOT, RESUMES_DIR, CANDIDATE_PATH } from '../utils/paths.js';
import { getDeepseekKey } from '../utils/config.js';
import { readYamlFile } from '../utils/yaml.js';
import { logAiCall, extractUsage } from '../utils/ai-logger.js';
import { logger } from '../utils/logger.js';

const COVER_LETTER_PROMPT = readFileSync(`${PROJECT_ROOT}/prompts/cover-letter.md`, 'utf-8');
const CL_TEMPLATE = readFileSync(`${PROJECT_ROOT}/resumes/cover-letter.tex`, 'utf-8');

interface CandidateProfile {
  name: { first: string; last: string };
  email: string;
  phone: string;
  location: { city: string; state: string };
  links: { github?: string; linkedin?: string };
}

export interface CoverLetterResult {
  success: boolean;
  jobId: number;
  pdfPath?: string;
  body?: string;
  error?: string;
}

/** Escape LaTeX special chars. */
function latexEscape(s: string): string {
  if (!s) return '';
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/[{}]/g, (m) => m === '{' ? '\\{' : '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/**
 * Generate a cover letter via DeepSeek LLM and render to PDF.
 */
export async function generateCoverLetter(jobId: number): Promise<CoverLetterResult> {
  const db = getDb();
  const job = db.prepare(
    'SELECT id, title, company, location, description FROM jobs WHERE id = ?',
  ).get(jobId) as {
    id: number; title: string | null; company: string | null;
    location: string | null; description: string | null;
  } | undefined;

  if (!job) return { success: false, jobId, error: `Job not found: id=${jobId}` };
  if (!job.description) return { success: false, jobId, error: 'No job description. Extract first.' };

  const apiKey = getDeepseekKey();
  if (!apiKey) return { success: false, jobId, error: 'DeepSeek API key not set.' };

  // Read candidate profile
  let candidate: CandidateProfile;
  try { candidate = readYamlFile<CandidateProfile>(CANDIDATE_PATH); }
  catch { return { success: false, jobId, error: 'Candidate profile not found.' }; }

  // Check for tailored resume to include as context
  let tailoredYaml = '';
  const tailoredPath = `${RESUMES_DIR}/${jobId}-tailored.yaml`;
  if (existsSync(tailoredPath)) {
    tailoredYaml = readFileSync(tailoredPath, 'utf-8');
  }

  const fullName = `${candidate.name.first} ${candidate.name.last}`;

  logger.info(`Generating cover letter for job #${jobId}: "${job.title}" at ${job.company}...`);

  // ---- LLM generation ----
  const userMsg = [
    `## Job Posting`,
    `Title: ${job.title || 'Unknown'}`,
    `Company: ${job.company || 'Unknown'}`,
    `Location: ${job.location || 'Unknown'}`,
    '',
    `Description:`,
    (job.description || '').slice(0, 8000),
    '',
    `## Candidate`,
    `Name: ${fullName}`,
    `Location: ${candidate.location.city}, ${candidate.location.state}`,
    tailoredYaml ? `\n## Tailored Resume\n\`\`\`yaml\n${tailoredYaml}\n\`\`\`` : '',
    '',
    'Write a cover letter. Return ONLY valid JSON:',
    '{"greeting": "Dear Hiring Manager,", "body": "Paragraphs here...", "closing": "Sincerely,\\\\n' + fullName + '"}',
  ].join('\n');

  const startMs = Date.now();
  let clData: { greeting: string; body: string; closing: string };

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: COVER_LETTER_PROMPT },
          { role: 'user', content: userMsg },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const b = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${b.slice(0, 200)}`);
    }

    const data = (await response.json()) as { choices: [{ message: { content: string } }]; usage?: Record<string, number> };
    const content = data.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response');
    clData = JSON.parse(content);
    const usage = extractUsage(data as Record<string, unknown>);

    logAiCall({
      operation: 'cover-letter',
      model: 'deepseek-chat',
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      requestSummary: `Cover letter for job #${jobId} "${job.title}" at ${job.company}`,
      responseSummary: `Body: ${clData.body.length} chars`,
      ...usage,
      durationMs: Date.now() - startMs,
      success: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAiCall({ operation: 'cover-letter', model: 'deepseek-chat', provider: 'deepseek', endpoint: 'https://api.deepseek.com/v1/chat/completions', requestSummary: `Cover letter for job #${jobId}`, responseSummary: msg, durationMs: Date.now() - startMs, success: false, error: msg });
    return { success: false, jobId, error: msg };
  }

  // ---- Render to PDF ----
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const githubUsername = candidate.links.github?.split('/').pop() ?? '';
  const linkedinUsername = candidate.links.linkedin?.split('/').pop() ?? '';

  let tex = CL_TEMPLATE;
  tex = tex.replace(/\{\{name\}\}/g, latexEscape(fullName));
  tex = tex.replace(/\{\{email\}\}/g, candidate.email);
  tex = tex.replace(/\{\{phone\}\}/g, candidate.phone);
  tex = tex.replace(/\{\{date\}\}/g, today);
  tex = tex.replace(/\{\{greeting\}\}/g, latexEscape(clData.greeting));
  tex = tex.replace(/\{\{body\}\}/g, latexEscape(clData.body));
  tex = tex.replace(/\{\{closing\}\}/g, latexEscape(clData.closing));
  tex = tex.replace(/\{\{company\}\}/g, latexEscape(job.company || ''));

  // Handle conditionals
  tex = tex.replace(/\{\{#phone\}\}([\s\S]*?)\{\{\/phone\}\}/g, candidate.phone ? '$1' : '');
  tex = tex.replace(/\{\{#email\}\}([\s\S]*?)\{\{\/email\}\}/g, candidate.email ? '$1' : '');
  if (linkedinUsername) {
    tex = tex.replace(/\{\{#linkedin\}\}([\s\S]*?)\{\{linkedin\}\}([\s\S]*?)\{\{\/linkedin\}\}/g, '$1' + linkedinUsername + '$2');
  } else {
    tex = tex.replace(/\{\{#linkedin\}\}[\s\S]*?\{\{\/linkedin\}\}/g, '');
  }
  if (githubUsername) {
    tex = tex.replace(/\{\{#github\}\}([\s\S]*?)\{\{github\}\}([\s\S]*?)\{\{\/github\}\}/g, '$1' + githubUsername + '$2');
  } else {
    tex = tex.replace(/\{\{#github\}\}[\s\S]*?\{\{\/github\}\}/g, '');
  }
  tex = tex.replace(/\{\{#company_address\}\}[\s\S]*?\{\{\/company_address\}\}/g, '');

  // Clean remaining placeholders
  tex = tex.replace(/\{\{[#/]?\w+\}\}/g, '');

  // Write and compile
  mkdirSync(RESUMES_DIR, { recursive: true });
  const texPath = `${RESUMES_DIR}/${jobId}-cover-letter.tex`;
  writeFileSync(texPath, tex, 'utf-8');

  try {
    execSync(`pdflatex -interaction=nonstopmode -output-directory="${RESUMES_DIR}" "${texPath}"`, { timeout: 30_000, stdio: 'pipe' });
    execSync(`pdflatex -interaction=nonstopmode -output-directory="${RESUMES_DIR}" "${texPath}"`, { timeout: 30_000, stdio: 'pipe' });

    const pdfPath = `${RESUMES_DIR}/${jobId}-cover-letter.pdf`;
    if (!existsSync(pdfPath)) {
      return { success: false, jobId, error: 'pdflatex completed but no PDF produced.' };
    }

    // Log event
    db.prepare("INSERT INTO events (job_id, event_type, description, created_at) VALUES (?, 'cover_letter', ?, datetime('now'))")
      .run(jobId, `Cover letter PDF: ${pdfPath}`);

    logger.info(`Cover letter PDF: ${pdfPath}`);
    return { success: true, jobId, pdfPath, body: clData.body };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, jobId, error: `pdflatex failed: ${msg}` };
  }
}
