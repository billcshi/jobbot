#!/usr/bin/env node
/**
 * JobBot CLI — v0.2
 *
 * Commands:
 *   init-db                     Create/update the SQLite database
 *   add-url <url>               Add a job posting URL
 *   extract [--job <id>]        Extract job details (title, company, etc.)
 *   score                       Score all jobs against preferences
 *   list [--tier <tier>]        List jobs, optionally filtered by tier
 */

import { initDb } from './db/init.js';
import { addUrl } from './jobs/add-url.js';
import { extractJob, extractAll } from './jobs/extract.js';
import { scoreAll } from './jobs/score.js';
import { listJobs } from './jobs/list.js';
import { logger } from './utils/logger.js';

function usage(): never {
  console.log(`JobBot — personal job-search assistant

Usage:
  pnpm jobbot init-db
  pnpm jobbot add-url <url>
  pnpm jobbot extract [--job <id>]
  pnpm jobbot score
  pnpm jobbot list [--tier <tier>]
`);
  process.exit(1);
}

// ----- argument parser -------------------------------------------------------

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
  positional: string[];
}

function parseArgs(raw: string[]): ParsedArgs | null {
  if (raw.length === 0) return null;

  const command = raw[0]!;
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 1; i < raw.length; i++) {
    if (raw[i]!.startsWith('--')) {
      const key = raw[i]!.slice(2);
      const next = raw[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(raw[i]!);
    }
  }

  return { command, flags, positional };
}

// ----- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) usage();

  const { command, flags, positional } = parsed;

  switch (command) {
    case 'init-db': {
      initDb();
      break;
    }

    case 'add-url': {
      const url = positional[0];
      if (!url) {
        logger.error('Missing required argument: <url>');
        process.exit(1);
      }
      const result = addUrl(url);
      if (result.alreadyExisted) {
        console.log(`Already tracked (id=${result.id}, ats=${result.atsType})`);
      } else {
        console.log(`Added (id=${result.id}, ats=${result.atsType})`);
      }
      break;
    }

    case 'extract': {
      const jobId = flags['job'];
      if (jobId) {
        const result = await extractJob(Number(jobId));
        if (result.success) {
          console.log(`"${result.title}" at ${result.company} (${result.location})`);
        } else {
          logger.error(`Extract failed: ${result.error}`);
        }
      } else {
        const results = await extractAll();
        for (const r of results) {
          if (r.success) {
            console.log(`[${r.jobId}] "${r.title}" at ${r.company}`);
          } else {
            console.log(`[${r.jobId}] FAILED: ${r.error}`);
          }
        }
      }
      break;
    }

    case 'score': {
      const result = await scoreAll();
      console.log(`Scored ${result.scored} job(s).`);
      break;
    }

    case 'list': {
      const tier = flags['tier'];
      listJobs(tier ? { tier } : {});
      break;
    }

    default:
      logger.error(`Unknown command: ${command}`);
      usage();
  }
}

main().catch((err) => {
  logger.error('Unhandled error', err);
  process.exit(1);
});
