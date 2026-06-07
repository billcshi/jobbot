/**
 * Browser automation stub.
 *
 * Future: wraps Playwright for deterministic interactions on known ATS
 * platforms (Greenhouse, Lever, Ashby) and Stagehand for ambiguous forms.
 * Always defaults to --dry-run.
 *
 * For v0 this is not yet implemented.
 */
export async function launchBrowser(_opts?: { dryRun?: boolean }): Promise<void> {
  throw new Error('launchBrowser not yet implemented');
}
