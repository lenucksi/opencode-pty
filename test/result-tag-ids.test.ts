import { afterAll, describe, expect, it } from 'bun:test'

import { manager } from '../src/plugin/pty/manager.ts'
import { buildExitNotification } from '../src/plugin/pty/notification-manager.ts'
import { ptyKill } from '../src/plugin/pty/tools/kill.ts'
import { ptyRead } from '../src/plugin/pty/tools/read.ts'
import { ptyResize } from '../src/plugin/pty/tools/resize.ts'
import { ptyScreen } from '../src/plugin/pty/tools/screen.ts'
import { ptySpawn } from '../src/plugin/pty/tools/spawn.ts'
import { ptyWait } from '../src/plugin/pty/tools/wait.ts'

/**
 * Every result tag that concerns one session carries that session's id as an
 * attribute.
 *
 * This exists because the tags drifted apart. `pty_read`, `pty_screen`,
 * `pty_resize` and `pty_wait` reported `id="..."` on the tag; `pty_spawn`,
 * `pty_kill`, `pty_wait_timeout`, `pty_exited` and `pty_session_lost` put the
 * same value in a prose `ID:` line and left the tag bare. A model that learned
 * the convention from the first four looked for `id="..."` in a spawn result,
 * found none, and reported that spawn returns no id. It was not wrong to look:
 * four of the seven tags answered that shape.
 *
 * The damage is not evenly spread. `pty_exited` and `pty_session_lost` arrive
 * without the model having called anything, so the tag is the only place the id
 * can come from, and a model with several sessions running has no other way to
 * tell which one finished.
 */

const ctx = {
  sessionID: 'parent',
  messageID: 'msg',
  agent: 'agent',
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
  directory: '/tmp',
  worktree: '/tmp',
}

/** The opening tag of a result, e.g. `<pty_output id="pty_1" status="running">`. */
function openingTag(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result)
  const match = /<(pty_[a-z_]+)([^>]*)>/.exec(text)
  if (!match) throw new Error(`no pty tag in result: ${text.slice(0, 200)}`)
  return match[0] ?? ''
}

function text(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result)
}

describe('result tags carry the session id as an attribute', () => {
  const spawned: string[] = []

  afterAll(() => {
    for (const id of spawned) manager.kill(id, true)
    manager.clearAllSessions()
  })

  function probe(args: string[]): string {
    const info = manager.spawn({
      command: 'sh',
      args,
      description: 'tag probe',
      parentSessionId: 'tag-test',
    })
    spawned.push(info.id)
    return info.id
  }

  it('reports the id on the spawn tag, not only in the prose below it', async () => {
    const result = await ptySpawn.execute(
      { command: 'sh', args: ['-c', 'sleep 5'], description: 'tag probe' },
      ctx
    )
    const tag = openingTag(result)
    const id = /id="(pty_[0-9a-f]+)"/.exec(tag)?.[1]
    if (!id) throw new Error(`spawn tag has no id attribute: ${tag}`)
    spawned.push(id)

    // The id on the tag is the one the model must pass to every other call, so it
    // has to be there and has to be the real id, not a placeholder. Geometry rides
    // along for the same reason: `pty_resize` and `pty_screen` report `cols`/`rows`
    // as attributes, and a model that learned that from them gets prose here.
    expect(tag).toContain(`id="${id}"`)
    expect(tag).toMatch(/cols="\d+"/)
    expect(tag).toMatch(/rows="\d+"/)
    expect(text(result)).toContain(`ID: ${id}`)
  })

  it('reports the id on the read tag', async () => {
    const id = probe(['-c', 'printf "hi\\r\\n"; sleep 5'])
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(openingTag(await ptyRead.execute({ id }, ctx))).toContain(`id="${id}"`)
  })

  it('reports the id on the screen tag', async () => {
    const id = probe(['-c', 'printf "hi\\r\\n"; sleep 5'])
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(openingTag(await ptyScreen.execute({ id }, ctx))).toContain(`id="${id}"`)
  })

  it('reports the id on the resize tag', async () => {
    const id = probe(['-c', 'sleep 5'])
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(openingTag(await ptyResize.execute({ id, cols: 90 }, ctx))).toContain(`id="${id}"`)
  })

  it('reports the id on the wait tag', async () => {
    // Short sleep so the suite is not dominated by a process that has to expire.
    const id = probe(['-c', 'sleep 1'])
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(openingTag(await ptyWait.execute({ id, timeoutSeconds: 20 }, ctx))).toContain(
      `id="${id}"`
    )
  })

  it('reports the id on the wait-timeout tag', async () => {
    // The timeout branch, not the success branch: a model that gives up waiting
    // then calls pty_read, pty_kill or pty_wait again with the same id.
    const id = probe(['-c', 'sleep 30'])
    await new Promise((resolve) => setTimeout(resolve, 200))

    const result = await ptyWait.execute({ id, timeoutSeconds: 0 }, ctx)

    expect(openingTag(result)).toBe(`<pty_wait_timeout id="${id}">`)
  })

  it('reports the id on the kill tag', async () => {
    const id = probe(['-c', 'sleep 30'])
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(openingTag(await ptyKill.execute({ id }, ctx))).toBe(`<pty_killed id="${id}">`)
  })

  it('reports the id on the exit-notification tag', () => {
    // Arrives with no call in flight, so the tag is the only source.
    const id = probe(['-c', 'printf "done\\r\\n"; sleep 5'])
    const session = manager.getSession(id)
    if (!session) throw new Error(`session ${id} vanished`)

    const tag = openingTag(buildExitNotification(session, 0))

    expect(tag).toBe(`<pty_exited id="${id}">`)
  })
})
