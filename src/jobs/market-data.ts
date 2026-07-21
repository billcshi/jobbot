/**
 * Job Market Intelligence
 *
 * Populates the `job_market_data` table with insights learned from real job
 * descriptions over time. Called after each successful extraction/scoring.
 *
 * Data collected:
 *   - salary_range.{title}.{location}  → "$110k–$160k"
 *   - common_req.{skill}               → "0.68" (frequency)
 *   - title_freq.{title}               → "0.12" (frequency)
 *
 * The table is designed for self-evolving data: confidence and sample_size
 * increase as more observations are added.
 */

import { getDb } from '../db/client.js';
import { readCandidate } from '../utils/profile-store.js';
import { getActiveUserId } from '../utils/user-context.js';
import { logger } from '../utils/logger.js';
import * as yaml from 'js-yaml';

// ----- salary extraction ------------------------------------------------------

export interface SalaryRange {
  low: number;
  high: number;
  raw: string;
}

/**
 * Regex patterns for salary extraction.
 * Matches common formats: "$120k–$180k", "$120,000 - $180,000", "$120k-$180k USD"
 */
const SALARY_PATTERNS = [
  /\$(?<low>\d{2,3})\s*k\s*[–\-to]+\s*\$?(?<high>\d{2,3})\s*k/gi,
  /\$(?<low>[\d,]+)\s*[–\-to]+\s*\$?(?<high>[\d,]+)/gi,
  /salary[:\s]+\$?(?<low>[\d,]+)\s*[–\-to]+\s*\$?(?<high>[\d,]+)/gi,
  /compensation[:\s]+\$?(?<low>[\d,]+)\s*[–\-to]+\s*\$?(?<high>[\d,]+)/gi,
];

function parseSalaryAmount(s: string): number {
  const cleaned = s.replace(/[,]/g, '');
  const num = parseFloat(cleaned);
  // If it's 2-3 digits, treat as thousands (e.g., "120" → 120000)
  if (num >= 10 && num < 1000) return num * 1000;
  return num;
}

export function extractSalaryRanges(description: string): SalaryRange[] {
  const ranges: SalaryRange[] = [];
  const seen = new Set<string>();

  for (const pattern of SALARY_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(description)) !== null) {
      const groups = match.groups as { low: string; high: string } | undefined;
      if (!groups?.low || !groups?.high) continue;

      const low = parseSalaryAmount(groups.low);
      const high = parseSalaryAmount(groups.high);

      // Sanity check: reasonable salary ranges
      if (low < 20000 || high < 20000) continue;
      if (low > 1000000 || high > 1000000) continue;
      if (low > high) continue;

      const key = `${low}-${high}`;
      if (!seen.has(key)) {
        seen.add(key);
        ranges.push({ low, high, raw: match[0] });
      }
    }
  }

  return ranges;
}

// ----- skill frequency --------------------------------------------------------

/**
 * Known skill keywords to track. Can be extended from candidate profile.
 */
const DEFAULT_SKILLS = [
  // Languages
  'TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java', 'C++', 'Ruby',
  'Kotlin', 'Swift', 'Scala', 'PHP', 'C#',
  // Frontend
  'React', 'Vue', 'Angular', 'Svelte', 'Next.js', 'Remix', 'Tailwind',
  // Backend
  'Node.js', 'Express', 'Fastify', 'Django', 'Flask', 'FastAPI', 'Rails',
  'Spring', 'GraphQL', 'REST', 'gRPC',
  // Infrastructure
  'AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'Terraform', 'Pulumi',
  'CI/CD', 'GitHub Actions', 'Jenkins',
  // Databases
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch', 'DynamoDB',
  'SQLite', 'Cassandra',
  // AI/ML
  'Machine Learning', 'AI', 'LLM', 'NLP', 'PyTorch', 'TensorFlow',
  'Deep Learning', 'MLOps',
];

