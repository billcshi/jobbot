import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getDb } from '../db/client.js';
import { PROJECT_ROOT, jobResumeDir } from '../utils/paths.js';
import { readCandidate } from '../utils/profile-store.js';
import { getActiveUserId } from '../utils/user-context.js';
import { getDeepseekKey, getDeepseekModel, getDeepseekThinking } from '../utils/config.js';
import { parseLLMJson } from '../utils/parse-llm-json.js';
import { parseYaml } from '../utils/yaml.js';
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

export type CoverLetterTone = 'professional' | 'enthusiastic' | 'concise';

export interface CoverLetterResult {
  success: boolean;
  jobId: number;
  pdfPath?: string;
  body?: string;
  error?: string;
}

const TONE_INSTRUCTIONS: Record<CoverLetterTone, string> = {
  professional: 'Write a polished, professional cover letter. Standard business tone. Balance confidence with humility.',
  enthusiastic: 'Write an enthusiastic, energetic cover letter. Show genuine excitement about the role and company. Use a warm, engaging tone while remaining professional.',
  concise: 'Write a concise, direct cover letter. Keep paragraphs short. Get straight to the point — no filler. Maximum 3 short paragraphs.',
};

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
/**
 * @param version Optional compose version number. When provided, the full LLM
 *   prompt is written to <jobResumeDir>/cover-letter-prompt-v<version>.txt for debugging.
 */
export async function generateCoverLetter(jobId: number, tone: CoverLetterTone = 'professional', version?: number): Promise<CoverLetterResult> {
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
  try { candidate = parseYaml<CandidateProfile>(readCandidate(getActiveUserId())); }
  catch { return { success: false, jobId, error: 'Candidate profile not found.' }; }

  // Check for tailored resume to include as context
  let tailoredYaml = '';
  const tailoredPath = `${jobResumeDir(jobId)}/tailored.yaml`;
  if (existsSync(tailoredPath)) {
    tailoredYaml = readFileSync(tailoredPath, 'utf-8');
  }

  const fullName = `${candidate.name.first} ${candidate.name.last}`;

  logger.info(`Generating cover letter for job #${jobId}: "${job.title}" at ${job.company}...`);

  // ---- LLM generation ----
  const toneInstruction = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.professional;

  const userMsg = [
    `Today's date: ${new Date().toISOString().split('T')[0]}`,
    '',
    `## Tone: ${tone}`,
    toneInstruction,
    '',
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
    '{"greeting": "Dear Hiring Manager,", "body": "Paragraphs here...", "closing": "Sincerely,"}',
  ].join('\n');

  const startMs = Date.now();
  let clData: { greeting: string; body: string; closing: string };

  // Log prompt for debugging when version is provided
  if (version !== undefined) {
    const dir = jobResumeDir(jobId);
    mkdirSync(dir, { recursive: true });
    const promptDump = [
      '=== SYSTEM PROMPT ===',
      COVER_LETTER_PROMPT,
      '',
      '=== USER MESSAGE ===',
      userMsg,
    ].join('\n');
    writeFileSync(`${dir}/cover-letter-prompt-v${version}.txt`, promptDump, 'utf-8');
    console.log(`  📝 Wrote cover letter prompt: ${dir}/cover-letter-prompt-v${version}.txt`);
  }

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: getDeepseekModel(),
        messages: [
          { role: 'system', content: COVER_LETTER_PROMPT },
          { role: 'user', content: userMsg },
        ],
        max_tokens: 16384,
        ...(getDeepseekThinking('cover-letter') ? { thinking: getDeepseekThinking('cover-letter') } : {}),
      }),
    });

    if (!response.ok) {
      const b = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${b.slice(0, 200)}`);
    }

    const data = (await response.json()) as { choices: [{ message: { content: string } }]; usage?: Record<string, number> };
    const content = data.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response');
    clData = parseLLMJson(content, `cover-letter job #${jobId}`) as { greeting: string; body: string; closing: string };
    const usage = extractUsage(data as Record<string, unknown>);

    logAiCall({
      operation: 'cover-letter',
      model: getDeepseekModel(),
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
    logAiCall({ operation: 'cover-letter', model: getDeepseekModel(), provider: 'deepseek', endpoint: 'https://api.deepseek.com/v1/chat/completions', requestSummary: `Cover letter for job #${jobId}`, responseSummary: msg, durationMs: Date.now() - startMs, success: false, error: msg });
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
  // Convert paragraph breaks: the LLM may return literal \n\n or actual newlines.
  // Handle these before LaTeX escaping to avoid \textbackslash{}n artifacts.
  let body = clData.body
    .replace(/\\n\s*\\n/g, '\x00PARA\x00')
    .replace(/\n\s*\n/g, '\x00PARA\x00');
  body = latexEscape(body);
  body = body.replace(/\x00PARA\x00/g, '\\\\[\\baselineskip]');
  tex = tex.replace(/\{\{body\}\}/g, body);
  // Strip candidate name from closing — {{name}} renders it below the signature space
  let closing = clData.closing;
  closing = closing.replace(new RegExp('\\\\n?' + fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'), '');
  tex = tex.replace(/\{\{closing\}\}/g, latexEscape(closing));
  tex = tex.replace(/\{\{company\}\}/g, latexEscape(job.company || ''));

  // Handle conditionals
  tex = tex.replace(/\{\{#phone\}\}([\s\S]*?)\{\{\/phone\}\}/g, candidate.phone ? '$1' : '');
  tex = tex.replace(/\{\{#email\}\}([\s\S]*?)\{\{\/email\}\}/g, candidate.email ? '$1' : '');
  if (linkedinUsername) {
    tex = tex.replace(/\{\{#linkedin\}\}([\s\S]*?)\{\{\/linkedin\}\}/g, (_m, inner) => inner.replace(/\{\{linkedin\}\}/g, linkedinUsername));
  } else {
    tex = tex.replace(/\{\{#linkedin\}\}[\s\S]*?\{\{\/linkedin\}\}/g, '');
  }
  if (githubUsername) {
    tex = tex.replace(/\{\{#github\}\}([\s\S]*?)\{\{\/github\}\}/g, (_m, inner) => inner.replace(/\{\{github\}\}/g, githubUsername));
  } else {
    tex = tex.replace(/\{\{#github\}\}[\s\S]*?\{\{\/github\}\}/g, '');
  }
  tex = tex.replace(/\{\{#company_address\}\}[\s\S]*?\{\{\/company_address\}\}/g, '');

  // Clean remaining placeholders
  tex = tex.replace(/\{\{[#/]?\w+\}\}/g, '');

  // Write and compile
  const dir = jobResumeDir(jobId);
  const texPath = `${dir}/cover-letter.tex`;
  writeFileSync(texPath, tex, 'utf-8');

  try {
    execSync(`pdflatex -interaction=nonstopmode -output-directory="${dir}" "${texPath}"`, { timeout: 30_000, stdio: 'pipe' });
    execSync(`pdflatex -interaction=nonstopmode -output-directory="${dir}" "${texPath}"`, { timeout: 30_000, stdio: 'pipe' });

    const pdfPath = `${dir}/cover-letter.pdf`;
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
