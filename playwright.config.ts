import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for JobBot.
 *
 * Uses a persistent browser context stored in `browser-data/`
 * so cookies, sessions, and localStorage survive between runs.
 * This avoids logging in to job boards every time.
 *
 * On WSL2: Playwright works either headless (no display needed)
 * or headed via WSLg (built-in GUI support in WSL2).
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    // Headless by default — safer, faster, works everywhere.
    // Switch to headless: false when debugging via WSLg.
    headless: true,

    // Persistent browser profile so login sessions are reused.
    // This is NOT your main Chrome profile — it's a dedicated jobbot profile.
    userDataDir: './local/browser-data/profile',

    // Video/screenshot recording for debugging.
    video: 'retain-on-failure',
    screenshot: 'on',
  },

  // These project dirs hold ATS-specific test specs
  projects: [
    {
      name: 'greenhouse',
      testDir: './tests/apply/greenhouse',
    },
    {
      name: 'lever',
      testDir: './tests/apply/lever',
    },
    {
      name: 'ashby',
      testDir: './tests/apply/ashby',
    },
  ],
});