function getSkillList(userId = getActiveUserId()): string[] {
  // Try to load skills from candidate profile
  const yamlStr = readCandidate(userId);
  if (yamlStr) {
    try {
      const profile = yaml.load(yamlStr) as Record<string, unknown> | undefined;
      const profileSkills = profile?.skills as Record<string, string[]> | undefined;
      if (profileSkills) {
        const all: string[] = [];
        for (const vals of Object.values(profileSkills)) {
          if (Array.isArray(vals)) all.push(...vals.map(String));
        }
        if (all.length > 0) return [...new Set(all)];
      }
    } catch { /* fall back to defaults */ }
  }
  return DEFAULT_SKILLS;
}

function countSkillOccurrences(description: string | null, skills: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!description) return counts;

  const text = description.toLowerCase();

  for (const skill of skills) {
    const skillLower = skill.toLowerCase();
    // Count occurrences (word-boundary aware for acronyms)
    const regex = new RegExp(skillLower.replace(/[.+]/g, '\\$&'), 'gi');
    const matches = text.match(regex);
    if (matches && matches.length > 0) {
      counts[skill] = matches.length;
    }
  }

  return counts;
}

// ----- title normalization ----------------------------------------------------

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^(senior|sr|staff|principal|lead|junior|jr|associate)_/i, '')
    .replace(/_?(engineer|developer|architect|manager|analyst|scientist)$/, '')
    .trim()
    .slice(0, 60);
}

// ----- LLM-extracted data writer --------------------------------------------

/**
 * Write salary extracted by the LLM during job extraction.
 * Called from extract.ts immediately after a successful LLM extraction.
 * Higher confidence than regex because LLM understands context.
 */
export function writeLLMSalary(
  jobId: number,
  salary: { low: number | null; high: number | null; currency?: string },
  title: string,
  location: string | null,
): void {
  const db = getDb();
  const loc = (location || 'unknown').toLowerCase().replace(/\s+/g, '_').slice(0, 40);
  const titleNorm = normalizeTitle(title);
  const key = `salary_range.${titleNorm}.${loc}`;

  const lowStr = salary.low != null ? `$${Math.round(salary.low / 1000)}k` : '?';
  const highStr = salary.high != null ? `$${Math.round(salary.high / 1000)}k` : '?';
  const value = `${lowStr}–${highStr}`;

  const existing = db.prepare('SELECT id, sample_size FROM job_market_data WHERE key = ?').get(key) as
    | { id: number; sample_size: number }
    | undefined;

  if (existing) {
    const newSampleSize = existing.sample_size + 1;
    db.prepare(
      `UPDATE job_market_data SET value = ?, sample_size = ?, confidence = MIN(1.0, ?),
       source = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(value, newSampleSize, 0.7 + newSampleSize * 0.1, `job_${jobId}`, existing.id);
  } else {
    db.prepare(
      `INSERT INTO job_market_data (key, value, source, confidence, sample_size, updated_at)
       VALUES (?, ?, ?, 0.8, 1, datetime('now'))`,
    ).run(key, value, `job_${jobId}`);
  }
}

/**
 * Write skills extracted by the LLM during job extraction.
 * Each skill is upserted as a common_req entry.
 */
export function writeLLMSkills(jobId: number, skills: string[]): void {
  if (skills.length === 0) return;
  const db = getDb();

  for (const skill of skills) {
    const key = `common_req.${skill.toLowerCase().replace(/\s+/g, '_').slice(0, 60)}`;

    const existing = db.prepare('SELECT id, sample_size FROM job_market_data WHERE key = ?').get(key) as
      | { id: number; sample_size: number }
      | undefined;

    if (existing) {
      const newSampleSize = existing.sample_size + 1;
      const totalJobs = (db.prepare('SELECT COUNT(*) as count FROM jobs WHERE description IS NOT NULL').get() as { count: number }).count;
      const frequency = newSampleSize / Math.max(totalJobs, 1);
      db.prepare(
        `UPDATE job_market_data SET value = ?, sample_size = ?, confidence = ?,
         source = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(frequency.toFixed(4), newSampleSize, 0.7 + frequency * 0.3, `job_${jobId}`, existing.id);
    } else {
      db.prepare(
        `INSERT INTO job_market_data (key, value, source, confidence, sample_size, updated_at)
         VALUES (?, '1', ?, 0.7, 1, datetime('now'))`,
      ).run(key, `job_${jobId}`);
    }
  }
}

