import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionNotifier } from '../src/adapters/types.ts'
import {
  announcedGenerationPath,
  buildRestartNotice,
  readAnnouncedGeneration,
  writeAnnouncedGeneration,
} from '../src/plugin/pty/restart-notice.ts'
import { SessionStore } from '../src/plugin/pty/session-store.ts'
import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'
import { announceRestart } from '../src/v2/restart-announce.ts'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'pty-notice-'))
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

describe('buildRestartNotice', () => {
  const base = {
    generation: 'gen-7',
    startedAt: '2026-09-20T20:09:46.000Z',
    webUrl: 'http://127.0.0.1:4201/',
    hostVersion: '2.0.11',
    lost: [
      {
        id: 'pty_lost',
        title: 'ansible 45-stalwart-guest',
        status: 'exited (lost)',
        lineCount: 141,
        tail: 'PLAY RECAP\nok=38 changed=13 failed=0',
      },
    ],
    archivedCount: 3,
    persistEnabled: true,
    retention: { maxAgeDays: 14, maxSessions: 200 },
  }

  it('names the generation, the UI and what was lost', () => {
    const text = buildRestartNotice(base)

    expect(text).toContain('<pty_restart>')
    expect(text).toContain('Generation: gen-7')
    expect(text).toContain('Host: opencode 2.0.11')
    expect(text).toContain('Web UI: http://127.0.0.1:4201/')
    expect(text).toContain('1 lost, 3 archived')
    expect(text).toContain('pty_lost')
    // The tail is what the model needs to continue sensibly.
    expect(text).toContain('ok=38 changed=13 failed=0')
    expect(text).toContain('keep 14 days / 200 sessions')
    expect(text).toContain('pty_wait')
    expect(text).toContain('</pty_restart>')
  })

  it('says so when archiving is switched off', () => {
    expect(buildRestartNotice({ ...base, persistEnabled: false })).toContain(
      'archiving is disabled'
    )
  })
})

describe('restart marker', () => {
  it('round-trips the announced generation', () => {
    const root = tempRoot()
    try {
      expect(readAnnouncedGeneration(root)).toBeNull()
      writeAnnouncedGeneration(root, 'gen-7', () => {})
      expect(readAnnouncedGeneration(root)).toBe('gen-7')
      expect(announcedGenerationPath(root)).toBe(join(root, 'announced-generation'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('announceRestart', () => {
  function lostStore(): { store: SessionStore; root: string } {
    const root = tempRoot()
    const store = new SessionStore({ root, generation: 'gen-next' })
    store.startSession({ ...sessionInfo(), parentSessionId: 'ses_parent' })
    store.appendOutput('pty_lost', 'PLAY RECAP\nok=38 changed=13 failed=0\n')
    store.flush()
    store.markStaleAsLost()
    return { store, root }
  }

  it('wakes the parent once, with the tail and the UI address', async () => {
    const { store, root } = lostStore()
    const sendNotice = mock(async (_target: unknown, _text: string, _kind: string) => {})
    const notifier = { sendExitNotification: () => {}, sendNotice } as unknown as SessionNotifier

    try {
      await announceRestart({
        store,
        notifier,
        restored: store.list(),
        webUrl: 'http://127.0.0.1:4201/',
        hostVersion: '2.0.11',
      })

      expect(sendNotice).toHaveBeenCalledTimes(1)
      const [target, text, kind] = sendNotice.mock.calls[0] ?? []
      expect((target as { parentSessionId: string }).parentSessionId).toBe('ses_parent')
      expect(kind).toBe('restart')
      expect(text).toContain('<pty_restart>')
      expect(text).toContain('ok=38')
      expect(readAnnouncedGeneration(root)).toBe('gen-next')

      // Second setup of the same boot (several plugin locations): no repeat.
      await announceRestart({ store, notifier, restored: store.list() })
      expect(sendNotice).toHaveBeenCalledTimes(1)
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('marks the generation announced even when no notice can be delivered', async () => {
    const { store, root } = lostStore()

    try {
      // A notifier without `sendNotice` must not retry forever.
      await announceRestart({
        store,
        notifier: { sendExitNotification: () => {} } as unknown as SessionNotifier,
        restored: store.list(),
      })

      expect(readAnnouncedGeneration(root)).toBe('gen-next')
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does nothing when no session was lost', async () => {
    const root = tempRoot()
    const store = new SessionStore({ root, generation: 'gen-quiet' })
    const sendNotice = mock(async (_target: unknown, _text: string, _kind: string) => {})

    try {
      await announceRestart({
        store,
        notifier: { sendExitNotification: () => {}, sendNotice } as unknown as SessionNotifier,
        restored: [],
      })

      expect(sendNotice).not.toHaveBeenCalled()
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
