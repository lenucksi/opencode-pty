import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// Before any spec is loaded, and that ordering is the whole point: `test/utils.ts` (which
// every spec reaches through `fixtures.ts`) imports the PTY manager, so the WORKER process
// itself constructs a SessionStore at import time. Without this, `defaultRoot()` falls back
// to the developer's real archive and the worker's own bookkeeping - `clearAllSessions()`
// on every ManagedTestServer dispose - removes entries from it. Measured: the real
// ~/.local/state/.../sessions/index.json was being modified by test runs, and each removal
// logged "caller asked for something that had already been removed".
// The spawned server-under-test already gets its own isolated directory in fixtures.ts; this
// is the worker's directory, which nothing covered.
process.env.OPENCODE_PTY_STATE_DIR ??= join(tmpdir(), 'opencode-pty-e2e-worker')

/**
 * @see https://playwright.dev/docs/test-configuration
 */

export default defineConfig({
  globalSetup: resolve(__dirname, 'test/e2e/global-setup.ts'),
  testDir: './test/e2e',
  testMatch: '**/*.pw.ts',
  /* Run tests in files in parallel */
  fullyParallel: true, // Enable parallel execution with isolated servers
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Allow multiple workers for parallelism */
  workers: process.env.CI ? 8 : 4, // 3 locally, 8 on CI for parallel execution
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Global timeout increased for reliable parallel execution */
  timeout: 15000,
  expect: { timeout: 5000 },
  /* Configure projects for major browsers */
  // Chromium only, and the reason is the suite rather than the browser: the copy
  // tests ask for the `clipboard-read` permission, which is a Chromium feature -
  // Firefox answers "Unknown permission: clipboard-read" and takes the worker with
  // it, so a Firefox project fails the whole file and then the tests that shared
  // the worker.
  //
  // The local gate has always run `--project=chromium` for the same reason. The
  // project list said otherwise, and the CI believed the project list.
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
  // Server managed per worker via fixtures
  // Use worker-scoped state for better isolation
  use: {
    // Increase action timeout for slower operations
    actionTimeout: 5000,
    // Increase navigation timeout
    navigationTimeout: 10000,
    // The app follows `prefers-color-scheme`; pin dark so the suite keeps
    // testing the default look. Theme-specific tests override this per file.
    colorScheme: 'dark',
  },
})