// ----- main extraction --------------------------------------------------------

interface MarketDataResult {
  salaries: number;
  skills: number;
  titles: number;
}

/**
 * Extract market data from a single job via regex. Call after scoring.
 *
 * This is the fallback when extraction did not produce salary or skill data.
 * When the LLM already extracted salary and skills, this function
 * skips those steps and only updates title frequency.
 *
 * Up-serts into job_market_data, increasing sample_size and confidence
 * with each observation.
 */
export function extractMarketData(job: {
  id: number;
  title: string | null;
  location: string | null;
  description: string | null;
}, userId = getActiveUserId()): MarketDataResult {
  const db = getDb();
  let salaries = 0;
  let skills = 0;
  let titles = 0;

  // Check if LLM already extracted data for this job
  const hasLLMData = db.prepare(
    "SELECT COUNT(*) as count FROM job_market_data WHERE source = ? LIMIT 1",
  ).get(`job_${job.id}`) as { count: number };

  // 1. Salary ranges — only if LLM didn't already extract
  if (job.description && job.title && hasLLMData.count === 0) {
    const ranges = extractSalaryRanges(job.description);
    const loc = (job.location || 'unknown').toLowerCase().replace(/\s+/g, '_').slice(0, 40);
    const titleNorm = normalizeTitle(job.title);

    for (const range of ranges) {
      const key = `salary_range.${titleNorm}.${loc}`;
      const value = `$${Math.round(range.low / 1000)}k–$${Math.round(range.high / 1000)}k`;

      const existing = db.prepare('SELECT id, sample_size FROM job_market_data WHERE key = ?').get(key) as
        | { id: number; sample_size: number }
        | undefined;

      if (existing) {
        const newSampleSize = existing.sample_size + 1;
        db.prepare(
          `UPDATE job_market_data SET value = ?, sample_size = ?, confidence = MIN(1.0, ?),
           updated_at = datetime('now') WHERE id = ?`,
        ).run(value, newSampleSize, newSampleSize / 10, existing.id);
      } else {
        db.prepare(
          `INSERT INTO job_market_data (key, value, source, confidence, sample_size, updated_at)
           VALUES (?, ?, ?, 0.1, 1, datetime('now'))`,
        ).run(key, value, `job_${job.id}`);
      }
      salaries++;
    }
  }

  // 2. Common requirements (skill frequency) — only if LLM didn't already extract
  if (hasLLMData.count === 0) {
  const skillList = getSkillList(userId);
    const skillCounts = countSkillOccurrences(job.description, skillList);

    for (const [skill, count] of Object.entries(skillCounts)) {
      if (count === 0) continue;
      const key = `common_req.${skill.toLowerCase().replace(/\s+/g, '_')}`;

      const existing = db.prepare('SELECT id, sample_size FROM job_market_data WHERE key = ?').get(key) as
        | { id: number; sample_size: number }
        | undefined;

      if (existing) {
        const newSampleSize = existing.sample_size + 1;
        const totalJobs = (db.prepare('SELECT COUNT(*) as count FROM jobs WHERE description IS NOT NULL').get() as { count: number }).count;
        const frequency = newSampleSize / Math.max(totalJobs, 1);
        db.prepare(
          `UPDATE job_market_data SET value = ?, sample_size = ?, confidence = ?,
           updated_at = datetime('now') WHERE id = ?`,
        ).run(frequency.toFixed(4), newSampleSize, frequency.toFixed(4), existing.id);
      } else {
        db.prepare(
          `INSERT INTO job_market_data (key, value, source, confidence, sample_size, updated_at)
           VALUES (?, '1', ?, 0.1, 1, datetime('now'))`,
        ).run(key, `job_${job.id}`);
      }
      skills++;
    }
  }

  // 3. Title frequency
  if (job.title) {
    const titleNorm = normalizeTitle(job.title);
    const key = `title_freq.${titleNorm}`;

    const existing = db.prepare('SELECT id, sample_size FROM job_market_data WHERE key = ?').get(key) as
      | { id: number; sample_size: number }
      | undefined;

    if (existing) {
      const newSampleSize = existing.sample_size + 1;
      const totalJobs = (db.prepare('SELECT COUNT(*) as count FROM jobs WHERE title IS NOT NULL').get() as { count: number }).count;
      const frequency = newSampleSize / Math.max(totalJobs, 1);
      db.prepare(
        `UPDATE job_market_data SET value = ?, sample_size = ?, confidence = ?,
         updated_at = datetime('now') WHERE id = ?`,
      ).run(frequency.toFixed(4), newSampleSize, frequency.toFixed(4), existing.id);
    } else {
      db.prepare(
        `INSERT INTO job_market_data (key, value, source, confidence, sample_size, updated_at)
         VALUES (?, '1', ?, 0.1, 1, datetime('now'))`,
      ).run(key, `job_${job.id}`);
    }
    titles++;
  }

  if (salaries > 0 || skills > 0 || titles > 0) {
    logger.debug(`Market data: ${salaries} salary(s), ${skills} skill(s), ${titles} title(s) from job #${job.id}`);
  }

  return { salaries, skills, titles };
}

