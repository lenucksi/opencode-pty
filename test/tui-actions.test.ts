import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@opencode/plugin/tui'
import { RGBA } from '@opentui/core'
import { manager } from '../src/plugin/pty/manager.ts'
import { ptySpawn } from '../src/plugin/pty/tools/spawn.ts'
import { type ActionDeps, type Actions, createActions } from '../src/tui/actions.ts'
import type { PanelSession } from '../src/tui/lib.ts'
import { initialPanelState, type PanelState } from '../src/tui/panel-state.ts'
import { readScreen } from '../src/tui/server.ts'
import { PTYServer } from '../src/web/server/server.ts'

/**
 * What a person can do to a session from the panel.
 *
 * Against a real PTY server, so the questions here are the ones that matter: does
 * the removal actually remove it, does the running case really ask first, and does
 * a dialog that failed to open leave nothing behind.
 */

interface Recorded {
  toasts: { message: string; variant?: string }[]
  confirms: { title: string; message: string }[]
  dialogs: { closed: boolean; size?: string }[]
  /** The prompt titles asked for, and what the reader typed back. */
  prompts: { title: string; typed?: string }[]
  refreshes: { mayStart?: boolean; force?: boolean }[]
  events: string[]
}

let runtimeDir: string
let project: string
let previousRuntimeDir: string | undefined
let server: PTYServer | null = null
let recorded: Recorded

const origin = (): string => `http://127.0.0.1:${server?.server.port ?? 0}`

const tones = {
  base: RGBA.fromHex('#d8dee9'),
  muted: RGBA.fromHex('#7b8494'),
  success: RGBA.fromHex('#a3be8c'),
  error: RGBA.fromHex('#bf616a'),
  border: RGBA.fromHex('#3b4252'),
  raised: RGBA.fromHex('#242832'),
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'pty-tui-actions-runtime-'))
  project = realpathSync(mkdtempSync(join(tmpdir(), 'pty-tui-actions-project-')))
  previousRuntimeDir = process.env.PTY_RUNTIME_DIR
  process.env.PTY_RUNTIME_DIR = runtimeDir
  recorded = { toasts: [], confirms: [], dialogs: [], prompts: [], refreshes: [], events: [] }
})

