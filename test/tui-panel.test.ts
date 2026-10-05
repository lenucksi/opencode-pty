import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Plugin } from '@opencode/plugin/tui'
import { testRender } from '@opentui/solid'
import type { TestRendererSetup } from '@opentui/core/testing'
import { RGBA } from '@opentui/core'

import tuiPanel from '../src/tui/index.ts'
import { manager } from '../src/plugin/pty/manager.ts'
import { ptySpawn } from '../src/plugin/pty/tools/spawn.ts'
import { PTYServer } from '../src/web/server/server.ts'

/**
 * The panel, end to end, without a terminal.
 *
 * A real PTY server serves `/health` and `/api/sessions`; the real origin record
 * is written to a temporary runtime directory; the real plugin finds it, lists the
 * sessions and renders the sidebar through opentui's headless test renderer. So
 * what is asserted here is what a human would read in the sidebar.
 *
 * ## What this cannot cover, and why that is not a gap in the test
 *
 * Reactivity. The host loads a TUI plugin with a plain `import()`, so the plugin
 * resolves `solid-js` to its `node` export condition - `dist/server.js`, where
 * reactivity is a no-op. The reconciler inside `@opentui/solid` imports the client
 * build directly, so its accessor machinery is live while a plugin-created signal
 * would not be. Everything the panel shows therefore lives in
 * `context.storage`, which the host creates with its own solid instance.
 *
 * Re-propagating a store write into a re-render is that host's contract, and the
 * fixture below cannot reproduce it - a plain object models "what the panel
 * reads" exactly and "how the host makes it re-render" not at all. So the state
 * transitions are asserted on the store, and the rendering on the tree. Both are
 * real; the seam between them belongs to opencode.
 */

/**
 * The claim types, derived from the SDK's own signature rather than imported from
 * an internal module path.
 *
 * `SlotClaim` is a union over every slot path, each carrying its own input type,
 * so `.render` cannot be called on it without narrowing to the path that was
 * registered. The plugin gets that narrowing for free from its object literal;
 * a fixture that stores the claim has to ask for it, which is why this is
 * `Extract<..., { append: 'sidebar.content' }>` and not a cast.
 */
type SlotClaim = Parameters<Plugin.Context['ui']['slot']>[0]
type SidebarClaim = Extract<SlotClaim, { readonly append: 'sidebar.content' }>
type TuiContext = Plugin.Context

interface Toast {
  message: string
  variant?: string
}

interface RenderedClaim {
  claim: SidebarClaim
  input: { readonly sessionID: string }
}

/** Everything the fixture observed the plugin doing. */
interface Observed {
  claims: RenderedClaim[]
  toasts: Toast[]
  dialogs: { close?: () => void }[]
  confirms: { title: string; message: string }[]
  /** `create`, `command`, `remove` — in order. */
  sessionCalls: string[]
  /** Stands in for the server-side effect of `pty-show-server-url`. */
  onCommand?: () => Promise<void>
  /** The live store values, by key. */
  stores: Map<string, Record<string, unknown>>
}

let runtimeDir: string
let project: string
let previousRuntimeDir: string | undefined

/**
 * A theme carrying the six colour slots the panel reads, with real `RGBA` values.
 *
 * The real resolver wants a full nine-step hue scale per semantic hue, expressed
 * as hues rather than as hex - none of which is what these tests are about. One
 * cast here, in the fixture, beats a second copy of the theme system that drifts
 * from it. If the panel ever reads a slot that is missing here, the render throws
 * rather than quietly drawing in the wrong colour.
 */
function panelTheme(): TuiContext['theme'] {
  const theme = {
    text: {
      base: RGBA.fromHex('#d8dee9'),
      muted: RGBA.fromHex('#7b8494'),
      feedback: {
        success: { base: RGBA.fromHex('#a3be8c'), muted: RGBA.fromHex('#7b8494') },
        error: { base: RGBA.fromHex('#bf616a'), muted: RGBA.fromHex('#7b8494') },
        warning: { base: RGBA.fromHex('#ebcb8b'), muted: RGBA.fromHex('#7b8494') },
        info: { base: RGBA.fromHex('#88c0d0'), muted: RGBA.fromHex('#7b8494') },
      },
    },
    background: {
      base: RGBA.fromHex('#1c1f26'),
      raised: {
        base: RGBA.fromHex('#242832'),
        high: RGBA.fromHex('#2e3440'),
        max: RGBA.fromHex('#3b4252'),
      },
    },
    border: { base: RGBA.fromHex('#3b4252') },
  }
  return theme as unknown as TuiContext['theme']
}

