import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { createApiClient } from '../../src/web/shared/api-client.ts'
import { ManagedTestClient } from '../utils'
import { waitForTerminalRegex } from './xterm-test-helpers.ts'

/**
 * Records the README demo. All session output comes from the canned scripts in
 * this directory, so the recording never contains real data.
 *
 * Run with `bun run capture:demo`; the wrapper starts the demo server, runs this
 * spec with video capture and converts the result to `docs/media/web-ui-demo.gif`.
 */

/** Set by `scripts/capture-demo.ts`; absent during the normal E2E suite. */
const RECORDING = Boolean(process.env.DEMO_BASE_URL)
const BASE_URL = process.env.DEMO_BASE_URL ?? 'http://[::1]:1'
const api = createApiClient(BASE_URL)

/** Fixed viewport timings keep the GIF reproducible and readable. */
const BEAT = 1400

interface DemoSession {
  description: string
  parentSessionId: string
  parentAgent?: string
  args: string[]
}

async function spawnOverWebSocket(url: string, sessions: DemoSession[]): Promise<void> {
  // The upgrade endpoint lives on /ws; a bare origin is not a WebSocket route.
  const client = await ManagedTestClient.create(`${url.replace(/^http/, 'ws')}/ws`)
  try {
    for (const session of sessions) {
      client.send({
        type: 'spawn',
        command: 'python3',
        args: session.args,
        description: session.description,
        parentSessionId: session.parentSessionId,
        ...(session.parentAgent ? { parentAgent: session.parentAgent } : {}),
      })
    }
  } finally {
    client.ws.close()
  }
}

async function openTerminal(page: Page, description: string): Promise<void> {
  await page.locator('.session-item').filter({ hasText: description }).first().click()
  await page.waitForSelector('.terminal.xterm', { timeout: 15_000 })
  await page.waitForFunction(() => window.xtermTerminal !== undefined, { timeout: 20_000 })
}

async function selectTheme(page: Page, label: 'Auto' | 'Light' | 'Dark'): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click()
}

test('record README demo', async ({ page }) => {
  // The main E2E config globs this file too; only the recording wrapper sets
  // DEMO_BASE_URL, so the regular suite just skips it.
  test.skip(!RECORDING, 'recording spec, only runs through scripts/capture-demo.ts')
  test.setTimeout(180_000)

  await page.goto(BASE_URL)
  // The sidebar renders group sections only once sessions exist, so wait for
  // the connection indicator and let the first spawn create the first section.
  await page.waitForSelector('.connection-status, .sidebar', { timeout: 20_000 })
  await page.waitForTimeout(BEAT)

  // --- Scene 1: sessions arrive over the WebSocket and form groups ---
  await spawnOverWebSocket(BASE_URL, [
    {
      description: 'build',
      parentSessionId: 'ses_demo_build',
      parentAgent: 'build',
      args: ['-u', 'test/e2e/demo-build-log.py'],
    },
  ])
  await page.waitForSelector('.session-item', { timeout: 10_000 })
  await page.waitForTimeout(BEAT)

  await spawnOverWebSocket(BASE_URL, [
    {
      description: 'api',
      parentSessionId: 'ses_demo_api',
      parentAgent: 'plan',
      args: ['-u', 'test/e2e/demo-server-log.py'],
    },
    {
      description: 'migrate',
      parentSessionId: 'ses_demo_api',
      parentAgent: 'plan',
      args: ['-u', 'test/e2e/demo-migrate.py'],
    },
  ])
  await page.waitForSelector('[data-testid="parent-session-group"]', { timeout: 10_000 })
  await page.waitForTimeout(BEAT * 2)

  // --- Scene 2: live streaming into the terminal ---
  await openTerminal(page, 'build')
  // Wait for the last build step to land so the pane is not caught mid-stream.
  await waitForTerminalRegex(page, /watch mode active/, undefined, 30_000)
  await page.waitForTimeout(BEAT)

  // --- Scene 3: switch to the other session, then back ---
  await openTerminal(page, 'api')
  await page.waitForTimeout(BEAT * 2)

  await openTerminal(page, 'build')
  await waitForTerminalRegex(page, /watch mode active/, undefined, 15_000)
  await page.waitForTimeout(BEAT)

  // --- Scene 4: mouse selection and copy ---
  const terminalBox = await page.locator('.terminal.xterm').boundingBox()
  if (!terminalBox) {
    throw new Error('terminal is not visible')
  }

  await page.mouse.move(terminalBox.x + 30, terminalBox.y + 10)
  await page.mouse.down()
  await page.mouse.move(terminalBox.x + 420, terminalBox.y + 30, { steps: 14 })
  await page.mouse.up()
  await page.waitForTimeout(BEAT)

  await expect
    .poll(() => page.evaluate(() => window.xtermTerminal?.hasSelection() ?? false))
    .toBe(true)

  await page.getByRole('button', { name: /copy/i }).first().click()
  await page.waitForTimeout(BEAT)

  // --- Scene 5: theme switch ---
  await selectTheme(page, 'Light')
  await page.waitForTimeout(BEAT * 2)

  await selectTheme(page, 'Dark')
  await page.waitForTimeout(BEAT)

  // --- Scene 6: a session finishes and moves to the finished section ---
  const sessions = await api.sessions.list()
  const migrate = sessions.find((session) => session.description === 'migrate')
  if (!migrate) {
    throw new Error('migrate session is missing')
  }
  await api.session.kill({ id: migrate.id })
  // Wait for the sidebar to actually show the finished section, so the
  // recording does not cut off before the transition is visible. The locator
  // is scoped to this session instead of counting, so a leftover item from an
  // earlier run cannot fail the recording.
  const finishedItem = page
    .locator('.session-section-finished .session-item')
    .filter({ hasText: 'migrate' })
  await expect(finishedItem).toHaveCount(1, { timeout: 15_000 })
  await page.waitForTimeout(BEAT * 2)

  // --- Scene 7: back to the streaming server session ---
  await openTerminal(page, 'api')
  await page.waitForTimeout(BEAT * 2)

  // Let the encoder flush a final frame before the recording stops.
  await page.waitForTimeout(500)
})
