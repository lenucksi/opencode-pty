import { type ChildProcess, spawn } from 'node:child_process'
import { test as base, type Locator, type Page, type WorkerInfo } from '@playwright/test'

import { createApiClient } from '../../src/web/shared/api-client.ts'
import { ManagedTestClient } from '../utils'

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      // ignore errors
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`)
}

type TestFixtures = {
  api: ReturnType<typeof createApiClient>
  autoCleanup: undefined
  wsClient: ManagedTestClient
}
type WorkerFixtures = {
  server: { baseURL: string; port: number }
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  server: [
    // biome-ignore lint/correctness/noEmptyPattern: required empty pattern for Playwright fixture
    async ({}, fixtureUse, workerInfo: WorkerInfo) => {
      const workerIndex = workerInfo.workerIndex
      const portFilePath = `/tmp/test-server-port-${workerIndex}.txt`

      // Clean up old port file from previous test runs
      try {
        const file = Bun.file(portFilePath)
        await file.delete()
      } catch {
        // ignore errors
      }

      const proc: ChildProcess = spawn('bun', ['run', 'test/e2e/test-web-server.ts'], {
        env: {
          ...process.env,
          TEST_WORKER_INDEX: workerInfo.workerIndex.toString(),
          // Keep the archived sessions of a test run out of the developer's
          // real state directory.
          OPENCODE_PTY_STATE_DIR: `/tmp/opencode-pty-e2e/state-${workerIndex}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      proc.stdout?.on('data', (_data) => {
        console.log(`[W${workerIndex} OUT] ${_data}`)
      })

      proc.stderr?.on('data', (data) => {
        console.error(`[W${workerIndex} ERR] ${data}`)
      })

      proc.on('exit', (_code, _signal) => {})

      try {
        // Wait for server to write port file
        await new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            try {
              Bun.file(portFilePath)
                .exists()
                .then((exists) => {
                  if (exists) {
                    clearInterval(checkInterval)
                    resolve()
                  }
                })
            } catch {
              // ignore errors
            }
          }, 100)
        })

        // Read the actual URL from port file
        const serverURLText = await Bun.file(portFilePath).text()
        const serverURL = serverURLText.trim()

        // Parse URL to extract port number
        const urlMatch = serverURL.match(/http:\/\/(?:127\.0\.0\.1|\[::1\]):(\d+)/)
        if (!urlMatch?.[1]) {
          throw new Error(`Invalid port file format: ${serverURL}`)
        }
        const port = parseInt(urlMatch[1], 10)
        const baseURL = serverURL.includes('[::1]')
          ? `http://[::1]:${port}`
          : `http://127.0.0.1:${port}`

        await waitForServer(baseURL, 15000)

        // Clear any leftover sessions from previous test runs
        try {
          const apiClient = createApiClient(baseURL)
          await apiClient.sessions.clear()
        } catch (error) {
          // Ignore clear errors during startup
          console.log(`[Worker ${workerIndex}] Could not clear sessions during startup: ${error}`)
        }

        await fixtureUse({ baseURL, port })
      } catch (error) {
        console.error(`[Worker ${workerIndex}] Failed to start server: ${error}`)
        throw error
      } finally {
        // Ensure process is killed
        if (!proc.killed) {
          proc.kill('SIGTERM')
          // Wait a bit, then force kill if still running
          setTimeout(() => {
            if (!proc.killed) {
              proc.kill('SIGKILL')
            }
          }, 2000)
        }
        await new Promise((resolve) => {
          if (proc.killed) {
            resolve(void 0)
          } else {
            proc.on('exit', resolve)
          }
        })
      }
    },
    { scope: 'worker', auto: true },
  ],

  // Auto fixture that clears sessions before every test
  autoCleanup: [
    async ({ server }, fixtureUse) => {
      const api = createApiClient(server.baseURL)
      try {
        await api.sessions.clear()
      } catch (error) {
        console.warn('Could not clear sessions before test:', error)
      }
      await fixtureUse(undefined)
    },
    { auto: true },
  ],

  api: async ({ server }, fixtureUse) => {
    const api = createApiClient(server.baseURL)
    await fixtureUse(api)
  },

  // WebSocket client fixture for event-driven testing
  wsClient: async ({ server }, fixtureUse) => {
    const wsUrl = `${server.baseURL.replace(/^http/, 'ws')}/ws`
    await using client = await ManagedTestClient.create(wsUrl)
    await fixtureUse(client)
  },

  // Extend page fixture to automatically navigate to server URL and wait for readiness
  page: async ({ page, server }, fixtureUse) => {
    await page.goto(server.baseURL)
    await page.waitForLoadState('networkidle')
    await fixtureUse(page)
  },
})

/** Make a grouped session card visible, expanding a collapsed parent if needed. */
export async function revealSession(
  page: Page,
  description: string,
  timeout = 10_000
): Promise<Locator> {
  const item = page.locator('.session-item').filter({ hasText: description }).first()
  await item.waitFor({ state: 'attached', timeout })
  if (!(await item.isVisible())) {
    await item.locator('xpath=ancestor::details[1]').locator('summary').click()
  }
  await item.waitFor({ state: 'visible', timeout })
  return item
}

/** Select a PTY after making its parent-session group visible. */
export async function selectSession(
  page: Page,
  description: string,
  timeout = 10_000
): Promise<Locator> {
  const deadline = Date.now() + timeout
  let lastError: unknown

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const item = page.locator('.session-item').filter({ hasText: description }).first()
    try {
      await item.waitFor({ state: 'attached', timeout: remaining })
      if (!(await item.isVisible())) {
        await item
          .locator('xpath=ancestor::details[1]')
          .locator('summary')
          .click({ timeout: remaining })
        continue
      }
      await item.click({ timeout: Math.min(1_000, remaining) })
      return item
    } catch (error) {
      // A command can finish while the click is in flight, moving its card from
      // the open Running group to a newly mounted, collapsed Finished group.
      // Re-resolve and reveal it once more before giving up.
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out selecting PTY session ${description}`)
}

export { expect } from '@playwright/test'