function makeContext(observed: Observed): TuiContext {
  // A store is modelled as the object plus a mutator that applies the draft. That
  // is exactly what the panel reads; see the file header for what it cannot model.
  const store = <Value extends object>(key: string, options: { initial: Value }) => {
    observed.stores.set(key, options.initial as Record<string, unknown>)
    const pair: readonly [Value, (mutation: (draft: Value) => void) => void] = [
      options.initial,
      (mutation) => mutation(options.initial),
    ]
    return pair
  }

  const client = {
    session: {
      create: async (): Promise<{ id: string }> => {
        observed.sessionCalls.push('create')
        return { id: 'scratch-session' }
      },
      command: async (): Promise<void> => {
        observed.sessionCalls.push('command')
        // What the plugin's own command does in the server process: bind, and
        // publish the record. A stub that only recorded the call would leave the
        // bootstrap's second half - finding the server again - untested.
        if (observed.onCommand !== undefined) await observed.onCommand()
      },
      remove: async (): Promise<void> => {
        observed.sessionCalls.push('remove')
      },
    },
  }

  const ui = {
    slot: (claim: SlotClaim): (() => void) => {
      // Only the sidebar claim is exercised here, and the fixture must record it
      // with its input type attached - see SidebarClaim.
      if ('append' in claim && claim.append === 'sidebar.content') {
        observed.claims.push({ claim, input: { sessionID: 'session-1' } })
      }
      return () => {}
    },
    toast: {
      show: (options: Toast): void => {
        observed.toasts.push(options)
      },
    },
    dialog: {
      show: (): void => {
        observed.dialogs.push({})
      },
      set: (): void => {},
      clear: (): void => {},
      confirm: async (options: { title: string; message: string }) => {
        observed.confirms.push(options)
        return false
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
    client,
    theme: panelTheme(),
    themeMode: 'dark',
    ui,
    storage: { store, memory: store },
    data: undefined,
    attention: { notify: async () => ({ ok: true, notification: false, sound: false }) },
    markdown: { registerCodeBlockRenderer: () => () => {} },
    keymap: {
      layer: () => {},
      dispatch: () => {},
      shortcuts: () => [],
      commands: () => [],
      pending: () => [],
      active: () => [],
      mode: { current: () => 'base', push: () => () => {} },
    },
  }

  // The panel touches a fraction of the context. Filling in the rest here would be
  // a second copy of the SDK that drifts from it; this names exactly what is real.
  return context as unknown as TuiContext
}

function observed(onCommand?: () => Promise<void>): Observed {
  return {
    claims: [],
    toasts: [],
    dialogs: [],
    confirms: [],
    sessionCalls: [],
    stores: new Map(),
    ...(onCommand === undefined ? {} : { onCommand }),
  }
}

/** Wait until `check` yields a value, or give up. Keeps the tests sleep-free. */
async function waitFor<T>(check: () => T | undefined, ms = 5000): Promise<T | undefined> {
  const deadline = Date.now() + ms
  let value = check()
  while (value === undefined && Date.now() < deadline) {
    await Bun.sleep(20)
    value = check()
  }
  return value
}

/** Render the sidebar claim headlessly, with the mouse harness the tests click with. */
async function renderSidebar(observed: Observed): Promise<TestRendererSetup> {
  const claimed = observed.claims[0]
  if (!claimed) throw new Error('the plugin claimed no slot')
  const setup = await testRender(() => claimed.claim.render(claimed.input), {
    width: 60,
    height: 20,
  })
  await setup.renderOnce()
  return setup
}

/** The frame as text, for assertions about what a reader sees. */
async function sidebarFrame(observed: Observed): Promise<string> {
  return (await renderSidebar(observed)).captureCharFrame()
}

/**
 * Click the collapsible header.
 *
 * The header is the panel's first row, so row 0 is it - and the click goes through
 * opentui's own dispatch, which is what makes this a test of the wiring rather than
 * of a callback invoked directly.
 */
async function clickHeader(observed: Observed): Promise<void> {
  const setup = await renderSidebar(observed)
  await setup.mockMouse.click(4, 0)
  await setup.renderOnce()
}

/**
 * Spawn a session the panel can then list.
 *
 * Through the real tool, not by poking the store: the panel's subject is a PTY
 * session, and a fixture that fabricated one would not notice if the shape the
 * server serves had drifted from the shape the panel reads.
 */
async function spawnSession(title: string, command = 'true', args: string[] = []): Promise<string> {
  const started = await ptySpawn.execute(
    { command, args, title, description: 'tui panel test' },
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
  // Exited processes are archived on the way out, and the panel lists the archive
  // too - so waiting for the status means waiting for the row to be readable.
  const stored = await waitFor(() => manager.getSessionStore().get(id))
  if (!stored) throw new Error('the session was never archived')
  return id
}

const panelStore = (observed: Observed): Record<string, unknown> => {
  const state = observed.stores.get('opencode-pty.sidebar.panel')
  if (!state) throw new Error('the plugin never created its panel store')
  return state
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'pty-tui-runtime-'))
  // realpathSync: the origin record is keyed on the canonical path, and /var is a
  // symlink on some hosts, so a raw temp path would not match.
  project = realpathSync(mkdtempSync(join(tmpdir(), 'pty-tui-project-')))
  previousRuntimeDir = process.env.PTY_RUNTIME_DIR
  process.env.PTY_RUNTIME_DIR = runtimeDir
})

