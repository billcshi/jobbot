/**
 * Ashby application adapter — v0.5 (stub, v1.0 implementation)
 *
 * Handles jobs.ashbyhq.com application forms.
 * Ashby forms are JavaScript SPA multi-step wizards with client-side validation.
 * Form configuration is embedded in the page's initial state JSON.
 *
 * See docs/apply-research.md for full field mapping and interface design.
 */

/** Adapter identifier. */
export const ADAPTER_NAME = 'ashby';

// v1.0: Implement AtsAdapter interface (see docs/apply-research.md)
// - canHandle(url): true if host matches jobs.ashbyhq.com
// - detectForm(page): extract form config from page's initial state
// - fillField / uploadResume / submit: Playwright automation
