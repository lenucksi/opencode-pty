import { describe, expect, it } from 'bun:test'

import type { Plugin } from '@opencode/plugin/tui'

import { restartDaemonAction } from '../src/tui/daemon-action.ts'
import type { DaemonStatus } from '../src/tui/daemon-state.ts'

/**
 * The daemon's roll, from the sidebar's footer.
 *
 * The action is asked of the half that owns the client, so what is tested here is
 * the asking: the line says "restarting..." while the roll runs, the answer
 * becomes a toast, and a failure is reported rather than swallowed.
 */

/** A state to watch, and the drafts it was given. */
function state(): { daemon: DaemonStatus; updates: number } {
  return { daemon: { restarting: false, pid: null }, updates: 0 }
}

/** The event the click carries. The action only stops the propagation. */
function mouseEvent(): { stopPropagation: () => void } {
  return { stopPropagation: () => {} }
}

/** The client, with the roll answering whatever the case needs. */
function client(answer: unknown, fail?: Error): Plugin.Context['client'] {
  return {
    rpc: () => ({
      restartDaemon: async () => {
        if (fail) throw fail
        return answer
      },
    }),
  } as unknown as Plugin.Context['client']
}

describe("the daemon's roll", () => {
  it('says the daemon is restarting while the roll runs', async () => {
    const panel = state()
    const toasts: { message: string; variant: string }[] = []
    const action = restartDaemonAction({
      client: client({ restarted: true, oldPid: 100, newPid: 200 }),
      update: (mutate) => {
        panel.updates += 1
        mutate(panel)
      },
      notify: (message, variant) => toasts.push({ message, variant }),
      debug: () => {},
    })

    action(mouseEvent() as never)

    // The line says so before the answer arrives: a roll takes a second or two,
    // and a line that does not move reads as a click that did nothing.
    expect(panel.daemon.restarting).toBe(true)
    await Bun.sleep(10)
    expect(panel.daemon.restarting).toBe(false)
    expect(panel.daemon.pid).toBe(200)
  })

  it('says what the roll did', async () => {
    const toasts: { message: string; variant: string }[] = []
    const action = restartDaemonAction({
      client: client({ restarted: true, oldPid: 100, newPid: 200 }),
      update: (mutate) => mutate(state()),
      notify: (message, variant) => toasts.push({ message, variant }),
      debug: () => {},
    })

    action(mouseEvent() as never)
    await Bun.sleep(10)

    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.message).toContain('old pid 100')
    expect(toasts[0]?.message).toContain('new pid 200')
    expect(toasts[0]?.variant).toBe('success')
  })

  it('says there was nothing to roll', async () => {
    const toasts: { message: string; variant: string }[] = []
    const action = restartDaemonAction({
      client: client({ restarted: false, oldPid: 0, newPid: 0 }),
      update: (mutate) => mutate(state()),
      notify: (message, variant) => toasts.push({ message, variant }),
      debug: () => {},
    })

    action(mouseEvent() as never)
    await Bun.sleep(10)

    expect(toasts[0]?.message).toContain('no PTY daemon to restart')
    expect(toasts[0]?.variant).toBe('warning')
  })

  it('says so when the answer is not one', async () => {
    const toasts: { message: string; variant: string }[] = []
    const action = restartDaemonAction({
      client: client('rolled'),
      update: (mutate) => mutate(state()),
      notify: (message, variant) => toasts.push({ message, variant }),
      debug: () => {},
    })

    action(mouseEvent() as never)
    await Bun.sleep(10)

    expect(toasts[0]?.message).toContain('did not answer')
    expect(toasts[0]?.variant).toBe('warning')
  })

  it('reports a failed roll rather than swallowing it', async () => {
    const toasts: { message: string; variant: string }[] = []
    const panel = state()
    const action = restartDaemonAction({
      client: client(undefined, new Error('the daemon is gone')),
      update: (mutate) => mutate(panel),
      notify: (message, variant) => toasts.push({ message, variant }),
      debug: () => {},
    })

    action(mouseEvent() as never)
    await Bun.sleep(10)

    expect(toasts[0]?.message).toContain('could not be restarted')
    expect(toasts[0]?.message).toContain('the daemon is gone')
    expect(toasts[0]?.variant).toBe('error')
    // The line is not left saying "restarting..." after a failure.
    expect(panel.daemon.restarting).toBe(false)
  })

  it('stops the click from reaching the archive line above it', () => {
    let stopped = false
    const action = restartDaemonAction({
      client: client({ restarted: true, oldPid: 100, newPid: 200 }),
      update: (mutate) => mutate(state()),
      notify: () => {},
      debug: () => {},
    })

    action({
      stopPropagation: () => {
        stopped = true
      },
    } as never)

    expect(stopped).toBe(true)
  })
})