afterEach(() => {
  // The manager is a process-wide singleton, so a session left behind would show
  // up in the next test's panel - and a count assertion would then depend on test
  // order rather than on the panel.
  manager.clearAllSessions()
  if (previousRuntimeDir === undefined) delete process.env.PTY_RUNTIME_DIR
  else process.env.PTY_RUNTIME_DIR = previousRuntimeDir
  rmSync(runtimeDir, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

/**
 * Wait until the panel lists a session with this title, and - when given - with
 * this status.
 *
 * The status is not optional politeness. The panel draws the row from a list it
 * fetched, so a session that is still `running` at that moment is drawn as `0L`
 * even though it exits a millisecond later. Waiting for presence alone made this
 * test pass alone and fail in the full suite, which is the definition of flaky.
 */
async function waitForRow(
  observed: Observed,
  title: string,
  status?: string
): Promise<Record<string, unknown> | undefined> {
  return waitFor(() => {
    const sessions = panelStore(observed).sessions
    if (!Array.isArray(sessions)) return undefined
    const found = sessions.find((session) => (session as { title?: string }).title === title)
    if (!found) return undefined
    if (status !== undefined && (found as { status?: string }).status !== status) return undefined
    return found as Record<string, unknown>
  })
}

describe('the PTY sidebar panel', () => {
  test('claims the sidebar additively, so the built-in items stay', async () => {
    const seen = observed()
    await tuiPanel.setup(makeContext(seen))
    expect(seen.claims).toHaveLength(1)
    // `replace` would take over a boundary every other sidebar item lives in.
    expect(seen.claims[0]?.claim).toHaveProperty('append', 'sidebar.content')
  })

  test('says the server is not running, and starts nothing on its own', async () => {
    const seen = observed()
    await tuiPanel.setup(makeContext(seen))

    const ready = await waitFor(() =>
      panelStore(seen).status === 'starting…' ? undefined : panelStore(seen).status
    )
    // Nothing is listening, and the panel says so instead of quietly inviting a
    // retry: starting a server creates and deletes a session, which does not
    // belong on the startup path.
    expect(ready).toBe('not running — click to start')
    expect(seen.sessionCalls).toEqual([])
    expect(panelStore(seen).sessions).toEqual([])
  })

  test('lists a session it found through the origin record, and names it', async () => {
    const server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    try {
      await spawnSession('web-build')
      const seen = observed()
      await tuiPanel.setup(makeContext(seen))

      // `exited`, not merely present: the row must say `exit 0`, and a row
      // rendered while the process was still up would say `0L`.
      const row = await waitForRow(seen, 'web-build', 'exited')
      if (!row) throw new Error('the panel never listed the spawned session as finished')
      expect(panelStore(seen).status).toMatch(/^\d+ sessions?$/)
      // Found through the record, so no throwaway session was created - which is
      // the whole reason the record exists. Scraping the transcript would have
      // needed one per poll.
      expect(seen.sessionCalls).toEqual([])

      // Expand, or the collapsed panel draws no rows.
      const prefs = seen.stores.get('opencode-pty.sidebar')
      if (!prefs) throw new Error('the plugin never created its prefs store')
      prefs.collapsed = false

      const frame = await sidebarFrame(seen)
      expect(frame).toContain('web-build')
      // `exit 0` rather than `exit ?`: a session that ended on its own has a code,
      // and a row reading "exit ?" looks like a bug in the panel.
      expect(frame).toContain('exit 0')
    } finally {
      server[Symbol.dispose]()
    }
  })

  test('collapses by default, so the panel stays out of the way', async () => {
    const server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    try {
      await spawnSession('idle-build')
      const seen = observed()
      await tuiPanel.setup(makeContext(seen))
      // The row is in the panel's data; it is the drawing that is suppressed.
      await waitForRow(seen, 'idle-build', 'exited')

      const prefs = seen.stores.get('opencode-pty.sidebar')
      expect(prefs?.collapsed).toBe(true)

      const frame = await sidebarFrame(seen)
      // The chevron points at what a click would do, and the row is not drawn.
      expect(frame).toContain('▶')
      expect(frame).not.toContain('idle-build')
    } finally {
      server[Symbol.dispose]()
    }
  })

  // A click delivers BOTH a mouse-down and a mouse-up, so a toggle registered on each
  // fires twice: the panel opened and shut again inside one gesture. It looked like a
  // panel that refuses to open, and the bootstrap test below passed anyway - it
  // asserted the effect (a server was started) rather than the state (still open).
  test('one click on the header leaves the panel open', async () => {
    const seen = observed()
    await tuiPanel.setup(makeContext(seen))
    await waitFor(() =>
      panelStore(seen).status === 'starting…' ? undefined : panelStore(seen).status
    )

    const prefs = seen.stores.get('opencode-pty.sidebar')
    if (!prefs) throw new Error('the plugin never created its prefs store')
    expect(prefs.collapsed).toBe(true)

    await clickHeader(seen)

    expect(prefs.collapsed).toBe(false)
  })

  // The whole reason the panel may create a session: a host with no server running
  // gets one started through the plugin's own command, in a session nobody sees.
  test('starts the server when the panel is expanded, and cleans the scratch session up', async () => {
    // A holder rather than a `let`: the assignment happens inside the fixture's
    // callback, which control-flow analysis does not connect to the read.
    const holder: { server: PTYServer | null } = { server: null }
    const seen = observed(async () => {
      holder.server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    })
    try {
      await tuiPanel.setup(makeContext(seen))
      // Idle first: expanding is the trigger, not the startup.
      await waitFor(() =>
        panelStore(seen).status === 'starting…' ? undefined : panelStore(seen).status
      )
      expect(panelStore(seen).status).toBe('not running — click to start')
      expect(seen.sessionCalls).toEqual([])

      await clickHeader(seen)

      const ready = await waitFor(() => {
        const status = String(panelStore(seen).status)
        return status === 'starting…' || status === 'not running — click to start'
          ? undefined
          : status
      }, 10000)
      expect(ready).toBe('0 sessions')
      // The message the command posts must not land in the user's own chat, so it
      // runs in a session that is created and then deleted.
      expect(seen.sessionCalls).toEqual(['create', 'command', 'remove'])
    } finally {
      holder.server?.[Symbol.dispose]()
    }
  })

  // The bootstrap's cause is what makes an unfixable situation visible: a host where
  // this plugin is not registered cannot be retried into working.
  test('retries a failed start, then names the cause instead of inviting another try', async () => {
    const seen = observed(async () => {
      throw new Error('command not found: pty-show-server-url')
    })
    await tuiPanel.setup(makeContext(seen))

    await clickHeader(seen)
    const first = await waitFor(() => {
      const status = String(panelStore(seen).status)
      return status === 'starting server…' ? status : undefined
    })
    // While retries remain the panel says it is trying. Naming a plugin that is not
    // installed before giving up reads as indecision rather than as a cause.
    expect(first).toBe('starting server…')
    // The cause is remembered from the first attempt, not only once it is reported.
    expect(String(panelStore(seen).lastStartError)).toContain('command not found')
    // The scratch session is cleaned up on the failure path too.
    expect(seen.sessionCalls).toContain('remove')

    // Retrying means collapsing and expanding again: the header toggles, and a
    // header that is already open must not start anything on a click meant to close
    // it. Two clicks per attempt, which is what a person does - and what the header's
    // own wording ("toggle the panel to retry") tells them to do.
    for (let attempt = 0; attempt < 2; attempt++) {
      await clickHeader(seen)
      await clickHeader(seen)
    }

    const reported = await waitFor(() => {
      const status = String(panelStore(seen).status)
      return status.startsWith('unavailable:') ? status : undefined
    })
    expect(reported).toContain('command not found')
  })

  // The log is the only way to diagnose a TUI plugin's wiring, so the path that
  // writes it has to work - and it must stay off unless asked for.
  test('writes a diagnostic log only when asked', async () => {
    const previous = process.env.PTY_TUI_DEBUG
    process.env.PTY_TUI_DEBUG = '1'
    try {
      const seen = observed()
      await tuiPanel.setup(makeContext(seen))
      const log = join(runtimeDir, 'tui-debug.log')
      expect(existsSync(log)).toBe(true)
      expect(readFileSync(log, 'utf8')).toContain('setup')

      // A second panel, with the switch off, must not touch the file.
      const sizeBefore = statSync(log).size
      delete process.env.PTY_TUI_DEBUG
      await tuiPanel.setup(makeContext(observed()))
      expect(statSync(log).size).toBe(sizeBefore)
    } finally {
      if (previous === undefined) delete process.env.PTY_TUI_DEBUG
      else process.env.PTY_TUI_DEBUG = previous
    }
  })

  test('publishes its own address, so the record it reads is findable', async () => {
    // The panel is useless without this half: a server that starts with no
    // project writes no record at all, and the panel has nothing to look up.
    const server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    try {
      const { originsForProject } = await import('../src/shared/runtime.ts')
      const records = originsForProject(project)
      expect(records).toHaveLength(1)
      expect(records[0]?.port).toBe(server.server.port)
    } finally {
      server[Symbol.dispose]()
    }
  })
})
