import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OriginClaim } from '../src/shared/notice.ts'
import { getOrCreateServer, stopActiveServer } from '../src/v2/commands.ts'
import { Plugin } from '../src/v2/index.ts'
import { notifyUser, setNoticeEmitter } from '../src/v2/rpc.ts'
import type { PluginContextV2 } from '../src/v2/types.ts'
import type { WSMessageServer, WSMessageServerNotice } from '../src/web/shared/types.ts'

/**
 * The notices, from the half that makes them to the page that shows them.
 *
 * The chain has three links and they only work together: the plugin's server half
 * raises a notice, the web server publishes it to a topic, and every connected page
 * has subscribed to that topic before any of it happens. A test of any one link
 * alone would pass with the other two broken - which is exactly how a notice ends
 * up in a log instead of on a screen.
 */

/** The plugin's own notice channel, installed the way `setup` installs it. */
async function installNoticeChannel(): Promise<void> {
  const ctx: PluginContextV2 = {
    options: {},
    rpc: {
      register: async () => ({ events: { emit: async () => {} } }),
    } as unknown as PluginContextV2['rpc'],
  }
  await Plugin.setup(ctx)
}

/** Everything the socket received, in order. */
function collect(socket: WebSocket): { messages: WSMessageServer[]; close: () => void } {
  const messages: WSMessageServer[] = []
  socket.onmessage = (event) => {
    messages.push(JSON.parse(String(event.data)) as WSMessageServer)
  }
  return { messages, close: () => socket.close() }
}

/** Wait until `check` says so, or fail with what arrived. */
async function until(check: () => boolean, messages: WSMessageServer[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error(`no such message arrived; got ${JSON.stringify(messages)}`)
}

describe('notices reach the page', () => {
  let previousRuntimeDir: string | undefined
  let runtimeDir: string

  beforeEach(() => {
    // The daemon is shared per machine, and the notice test must not depend on
    // whether this machine happens to run one.
    previousRuntimeDir = process.env.XDG_RUNTIME_DIR
    runtimeDir = mkdtempSync(join(tmpdir(), 'opencode-pty-notice-'))
    process.env.XDG_RUNTIME_DIR = runtimeDir
  })

  afterEach(async () => {
    setNoticeEmitter(null)
    stopActiveServer()
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir
    rmSync(runtimeDir, { recursive: true, force: true })
  })

  it('carries a notice from the plugin half to every connected page', async () => {
    const server = await getOrCreateServer()
    await installNoticeChannel()

    const socket = new WebSocket(server.getWsUrl())
    await new Promise((resolve) => {
      socket.onopen = resolve
    })
    const page = collect(socket)

    try {
      notifyUser('PTY daemon restarted: old pid 1, new pid 2.', 'success', 'page-roll-9')

      await until(() => page.messages.some((message) => message.type === 'notice'), page.messages)

      const notice = page.messages.find(
        (message) => message.type === 'notice'
      ) as WSMessageServerNotice
      expect(notice.message).toContain('new pid 2')
      expect(notice.variant).toBe('success')
      // The mark the page sent with its request comes back with the notice, which is
      // what lets that page recognise its own and stay quiet.
      expect(notice.origin).toBe('page-roll-9')
    } finally {
      page.close()
    }
  })

  it('sends a notice without a mark when nobody claimed the action', async () => {
    const server = await getOrCreateServer()
    await installNoticeChannel()

    const socket = new WebSocket(server.getWsUrl())
    await new Promise((resolve) => {
      socket.onopen = resolve
    })
    const page = collect(socket)

    try {
      notifyUser('a command a human typed', 'info')

      await until(() => page.messages.some((message) => message.type === 'notice'), page.messages)

      const notice = page.messages.find(
        (message) => message.type === 'notice'
      ) as WSMessageServerNotice
      expect(notice.message).toBe('a command a human typed')
      expect(notice).not.toHaveProperty('origin')
    } finally {
      page.close()
    }
  })
})

describe('the mark an action carries', () => {
  it('hands out one id per action, and recognises each exactly once', () => {
    let counter = 0
    const claim = new OriginClaim(() => `id-${++counter}`)

    const first = claim.start()
    const second = claim.start()

    expect(first).toBe('id-1')
    expect(second).toBe('id-2')
    // Recognised once, and only once: a second notice with the same mark is not
    // this surface's, and dropping it would swallow somebody else's roll.
    expect(claim.owns(first)).toBe(true)
    expect(claim.owns(first)).toBe(false)
  })

  it('owns nothing when the notice carries no mark', () => {
    const claim = new OriginClaim()
    expect(claim.owns(undefined)).toBe(false)
  })

  it('does not remember marks forever', () => {
    let counter = 0
    const claim = new OriginClaim(() => `id-${++counter}`, 2)

    const forgotten = claim.start()
    claim.start()
    claim.start()

    expect(claim.owns(forgotten)).toBe(false)
  })
})
