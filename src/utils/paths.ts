import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the project root (jobbot/). */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * All personal data lives under `local/` — a directory that is gitignored
 * and NEVER committed to the public repository.
 */
export const LOCAL_DIR = path.join(PROJECT_ROOT, 'local');

export const DATA_DIR = path.join(LOCAL_DIR, 'data');
export const PROFILE_DIR = path.join(LOCAL_DIR, 'profile');
export const RESUMES_DIR = path.join(LOCAL_DIR, 'resumes');

export const DB_PATH = path.join(DATA_DIR, 'jobbot.sqlite');

/** Per-job resume output directory: local/resumes/<jobId>/ */
export function jobResumeDir(jobId: number): string {
  const dir = path.join(RESUMES_DIR, String(jobId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Prompt templates shipped in the public repo. */
export const PROMPTS_DIR = path.join(PROJECT_ROOT, 'prompts');

/** Template directory shipped in the public repo. Copy to local/ on first setup. */
export const LOCAL_EXAMPLE_DIR = path.join(PROJECT_ROOT, 'local.example');
