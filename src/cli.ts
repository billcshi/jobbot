#!/usr/bin/env node
/**
 * JobBot CLI — v0.4
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
import { deleteJob, deleteByTier, deleteByStatus } from './jobs/delete.js';
import { startUi } from './ui/server.js';
import { logger } from './utils/logger.js';

function usage(): never {
  console.log(`JobBot — personal job-search assistant

Usage:
  pnpm jobbot init-db
  pnpm jobbot add-url <url>
  pnpm jobbot extract [--job <id>]
  pnpm jobbot score
  pnpm jobbot list [--tier <tier>]
  pnpm jobbot delete --job <id> [--force]
  pnpm jobbot delete --tier <tier> [--force]
  pnpm jobbot delete --status <status> [--force]
  pnpm jobbot run [--step extract|score|compose|audit] [--job <id>]
  pnpm jobbot tailor --job <id>
  pnpm jobbot render --job <id>
  pnpm jobbot compose --job <id>
  pnpm jobbot audit --job <id>
  pnpm jobbot ui
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

    case 'delete': {
      const jobId = flags['job'];
      const tier = flags['tier'];
      const status = flags['status'];
      const force = flags['force'] === 'true';

      if (jobId) {
        try {
          const result = deleteJob(Number(jobId));
          console.log(`Deleted job #${result.jobs[0]?.id}: "${result.jobs[0]?.title || 'Untitled'}"`);
        } catch (err) {
          logger.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      } else if (tier) {
        if (!force) {
          const db = (await import('./db/client.js')).getDb();
          const count = (db.prepare(
            'SELECT COUNT(*) as count FROM jobs WHERE tier = ?',
          ).get(tier.toUpperCase()) as { count: number }).count;
          if (count === 0) {
            console.log(`No jobs found with tier ${tier.toUpperCase()}.`);
            break;
          }
          console.log(`About to delete ${count} job(s) with tier ${tier.toUpperCase()}.`);
          console.log('Add --force to skip confirmation.');
          break;
        }
        const result = deleteByTier(tier);
        console.log(`Deleted ${result.deleted} job(s) with tier ${tier.toUpperCase()}.`);
      } else if (status) {
        if (!force) {
          const db = (await import('./db/client.js')).getDb();
          const count = (db.prepare(
            'SELECT COUNT(*) as count FROM jobs WHERE status = ?',
          ).get(status) as { count: number }).count;
          if (count === 0) {
            console.log(`No jobs found with status "${status}".`);
            break;
          }
          console.log(`About to delete ${count} job(s) with status "${status}".`);
          console.log('Add --force to skip confirmation.');
          break;
        }
        const result = deleteByStatus(status);
        console.log(`Deleted ${result.deleted} job(s) with status "${status}".`);
      } else {
        logger.error('delete requires one of: --job <id>, --tier <tier>, --status <status>');
        process.exit(1);
      }
      break;
    }

    case 'run': {
      const step = flags['step'];
      const jobId = flags['job'];
      if (jobId) {
        const { runJob } = await import('./jobs/run.js');
        await runJob(Number(jobId));
      } else if (step === 'extract') {
        const { runExtract } = await import('./jobs/run.js');
        await runExtract();
      } else if (step === 'score') {
        const { runScore } = await import('./jobs/run.js');
        await runScore();
      } else if (step === 'compose') {
        const { runCompose } = await import('./jobs/run.js');
        await runCompose();
      } else if (step === 'audit') {
        const { runAudit } = await import('./jobs/run.js');
        await runAudit();
      } else {
        const { runAll } = await import('./jobs/run.js');
        await runAll();
      }
      break;
    }

    case 'tailor': {
      const jobId = flags['job'];
      if (!jobId) {
        logger.error('tailor requires --job <id>');
        process.exit(1);
      }
      const { tailorJob } = await import('./jobs/tailor.js');
      const result = await tailorJob(Number(jobId));
      if (result.success) {
        console.log(`Tailored resume for job #${jobId}: ${result.versionName}`);
      } else {
        logger.error(`Tailor failed: ${result.error}`);
      }
      break;
    }

    case 'render': {
      const jobId = flags['job'];
      if (!jobId) {
        logger.error('render requires --job <id>');
        process.exit(1);
      }
      const { renderJob } = await import('./jobs/render.js');
      const result = await renderJob(Number(jobId));
      if (result.success) {
        console.log(`PDF: ${result.pdfPath}`);
      } else {
        logger.error(`Render failed: ${result.error}`);
      }
      break;
    }

    case 'audit': {
      const jobId = flags['job'];
      if (!jobId) {
        logger.error('audit requires --job <id>');
        process.exit(1);
      }
      const { auditJob } = await import('./jobs/audit.js');
      const result = await auditJob(Number(jobId));
      if (result.success) {
        console.log(`\nAudit complete — Overall: ${result.overallScore}/100`);
        console.log(`Content issues: ${result.contentIssues.length}, Visual issues: ${result.visualIssues.length}`);
      } else {
        logger.error(`Audit failed: ${result.error}`);
      }
      break;
    }

    case 'cover-letter': {
      const jobId = flags['job'];
      if (!jobId) { logger.error('cover-letter requires --job <id>'); process.exit(1); }
      const { generateCoverLetter } = await import('./jobs/cover-letter.js');
      const result = await generateCoverLetter(Number(jobId));
      if (result.success) {
        console.log(`Cover letter PDF: ${result.pdfPath}`);
      } else {
        logger.error(`Cover letter failed: ${result.error}`);
      }
      break;
    }

    case 'compose': {
      const jobId = flags['job'];
      if (!jobId) {
        logger.error('compose requires --job <id>');
        process.exit(1);
      }
      const { composeJob } = await import('./jobs/compose.js');
      const result = await composeJob(Number(jobId));
      if (result.success) {
        console.log(`PDF: ${result.pdfPath}`);
      } else {
        logger.error(`Compose failed: ${result.error}`);
      }
      break;
    }

    case 'ui': {
      startUi();
      console.log('Press Ctrl+C to stop.');
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
