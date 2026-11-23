/**
 * The counterpart to `restart-lost.test.ts`: a REAL restart must still be announced.
 *
 * The daemon marks stale sessions lost once at its own startup. The plugin gets that
 * snapshot through `load_persisted_sessions` and builds `<pty_restart>` from it. Making
 * the RPC read-only must not silently erase that path - otherwise a dead session would
 * never be reported at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

import { PtyClient } from '../src/client/pty-client.ts'

const stamp = Date.now()
const socketPath = `/tmp/opencode-pty-genuine-${stamp}.sock`
const stateDir = `/tmp/opencode-pty-genuine-state-${stamp}`
let daemonProc: ReturnType<typeof Bun.spawn>

describe('a genuine startup loss is still reported', () => {
  beforeAll(async () => {
    mkdirSync(stateDir, { recursive: true })
    // An archive written by an older daemon generation: its process is gone, so the
    // startup mark is correct here - unlike a merely reconnecting client.
    writeFileSync(
      `${stateDir}/index.json`,
      JSON.stringify([
        {
          id: 'pty_old_generation',
          title: 'old console',
          description: 'old console',
          command: 'bash',
          args: ['-lc', 'sleep 30'],
          workdir: '/tmp',
          status: 'running',
          pid: 999999,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          notifyOnExit: false,
          timedOut: false,
          archived: true,
          generation: 'a-previous-generation',
          bytes: 12,
          lineCount: 0,
          charCount: 12,
          cols: 80,
          rows: 24,
        },
      ])
    )
    daemonProc = Bun.spawn(
      ['bun', 'run', 'src/daemon/index.ts', '--socket', socketPath, '--state-dir', stateDir],
      { stdout: 'ignore', stderr: 'ignore' }
    )
    for (let i = 0; i < 40; i += 1) {
      await Bun.sleep(250)
      if (existsSync(socketPath)) break
    }
    expect(existsSync(socketPath)).toBe(true)
  })

  afterAll(async () => {
    const pidFile = `${socketPath.slice(0, socketPath.lastIndexOf('/'))}/ptyd.pid`
    try {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    } catch {}
    try {
      daemonProc.kill()
    } catch {}
    await Bun.sleep(200)
    try {
      rmSync(socketPath)
    } catch {}
    try {
      rmSync(stateDir, { recursive: true, force: true })
    } catch {}
  })

  it('returns the sessions lost at daemon start, with the lost flag intact', async () => {
    const client = new PtyClient({ socketPath, stateDir })
    await client.connect()
    const restored = await client.loadPersistedSessions()
    const lost = restored.find((entry) => entry.id === 'pty_old_generation')
    expect(lost).toBeDefined()
    expect(lost?.lost).toBe(true)
    expect(lost?.status).toBe('exited')
    client.disconnect()
  })
})