// ----- query helpers -----------------------------------------------------------

export interface MarketDataRow {
  key: string;
  value: string;
  source: string;
  confidence: number;
  sample_size: number;
  updated_at: string;
}

/**
 * Query market data, optionally filtered by key prefix.
 */
export function getMarketData(keyPrefix?: string): MarketDataRow[] {
  const db = getDb();

  if (keyPrefix) {
    return db.prepare(
      'SELECT * FROM job_market_data WHERE key LIKE ? ORDER BY key',
    ).all(`${keyPrefix}%`) as MarketDataRow[];
  }

  return db.prepare('SELECT * FROM job_market_data ORDER BY key').all() as MarketDataRow[];
}

/**
 * Print market data to stdout in a readable format.
 */
export function printMarketData(keyPrefix?: string): void {
  const rows = getMarketData(keyPrefix);

  if (rows.length === 0) {
    console.log('No market data available. Score some jobs first to populate it.');
    return;
  }

  // Group by category
  const groups: Record<string, MarketDataRow[]> = {};
  for (const row of rows) {
    const category = row.key.split('.')[0] ?? 'other';
    if (!groups[category]) groups[category] = [];
    groups[category]!.push(row);
  }

  for (const [category, items] of Object.entries(groups)) {
    console.log(`\n─── ${category.toUpperCase()} ───\n`);

    switch (category) {
      case 'salary_range': {
        for (const item of items) {
          const parts = item.key.split('.');
          const title = parts[1] ?? '?';
          const loc = parts[2] ?? '?';
          console.log(`  ${title} (${loc}): ${item.value}  [n=${item.sample_size}, conf=${item.confidence.toFixed(1)}]`);
        }
        break;
      }
      case 'common_req': {
        const sorted = [...items].sort((a, b) => parseFloat(b.value) - parseFloat(a.value));
        for (const item of sorted) {
          const skill = item.key.split('.').slice(1).join('.');
          const pct = (parseFloat(item.value) * 100).toFixed(0);
          console.log(`  ${skill}: ${pct}% of jobs  [n=${item.sample_size}]`);
        }
        break;
      }
      case 'title_freq': {
        const sorted = [...items].sort((a, b) => parseFloat(b.value) - parseFloat(a.value));
        for (const item of sorted) {
          const title = item.key.split('.').slice(1).join('.').replace(/_/g, ' ');
          const pct = (parseFloat(item.value) * 100).toFixed(0);
          console.log(`  ${title}: ${pct}% of jobs  [n=${item.sample_size}]`);
        }
        break;
      }
      default: {
        for (const item of items) {
          console.log(`  ${item.key}: ${item.value}  [n=${item.sample_size}]`);
        }
      }
    }
  }

  console.log(`\n${rows.length} data point(s) total.`);
}
