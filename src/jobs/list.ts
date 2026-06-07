import { getDb } from '../db/client.js';

interface JobListRow {
  id: number;
  tier: string | null;
  score: number | null;
  company: string | null;
  title: string | null;
  ats_type: string;
  status: string;
  url: string;
}

/** Column definition for the table formatter. */
interface Column {
  key: keyof JobListRow;
  header: string;
  width: number;
  format?: (val: unknown) => string;
}

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', width: 4 },
  {
    key: 'tier',
    header: 'TIER',
    width: 5,
    format: (v) => (v ? String(v) : '-'),
  },
  {
    key: 'score',
    header: 'SCORE',
    width: 6,
    format: (v) => (v != null ? (v as number).toFixed(2) : '-'),
  },
  {
    key: 'company',
    header: 'COMPANY',
    width: 20,
    format: (v) => (v ? String(v).slice(0, 20) : '-'),
  },
  {
    key: 'title',
    header: 'TITLE',
    width: 30,
    format: (v) => (v ? String(v).slice(0, 30) : '-'),
  },
  { key: 'ats_type', header: 'ATS', width: 12 },
  { key: 'status', header: 'STATUS', width: 10 },
  {
    key: 'url',
    header: 'URL',
    width: 50,
    format: (v) => String(v).slice(0, 50),
  },
];

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + ' '.repeat(w - s.length);
}

function formatRow(row: JobListRow, cols: Column[]): string {
  return cols
    .map((c) => {
      const raw = row[c.key];
      const val = c.format ? c.format(raw) : String(raw ?? '');
      return pad(val, c.width);
    })
    .join(' │ ');
}

export interface ListOptions {
  tier?: string;
}

/** Print jobs to stdout in a formatted table. */
export function listJobs(opts: ListOptions = {}): void {
  const db = getDb();

  let query = 'SELECT id, tier, score, company, title, ats_type, status, url FROM jobs';
  const params: unknown[] = [];

  if (opts.tier) {
    query += ' WHERE tier = ?';
    params.push(opts.tier);
  }

  query += ' ORDER BY COALESCE(score, -1) DESC, id ASC';

  const rows = db.prepare(query).all(...params) as JobListRow[];

  if (rows.length === 0) {
    console.log('No jobs found.');
    return;
  }

  // Header
  const sep = COLUMNS.map((c) => '─'.repeat(c.width)).join('─┼─');
  const header = COLUMNS.map((c) => pad(c.header, c.width)).join(' │ ');

  console.log(header);
  console.log(sep);

  for (const row of rows) {
    console.log(formatRow(row, COLUMNS));
  }

  console.log(`\n${rows.length} job(s)`);
}
