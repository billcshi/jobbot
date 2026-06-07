/**
 * Application orchestrator stub.
 *
 * Future: coordinates the full application flow —
 *   1. tailor resume
 *   2. render PDF
 *   3. open browser (--dry-run by default)
 *   4. autofill forms
 *   5. stop before final submission unless --submit is passed
 *
 * For v0 this is not yet implemented.
 */
export async function apply(_jobId: number, _opts?: { submit?: boolean }): Promise<void> {
  throw new Error('apply not yet implemented');
}
