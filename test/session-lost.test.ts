import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { manager } from '../src/plugin/pty/manager.ts'
import { SessionStore } from '../src/plugin/pty/session-store.ts'
import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'
import { buildSessionNotFoundError } from '../src/plugin/pty/utils.ts'

/**
 * After a restart the model still believes its sessions are running. A tool call
 * with such an id must say what happened and hand over the archived tail,
 * instead of a bare "not found".
 */
const roots: string[] = []

function tempStore(): SessionStore {
  const root = mkdtempSync(join(tmpdir(), 'pty-lost-'))
  roots.push(root)
  return new SessionStore({ root, generation: 'gen-previous' })
}

function sessionInfo(overrides: Partial<PTYSessionInfo> = {}): PTYSessionInfo {
  return {
    id: 'pty_lost',
    title: 'ansible 45-stalwart-guest',
    command: 'ansible-playbook',
    args: ['site.yml'],
    workdir: '/tmp',
    status: 'running',
    notifyOnExit: true,
    timedOut: false,
    pid: 1234,
    createdAt: '2026-09-20T17:00:00.000Z',
    lineCount: 0,
    ...overrides,
  }
}

const original = manager.getSessionStore()

afterEach(() => {
  manager.setSessionStore(original)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('buildSessionNotFoundError', () => {
  it('explains a session that only lives in the archive', () => {
    const store = tempStore()
    store.startSession({ ...sessionInfo(), parentSessionId: 'ses_parent' })
    store.appendOutput('pty_lost', 'PLAY RECAP\nok=38 changed=13 failed=0\n')
    store.flush()
    store.markStaleAsLost()
    manager.setSessionStore(store)

    const message = buildSessionNotFoundError('pty_lost').message

    expect(message).toContain('<pty_session_lost>')
    expect(message).toContain('Status: exited (lost in a PTY server restart)')
    expect(message).toContain('Generation: gen-previous')
    expect(message).toContain('ok=38 changed=13 failed=0')
    expect(message).toContain('pty_read')
    expect(message).toContain('</pty_session_lost>')
  })

  it('stays a plain not-found for an id nobody ever saw', () => {
    const store = tempStore()
    manager.setSessionStore(store)

    const message = buildSessionNotFoundError('pty_never').message

    expect(message).toContain("PTY session 'pty_never' not found")
    expect(message).not.toContain('<pty_session_lost>')
  })
})
