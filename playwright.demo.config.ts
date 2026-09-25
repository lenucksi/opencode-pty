import { defineConfig, devices } from '@playwright/test'

/**
 * Recording config for the README demo. Separate from `playwright.config.ts`
 * because it needs a fixed viewport, video capture and deterministic timing.
 *
 * Usage: bun run capture:demo
 */

const DEMO_TEST = 'test/e2e/demo-capture.pw.ts'

export default defineConfig({
  testDir: './test/e2e',
  testMatch: DEMO_TEST,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [['list']],
  outputDir: 'test-results/demo',
  use: {
    baseURL: process.env.DEMO_BASE_URL,
    // Pinned so the recording always shows the same palette.
    colorScheme: 'dark',
    ...devices['Desktop Chrome'],
    // Applied after the device preset so the recording is exactly 1080p.
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    trace: 'off',
    screenshot: 'off',
    video: {
      mode: 'on',
      size: { width: 1920, height: 1080 },
    },
  },
  projects: [{ name: 'chromium' }],
})
