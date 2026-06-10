/**
 * Greenhouse application adapter — v0.5 (stub, v1.0 implementation)
 *
 * Handles boards.greenhouse.io application forms.
 * Greenhouse forms are JS-rendered multi-page wizards with a public API
 * that exposes form configuration (questions, fields, validation).
 *
 * See docs/apply-research.md for full field mapping and interface design.
 */

/** Adapter identifier. */
export const ADAPTER_NAME = 'greenhouse';

// v1.0: Implement AtsAdapter interface (see docs/apply-research.md)
// - canHandle(url): true if host matches boards.greenhouse.io or job-boards.greenhouse.io
// - detectForm(page): fetch form config from Greenhouse API, map to AtsFormField[]
// - fillField / uploadResume / submit: Playwright automation
