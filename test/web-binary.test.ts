/**
 * The web interface on its own.
 *
 * A harness that is not OpenCode has no way to show a human the sessions, so the
 * interface is a binary of its own: it serves the existing UI against the daemon
 * and prints the address.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PtyClient } from '../src/client/pty-client.ts'

/** The entry, absolute: the test runs it from a temporary working directory. */
const ENTRY = join(import.meta.dir, '..', 'src', 'web', 'entry.ts')

const temps: string[] = []

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A machine of its own: a runtime directory for the daemon's socket, a state
 * directory for its sessions, and a working directory the origin record is keyed
 * by.
 */
function machine(): { runtimeDir: string; stateDir: string; workdir: string } {
  const root = mkdtempSync(join(tmpdir(), 'opencode-pty-web-'))
  temps.push(root)
  const runtimeDir = join(root, 'run')
  const stateDir = join(root, 'state')
  const workdir = join(root, 'project')
  mkdirSync(runtimeDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(workdir, { recursive: true })
  return { runtimeDir, stateDir, workdir }
}

function env(m: ReturnType<typeof machine>): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[key] = value
  }
  return {
    ...inherited,
    XDG_RUNTIME_DIR: m.runtimeDir,
    XDG_STATE_HOME: m.stateDir,
    OPENCODE_PTY_STATE_DIR: join(m.stateDir, 'sessions'),
  }
}

describe('the standalone web interface', () => {
  it('serves the sessions of the daemon and prints its address', async () => {
    const m = machine()
    const server = Bun.spawn(['bun', ENTRY], {
      env: env(m),
      cwd: m.workdir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      // The address, once, on stdout.
      const reader = (async () => {
        const decoder = new TextDecoder()
        let text = ''
        for await (const chunk of server.stdout) {
          text += decoder.decode(chunk)
          const line = text.split('\n')[0]
          if (line !== undefined && line.trim() !== '') return line.trim()
        }
        return ''
      })()
      const origin = await reader
      expect(origin).toMatch(/^http:\/\/\[?::1\]?:?\d+$|^http:\/\/127\.0\.0\.1:\d+$/)

      // The daemon behind it: a session a separate client spawns is a session the
      // interface lists.
      const client = new PtyClient({
        socketPath: join(m.runtimeDir, 'opencode-pty', 'ptyd.sock'),
        stateDir: join(m.stateDir, 'sessions'),
      })
      await client.connect()
      const spawned = await client.spawn({
        command: 'bash',
        args: ['-c', 'printf "web-session\\r\\n"; sleep 30'],
        description: 'a session the interface lists',
      })
      await Bun.sleep(300)

      const health = await fetch(`${origin}/health`)
      expect(health.status).toBe(200)
      const listed = (await (await fetch(`${origin}/api/sessions`)).json()) as
        | { id: string }[]
        | { sessions?: { id: string }[] }
      const sessions = Array.isArray(listed) ? listed : (listed.sessions ?? [])
      expect(sessions.some((session) => session.id === spawned.id)).toBe(true)

      // And the live output arrives over the WebSocket: the interface is a view
      // of a running session, not a list of finished ones. The session has to
      // produce output AFTER the socket is open - a stream carries what comes
      // next, not what came before.
      const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`)
      await new Promise((resolve) => socket.addEventListener('open', resolve))
      const looping = await client.spawn({
        command: 'bash',
        args: ['-c', 'while true; do printf "tick\\r\\n"; sleep 0.2; done'],
        description: 'a session that keeps talking',
      })
      // The stream is a subscription: the client asks for the session's output.
      socket.send(JSON.stringify({ type: 'subscribe', sessionId: looping.id }))
      const received = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no live output arrived')), 8000)
        socket.addEventListener('message', (event) => {
          const text = String(event.data)
          if (text.includes('raw_data')) {
            clearTimeout(timer)
            resolve(text)
          }
        })
        socket.addEventListener('error', (event) => {
          clearTimeout(timer)
          reject(new Error(`the websocket failed: ${String(event)}`))
        })
      })
      expect(received).toContain('raw_data')
      expect(received).toContain(looping.id)
      socket.close()
      await client.kill(looping.id, true)
      client.disconnect()
    } finally {
      server.kill()
    }
  }, 30_000)

  it('leaves no origin record behind when it is stopped', async () => {
    const m = machine()
    const server = Bun.spawn(['bun', ENTRY], {
      env: env(m),
      cwd: m.workdir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      // Wait for the record: the server writes it when it binds. It lives in the
      // runtime directory, next to the daemon's socket.
      const record = join(m.runtimeDir, 'opencode-pty')
      let files: string[] = []
      for (let attempt = 0; attempt < 100; attempt++) {
        await Bun.sleep(100)
        if (existsSync(record)) {
          files = readdirSync(record).filter((name) => name.endsWith('.json'))
          if (files.length > 0) break
        }
      }
      expect(files.length).toBeGreaterThan(0)
    } finally {
      server.kill('SIGTERM')
    }

    // And it is gone once the process is: a record that outlives its server points
    // a TUI at an address nobody answers.
    for (let attempt = 0; attempt < 50; attempt++) {
      await Bun.sleep(100)
      const record = join(m.runtimeDir, 'opencode-pty')
      if (
        !existsSync(record) ||
        readdirSync(record).filter((n) => n.endsWith('.json')).length === 0
      ) {
        return
      }
    }
    throw new Error('the origin record outlived the server')
  }, 30_000)
})
