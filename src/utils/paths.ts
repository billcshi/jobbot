import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the project root (jobbot/). */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * All personal data lives under `local/` — a directory that is gitignored
 * and NEVER committed to the public repository.
 *
 * The repo ships `local.example/` as a template. On first run, copy
 * `local.example/` → `local/` and fill in your real data there.
 */
export const LOCAL_DIR = path.join(PROJECT_ROOT, 'local');

export const DATA_DIR = path.join(LOCAL_DIR, 'data');
export const PROFILE_DIR = path.join(LOCAL_DIR, 'profile');
export const RESUMES_DIR = path.join(LOCAL_DIR, 'resumes');
export const BROWSER_DIR = path.join(LOCAL_DIR, 'browser-data');

export const DB_PATH = path.join(DATA_DIR, 'jobbot.sqlite');

export const CANDIDATE_PATH = path.join(PROFILE_DIR, 'candidate.yaml');
export const PREFERENCES_PATH = path.join(PROFILE_DIR, 'preferences.yaml');
export const ANSWERS_PATH = path.join(PROFILE_DIR, 'answers.yaml');

/** Template directory shipped in the public repo. Copy to local/ on first setup. */
export const LOCAL_EXAMPLE_DIR = path.join(PROJECT_ROOT, 'local.example');
