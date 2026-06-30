import { defineConfig, devices } from '@playwright/test';

/**
 * E2E smoke harness (separate from the vitest unit suite, which `npm test` runs).
 *
 * The webServer builds the PRODUCTION app (`npm run build`) and serves it with
 * `vite preview` — preview ships the worklet + assets and sets the COOP/COEP
 * headers (see vite.config.ts `preview`), matching how the app really runs.
 *
 * Audio cannot truly play headless, but the GAME LOGIC (player position, heading,
 * win detection, ARIA-live status, the ?debug=1 overlay/state) runs regardless, so
 * the specs drive and assert on DOM/state, never on sound.
 */
const PORT = 4173;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // The app fetches a ~5.8 MB HRTF and pulls in WASM/worklets — be generous.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    headless: true,
    navigationTimeout: 60_000,
    actionTimeout: 15_000,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Build then preview the production bundle (preview sets COOP/COEP + serves assets).
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // The build runs wasm-pack + worklet bundling + vite build — give it room.
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
