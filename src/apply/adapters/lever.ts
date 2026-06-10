/**
 * Lever application adapter — v0.5 (stub, v1.0 implementation)
 *
 * Handles jobs.lever.co application forms.
 * Lever forms are single-page server-rendered HTML with progressive enhancement.
 * Simplest ATS to automate — stable selectors, all fields visible at once.
 *
 * See docs/apply-research.md for full field mapping and interface design.
 */

/** Adapter identifier. */
export const ADAPTER_NAME = 'lever';

// v1.0: Implement AtsAdapter interface (see docs/apply-research.md)
// - canHandle(url): true if host matches jobs.lever.co
// - detectForm(page): parse form fields from static HTML
// - fillField / uploadResume / submit: Playwright automation