afterEach(() => {
  manager.clearAllSessions()
  if (server !== null) {
    server[Symbol.dispose]()
    server = null
  }
  if (previousRuntimeDir === undefined) delete process.env.PTY_RUNTIME_DIR
  else process.env.PTY_RUNTIME_DIR = previousRuntimeDir
  rmSync(runtimeDir, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

async function startServer(): Promise<void> {
  server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
}

async function spawnSession(title: string, command = 'true', args: string[] = []): Promise<string> {
  const started = await ptySpawn.execute(
    { command, args, title, description: 'tui actions test' },
    {
      sessionID: 'test-parent-session',
      messageID: 'msg-1',
      agent: 'test-agent',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
      directory: '/tmp',
      worktree: '/tmp',
    }
  )
  const output = typeof started === 'string' ? started : started.output
  const id = /id="(pty_[0-9a-f]+)"/.exec(output)?.[1]
  if (!id) throw new Error(`the spawn returned no id: ${output.slice(0, 120)}`)
  return id
}

/**
 * Wait until the session has actually stopped, or give up.
 *
 * Waiting for an archive ENTRY is not enough: the store indexes a live session too,
 * so that returns while the process is still running and its buffer file is still
 * empty. The buffer is only flushed on the way out, so the wait has to be for the
 * status - otherwise the buffer assertions below are races.
 */
async function waitForArchived(id: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const entry = manager.getSessionStore().get(id)
    if (entry !== null && entry.status !== 'running' && entry.status !== 'killing') return
    await Bun.sleep(20)
  }
  throw new Error(`die Sitzung ${id} wurde nie beendet`)
}

/**
 * A context carrying only what the actions touch.
 *
 * The panel reaches eight members of a context the SDK declares in dozens, and a
 * fixture that implemented the rest would be a second, drifting copy of it. The
 * cast is here, once, for that reason - and it fails loudly on anything the actions
 * newly reach, because an unimplemented member throws rather than answering.
 */
function fixture(): Plugin.Context {
  const ui = {
    slot: () => () => {},
    toast: {
      show: (options: { message: string; variant?: string }): void => {
        recorded.toasts.push(options)
      },
    },
    dialog: {
      show: (): void => {
        recorded.dialogs.push({ closed: false })
      },
      set: (options: { size?: string }): void => {
        const open = recorded.dialogs.at(-1)
        if (open) open.size = options.size
      },
      clear: (): void => {},
      // Always the cancel answer unless a case overrides it, which keeps the
      // "asked and declined" path the default rather than a special case.
      confirm: async (options: { title: string; message: string }) => {
        recorded.confirms.push(options)
        return false
      },
      // Declined by default, like confirm, so "asked and abandoned" is the default path and
      // a case that sends has to say so. `typed` is what the host's own field would return.
      prompt: async (options: { title: string }) => {
        recorded.prompts.push({ title: options.title })
        return undefined
      },
    },
    router: { register: () => () => {}, navigate: () => {}, current: () => ({ type: 'home' }) },
    panel: { open: () => false, close: () => {}, current: () => undefined },
    tabs: {
      enabled: () => false,
      list: () => [],
      open: () => false,
      focus: () => false,
      move: () => false,
      close: () => false,
    },
    model: { current: () => undefined, variant: { list: () => [], set: () => false } },
    format: { path: (value: string) => value },
  }
  const context = {
    options: {},
    location: { directory: project },
    app: { version: '2.0.23', channel: 'dev' },
    renderer: { height: 40, width: 120, clearSelection: () => {} },
    client: {},
    theme: {
      text: {
        base: tones.base,
        muted: tones.muted,
        feedback: {
          success: { base: tones.success },
          error: { base: tones.error },
        },
      },
      border: { base: tones.border },
      background: { raised: { base: tones.raised } },
    },
    themeMode: 'dark',
    ui,
  }
  return context as unknown as Plugin.Context
}

function deps(state: PanelState, over: Partial<ActionDeps> = {}): ActionDeps {
  return {
    context: fixture(),
    state,
    update: (mutate) => mutate(state),
    refresh: async (mayStart?: boolean, force?: boolean) => {
      recorded.refreshes.push({ mayStart, force })
    },
    notify: (message, variant) => {
      recorded.toasts.push({ message, variant })
    },
    directory: () => project,
    debug: (event) => {
      recorded.events.push(event)
    },
    // The real wiring reads these off the same resolved theme the sidebar view uses, so
    // the fixture hands over the same six values rather than a second palette that could
    // drift from it.
    tones: () => tones,
    ...over,
  }
}

function liveState(over: Partial<PanelState> = {}): PanelState {
  return { ...initialPanelState(), ...over }
}

const session = (over: Partial<PanelSession> = {}): PanelSession => ({ id: 'pty_1', ...over })

describe('removing a session', () => {
  test('removes it from the server and says so', async () => {
    await startServer()
    const id = await spawnSession('doomed')
    const state = liveState({ origin: origin(), sessions: [session({ id, title: 'doomed' })] })
    const actions = createActions(deps(state))

    await actions.removeSession(session({ id, title: 'doomed' }))

    const remaining = await fetch(`${origin()}/api/sessions`).then((r) => r.json())
    expect(JSON.stringify(remaining)).not.toContain(id)
    expect(recorded.toasts.map((t) => t.message)).toContain('Removed doomed')
  })

  test('re-lists at once, because the user is waiting for the row to go', async () => {
    await startServer()
    const id = await spawnSession('doomed')
    const state = liveState({ origin: origin(), sessions: [session({ id })] })

    await createActions(deps(state)).removeSession(session({ id }))

    expect(recorded.refreshes.at(-1)).toEqual({ mayStart: false, force: true })
  })

  // A failed removal that reported success would be worse than no report: the row
  // stays and the user has been told it went.
  test('reports a refusal as a failure, and does not claim success', async () => {
    await startServer()
    const state = liveState({ origin: origin() })
    const actions = createActions(deps(state))

    await actions.removeSession(session({ id: 'pty_does_not_exist', title: 'ghost' }))

    const messages = recorded.toasts.map((t) => t.message)
    expect(messages.some((m) => m.startsWith('Could not remove ghost'))).toBe(true)
    expect(messages).not.toContain('Removed ghost')
  })

  test('says the server is unavailable rather than failing silently', async () => {
    const state = liveState({ origin: null })
    await createActions(deps(state)).removeSession(session({ id: 'a' }))
    expect(recorded.toasts.map((t) => t.message)).toEqual(['PTY server unavailable'])
  })
})

describe('confirming a removal', () => {
  test('asks before killing a running process', () => {
    const state = liveState()
    const actions = createActions(deps(state))
    actions.confirmRemove(session({ id: 'a', title: 'dev', status: 'running' }))
    expect(recorded.confirms).toHaveLength(1)
    expect(recorded.confirms[0]?.message).toContain('dev')
    // The word "kill" is the whole warning.
    expect(recorded.confirms[0]?.title).toContain('Remove PTY session')
  })

  // Asking about a session that is only a record presents a question with one sane
  // answer, and trains the reader to click through dialogs.
  test('acts at once on a finished session, with no question', () => {
    const state = liveState()
    const actions = createActions(deps(state))
    actions.confirmRemove(session({ id: 'a', status: 'exited' }))
    expect(recorded.confirms).toHaveLength(0)
    expect(recorded.events).toContain('row.remove')
  })

  // A killing session has been asked to die already; cleanup only drops the record.
  test('acts at once on a killing session too', () => {
    const state = liveState()
    const actions = createActions(deps(state))
    actions.confirmRemove(session({ id: 'a', status: 'killing' }))
    expect(recorded.confirms).toHaveLength(0)
  })

  test('does nothing when the question is answered with cancel', async () => {
    await startServer()
    const id = await spawnSession('kept')
    const state = liveState({ origin: origin(), sessions: [session({ id })] })
    const depsWithCancel = deps(state)
    const actions = createActions(depsWithCancel)

    // The fixture's confirm resolves false, which is the cancel answer.
    actions.confirmRemove(session({ id, status: 'running' }))
    await Bun.sleep(20)

    expect(recorded.toasts).toEqual([])
    const remaining = await fetch(`${origin()}/api/sessions`).then((r) => r.json())
    expect(JSON.stringify(remaining)).toContain(id)
  })

  test('removes once the question is answered with confirm', async () => {
    await startServer()
    const id = await spawnSession('confirmed')
    const state = liveState({ origin: origin(), sessions: [session({ id })] })
    const withConfirm = deps(state)
    withConfirm.context.ui.dialog.confirm = (async () => true) as never
    const actions = createActions(withConfirm)

    actions.confirmRemove(session({ id, status: 'running' }))
    await Bun.sleep(60)

    const remaining = await fetch(`${origin()}/api/sessions`).then((r) => r.json())
    expect(JSON.stringify(remaining)).not.toContain(id)
  })
})

describe('clearing finished sessions', () => {
  test('removes every finished session and leaves the running one', async () => {
    await startServer()
    const gone = await spawnSession('one')
    const alsoGone = await spawnSession('two')
    const alive = await spawnSession('alive', 'sleep', ['30'])

    const state = liveState({
      origin: origin(),
      sessions: [
        session({ id: gone, status: 'exited' }),
        session({ id: alsoGone, status: 'killed' }),
        session({ id: alive, status: 'running' }),
      ],
    })
    await createActions(deps(state)).clearFinished()

    const remaining = await fetch(`${origin()}/api/sessions`).then((r) => r.json())
    const ids = (remaining as PanelSession[]).map((s) => s.id)
    expect(ids).not.toContain(gone)
    expect(ids).not.toContain(alsoGone)
    expect(ids).toContain(alive)
  })

  test('does nothing, and says nothing, when there is nothing finished', async () => {
    await startServer()
    const state = liveState({ origin: origin(), sessions: [session({ status: 'running' })] })
    await createActions(deps(state)).clearFinished()
    expect(recorded.toasts).toEqual([])
    expect(recorded.refreshes).toEqual([])
  })

  test('re-lists once, for the user who clicked', async () => {
    await startServer()
    const id = await spawnSession('gone')
    const state = liveState({ origin: origin(), sessions: [session({ id, status: 'exited' })] })
    await createActions(deps(state)).clearFinished()
    expect(recorded.refreshes.at(-1)).toEqual({ mayStart: false, force: true })
  })
})

describe('opening the output dialog', () => {
  test('shows the buffer, sized from the terminal, and records the state', async () => {
    await startServer()
    const id = await spawnSession('watched', 'printf', ['hallo\n'])
    // The archive is written when the process ends. Opening before that reads an
    // empty buffer, which would make this a race rather than an assertion.
    await waitForArchived(id)
    const state = liveState({ origin: origin(), sessions: [session({ id, status: 'exited' })] })

    await createActions(deps(state)).openOutput(session({ id, title: 'watched' }))

    expect(recorded.dialogs).toHaveLength(1)
    expect(state.dialog?.id).toBe(id)
    expect(state.dialog?.output).toContain('hallo')
    // 120 columns is the "large" band; anything narrower would have overflowed.
    expect(recorded.dialogs[0]?.size).toBe('large')
  })

  test('says so rather than opening an empty dialog when the server is gone', async () => {
    const state = liveState({ origin: null })
    await createActions(deps(state)).openOutput(session({ id: 'a' }))
    expect(recorded.dialogs).toEqual([])
    expect(recorded.toasts.map((t) => t.message)).toEqual(['PTY server unavailable'])
    expect(state.dialog).toBeNull()
  })

  // The buffer of one session shown by the next reads as the plugin reading the
  // wrong session, so a closed dialog keeps nothing.
  test('clears its state when the dialog is closed', async () => {
    await startServer()
    const id = await spawnSession('watched', 'printf', ['x\n'])
    await waitForArchived(id)
    const state = liveState({ origin: origin(), sessions: [session({ id })] })
    const closeDials = deps(state)
    let onClose: (() => void) | undefined
    // The second argument IS the close handler the panel registers; ignoring it
    // would make this test assert against a dialog nothing ever closes.
    closeDials.context.ui.dialog.show = ((_: unknown, close?: () => void) => {
      recorded.dialogs.push({ closed: false })
      onClose = (): void => {
        const open = recorded.dialogs.at(-1)
        if (open) open.closed = true
        close?.()
      }
    }) as never

    await createActions(closeDials).openOutput(session({ id }))
    expect(state.dialog?.output).toContain('x')

    onClose?.()
    expect(state.dialog).toBeNull()
  })

  test('reports an unreadable buffer instead of showing nothing', async () => {
    await startServer()
    const state = liveState({ origin: origin(), sessions: [] })
    await createActions(deps(state)).openOutput(session({ id: 'pty_does_not_exist' }))
    expect(state.dialog?.output).toContain('failed to read buffer')
  })
})

describe('sending input to a session', () => {
  /**
   * A context whose prompt answers with `typed`, the way the host's own field would.
   *
   * Built before `deps` because `ActionDeps.context` is readonly - the fixture goes in
   * through the override argument rather than by assignment.
   */
  function answering(typed: string | undefined): Plugin.Context {
    const context = fixture()
    context.ui.dialog.prompt = async (options: { title: string }) => {
      recorded.prompts.push({ title: options.title, typed })
      return typed
    }
    return context
  }

  /**
   * Lines that hold nothing but a line number.
   *
   * The screen capture trims each line, so "an empty numbered line" arrives as `     2`
   * with no trailing spaces - which is why an assertion on `'2  '` passed on exactly the
   * code it was meant to catch. Matching a number alone survives the trim, and is what the
   * doubled-newline and blank-line cases actually produce.
   */
  const numberOnlyLines = (screen: string): string[] =>
    screen.split('\n').filter((line) => /^\s*\d+\s*$/.test(line))

  /** Wait until `check` yields a value, or give up. Keeps the tests sleep-free. */
  async function until(check: () => Promise<boolean>, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await check()) return true
      await Bun.sleep(25)
    }
    return false
  }

  // The whole point, proven against a real process: what the reader types arrives as if
  // typed. `cat` echoes it, so the assertion reads the echo off the program's own screen
  // rather than trusting that a POST was made - a route that accepted the request without
  // writing it to the PTY would pass every other version of this test.
  test('what the reader types reaches the process', async () => {
    await startServer()
    const id = await spawnSession('waiting', 'cat')
    const d = deps(liveState({ origin: origin() }), { context: answering('q') })

    await createActions(d).sendInput(session({ id, title: 'waiting', status: 'running' }))

    expect(await until(async () => (await readScreen(origin(), id)).includes('q'))).toBe(true)
  })

  // A reader who types `q` means the key, not a prompt line, so the newline is added here.
  test('appends the newline a key press would have carried', async () => {
    await startServer()
    const id = await spawnSession('lines', 'cat', ['-n'])
    const d = deps(liveState({ origin: origin() }), { context: answering('one\ntwo') })

    await createActions(d).sendInput(session({ id, status: 'running' }))

    // `cat -n` numbers every line, which only happens if BOTH newlines arrived - so the
    // appended one and the typed one are both proven, not just the first. It pads the
    // number to six columns and separates it with TWO SPACES, measured, not a tab.
    expect(await until(async () => (await readScreen(origin(), id)).includes('2  two'))).toBe(true)
    const screen = await readScreen(origin(), id)
    expect(screen).toContain('1  one')
    expect(screen).toContain('2  two')
  })

  // A line that already carries its own newline is sent as it stands, so a deliberate empty
  // Enter stays possible. Appending again would send a blank line the reader did not ask for.
  test('does not double a newline the reader already typed', async () => {
    await startServer()
    const id = await spawnSession('once', 'cat', ['-n'])
    const d = deps(liveState({ origin: origin() }), { context: answering('only\n') })

    await createActions(d).sendInput(session({ id, status: 'running' }))

    expect(await until(async () => (await readScreen(origin(), id)).includes('1  only'))).toBe(true)
    await Bun.sleep(200)
    // `cat -n` numbers every line it received, so a doubled newline would have produced a
    // second line holding nothing but its number.
    expect(numberOnlyLines(await readScreen(origin(), id))).toEqual([])
  })

  // Declining is the common case - Escape in the host's field - and it must not write.
  test('writes nothing when the reader declines', async () => {
    await startServer()
    const id = await spawnSession('ignored', 'cat', ['-n'])
    const d = deps(liveState({ origin: origin() }), { context: answering(undefined) })

    await createActions(d).sendInput(session({ id, status: 'running' }))

    expect(recorded.prompts).toHaveLength(1)
    await Bun.sleep(200)
    expect(numberOnlyLines(await readScreen(origin(), id))).toEqual([])
  })

  // A confirmation of something that did not happen is worse than silence: the reader
  // presses Escape, is told it was sent, and then wonders why the program ignored them.
  test('claims nothing was sent when the reader declines', async () => {
    await startServer()
    const id = await spawnSession('declined', 'cat', ['-n'])
    const d = deps(liveState({ origin: origin() }), { context: answering(undefined) })
    await createActions(d).sendInput(session({ id, title: 'declined', status: 'running' }))
    expect(recorded.toasts).toEqual([])
  })

  test('confirms a line that really was sent', async () => {
    await startServer()
    const id = await spawnSession('sent', 'cat')
    const d = deps(liveState({ origin: origin() }), { context: answering('q') })
    await createActions(d).sendInput(session({ id, title: 'sent', status: 'running' }))
    expect(recorded.toasts.map((t) => t.message)).toEqual(['Sent to sent'])
  })

  // Nothing to write to. Asking first would open a field that cannot work, and the server
  // would answer 400 for every attempt.
  test('refuses a session that has ended, without asking', async () => {
    const d = deps(liveState({ origin: origin() }), { context: answering('q') })
    await createActions(d).sendInput(session({ id: 'pty_1', status: 'exited', exitCode: 0 }))
    expect(recorded.prompts).toEqual([])
    expect(recorded.toasts.map((t) => t.message)).toEqual(['That session has ended'])
  })

  test('asks nothing when the server is gone', async () => {
    const d = deps(liveState({ origin: null }), { context: answering('q') })
    await createActions(d).sendInput(session({ id: 'pty_1', status: 'running' }))
    expect(recorded.prompts).toEqual([])
    expect(recorded.toasts.map((t) => t.message)).toEqual(['PTY server unavailable'])
  })

  // The prompt names the session, because "send what?" has no other answer on screen.
  test('names the session in the prompt', async () => {
    await startServer()
    const id = await spawnSession('the watcher', 'cat')
    const d = deps(liveState({ origin: origin() }), { context: answering(undefined) })
    await createActions(d).sendInput(session({ id, title: 'the watcher', status: 'running' }))
    expect(recorded.prompts[0]?.title).toBe('Send to the watcher')
  })

  // A whitespace-only line is not a key press and not a command; sending it would put a
  // blank line into a program that may well act on it.
  test('does not send a blank line', async () => {
    await startServer()
    const id = await spawnSession('blank', 'cat', ['-n'])
    const d = deps(liveState({ origin: origin() }), { context: answering('   ') })
    await createActions(d).sendInput(session({ id, status: 'running' }))
    await Bun.sleep(200)
    // A blank line sent to `cat -n` comes back as a line holding only the number 1.
    expect(numberOnlyLines(await readScreen(origin(), id))).toEqual([])
  })
})

describe('the header’s clear handler', () => {
  // Without stopping propagation the click would also collapse the panel, hiding the
  // very list it is cleaning.
  test('stops the click so it cannot also toggle the panel', async () => {
    await startServer()
    const id = await spawnSession('gone')
    const state = liveState({ origin: origin(), sessions: [session({ id, status: 'exited' })] })
    const actions: Actions = createActions(deps(state))

    let stopped = false
    actions.onClear({
      stopPropagation: () => {
        stopped = true
      },
    } as never)
    await Bun.sleep(30)

    expect(stopped).toBe(true)
    const remaining = await fetch(`${origin()}/api/sessions`).then((r) => r.json())
    expect(JSON.stringify(remaining)).not.toContain(id)
  })
})
