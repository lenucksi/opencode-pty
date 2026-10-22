/**
 * The version of the wire protocol.
 *
 * The daemon outlives the host, so a new plugin can meet a daemon that was started
 * long ago. The version is what tells the two apart.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'

import { PtyClient } from '../src/client/pty-client.ts'
import { PROTOCOL_VERSION } from '../src/daemon/protocol.ts'

const temps: string[] = []

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the protocol version', () => {
  it('the daemon answers with the version it speaks', async () => {
    const dir = `/tmp/opencode-pty-version-${Date.now()}`
    temps.push(dir)
    mkdirSync(dir, { recursive: true })
    const socketPath = `${dir}/ptyd.sock`
    const daemon = Bun.spawn(
      [
        'bun',
        'run',
        'src/daemon/index.ts',
        '--socket',
        socketPath,
        '--state-dir',
        `${dir}/sessions`,
      ],
      { stdout: 'ignore', stderr: 'ignore' }
    )
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        await Bun.sleep(100)
        if (existsSync(`${dir}/ptyd.pid`)) break
      }
      const client = new PtyClient({ socketPath, stateDir: `${dir}/sessions` })
      await client.connect()
      const pong = await client.ping()
      expect(pong.protocolVersion).toBe(PROTOCOL_VERSION)
      expect(pong.pid).toBeGreaterThan(0)
      client.disconnect()
    } finally {
      daemon.kill()
    }
  }, 30_000)
})
