/**
 * Generic / Stagehand adapter — v0.5 (stub, v1.0 implementation)
 *
 * Fallback for ambiguous or unknown application forms that don't match a known
 * ATS (Greenhouse, Lever, Ashby, Workday). Uses Stagehand (AI-driven browser
 * automation) to interpret and fill forms that lack stable selectors.
 *
 * This adapter is particularly important for Workday, which has no reliable
 * deterministic selectors due to auto-generated class names and a heavy JS
 * framework.
 *
 * Always defaults to --dry-run when dealing with unknown forms.
 *
 * See docs/apply-research.md for full interface design.
 */

/** Adapter identifier. */
export const ADAPTER_NAME = 'generic-stagehand';

// v1.0: Implement AtsAdapter interface (see docs/apply-research.md)
// - canHandle(url): always returns true (catch-all fallback)
// - detectForm(page): use Stagehand's AI to identify form fields
// - fillField / uploadResume / submit: Stagehand-driven automation
// - Defaults to dry-run for safety on unknown forms
