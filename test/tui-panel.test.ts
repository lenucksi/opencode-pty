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
import { removeOrigin, writeOrigin } from '../src/shared/runtime.ts'

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
type FooterClaim = Extract<SlotClaim, { readonly append: 'sidebar.footer' }>
type TuiContext = Plugin.Context

interface Toast {
  message: string
  variant?: string
}

interface RenderedClaim {
  claim: SidebarClaim
  input: { readonly sessionID: string }
}

/** The footer claim, which is the second slot the plugin registers. */
interface RenderedFooter {
  claim: FooterClaim
  input: { readonly sessionID: string }
}

/** The session-panel claim, which arrives with the full `PanelInput`. */
interface RenderedSessionPanel {
  claim: Extract<SlotClaim, { readonly append: 'session.panel' }>
  input: SessionPanelInput
}

/**
 * The parts of `PanelInput` the plugin reads, as concrete values.
 *
 * The real `PanelInput` carries six functions and a presentation; a fixture that
 * fabricated only the fields under test would let a claim that reads the wrong one pass,
 * so the shape is spelled out and `as` is used once, here, with that reason.
 */
interface SessionPanelInput {
  readonly name: string
  readonly sessionID: string
  readonly width: number
  readonly presentation: 'panel' | 'fullscreen'
  readonly focused: boolean
  readonly focus: () => void
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

/** Everything the fixture observed the plugin doing. */
interface Observed {
  claims: RenderedClaim[]
  /** The footer claim, so the archive line can be rendered and clicked. */
  footers: RenderedFooter[]
  /** The session-panel claim, so the panel can be rendered. */
  sessionPanels: RenderedSessionPanel[]
  /** Names passed to `ui.panel.open`, in order. */
  opened: string[]
  /**
   * Every close of a session panel, from either route.
   *
   * A count rather than a list: the routes are `ui.panel.close` and `PanelInput.close`, and
   * a reader stuck in this panel could only escape by one of them working - so what matters
   * is how many times the panel was actually closed, not from where.
   */
  panelCloses: number
  /** Keymap layers the plugin registered, so a command can be invoked. */
  layers: {
    commands?: readonly {
      id?: string
      run?: () => void
      palette?: boolean
      bind?: string
      enabled?: () => boolean
    }[]
  }[]
  /**
   * What `ui.panel.current()` reports. A holder, because a test flips it after setup.
   */
  activePanel: { name: string; sessionID: string } | undefined
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
      // Both claims the plugin registers, each with its input type attached - see
      // SidebarClaim and FooterClaim. The footer carries the archive's size, so it has
      // to be rendered to be clicked.
      if ('append' in claim && claim.append === 'sidebar.content') {
        observed.claims.push({ claim, input: { sessionID: 'session-1' } })
      }
      if ('append' in claim && claim.append === 'sidebar.footer') {
        observed.footers.push({ claim, input: { sessionID: 'session-1' } })
      }
      if ('append' in claim && claim.append === 'session.panel') {
        observed.sessionPanels.push({
          claim,
          input: {
            name: 'opencode-pty',
            // The same id `spawnSession` passes to the spawn tool, so a session the
            // tests really create belongs to this panel. A fixture pairing that cannot
            // happen would make the grouping untestable.
            sessionID: 'test-parent-session',
            width: 80,
            presentation: 'panel',
            focused: true,
            focus: () => {},
            close: () => {
              observed.panelCloses += 1
            },
            toggleFullscreen: () => {},
          },
        })
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
    panel: {
      open: (name: string) => {
        observed.opened.push(name)
        observed.activePanel = { name, sessionID: 'test-parent-session' }
        return true
      },
      close: () => {
        observed.panelCloses += 1
        observed.activePanel = undefined
      },
      current: () => observed.activePanel,
    },
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
      layer: (factory: () => { commands?: readonly { id?: string; run?: () => void }[] }) => {
        observed.layers.push(factory())
      },
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
    footers: [],
    sessionPanels: [],
    opened: [],
    panelCloses: 0,
    layers: [],
    activePanel: undefined,
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

/** Render the footer claim headlessly, with the same mouse harness. */
async function renderFooter(observed: Observed): Promise<TestRendererSetup> {
  const claimed = observed.footers[0]
  if (!claimed) throw new Error('the plugin claimed no footer slot')
  const setup = await testRender(() => claimed.claim.render(claimed.input), {
    width: 60,
    height: 6,
  })
  await setup.renderOnce()
  return setup
}

/** The footer's character frame, for assertions about what a reader sees. */
async function footerFrame(observed: Observed): Promise<string> {
  return (await renderFooter(observed)).captureCharFrame()
}

/** Render the session-panel claim headlessly, with the same mouse harness. */
async function renderSessionPanel(observed: Observed): Promise<TestRendererSetup> {
  const claimed = observed.sessionPanels[0]
  if (!claimed) throw new Error('the plugin claimed no session panel')
  const setup = await testRender(() => claimed.claim.render(claimed.input), {
    width: 80,
    height: 24,
  })
  await setup.renderOnce()
  return setup
}

/**
 * Click the panel's `✕ close` control.
 *
 * The column comes out of the rendered frame rather than a constant, and the click goes
 * through opentui's dispatch, so this exercises the real wiring instead of calling the
 * handler the view was built with.
 */
async function clickPanelClose(observed: Observed): Promise<void> {
  const setup = await renderSessionPanel(observed)
  const column = setup.captureCharFrame().split('\n')[0]?.indexOf('✕') ?? -1
  if (column < 0) throw new Error('the panel draws no close control to click')
  await setup.mockMouse.click(column, 0)
  await setup.renderOnce()
}

/**
 * Click the archive line in the footer.
 *
 * Through opentui's own dispatch, like the header, so this tests the wiring rather than
 * a callback invoked directly. Row 0 is the only row the footer has.
 */
async function clickFooter(observed: Observed): Promise<void> {
  const setup = await renderFooter(observed)
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
      // A run that failed, because a finished session is only a row when it carries
      // news - an `exit 0` is a record, and 200 of those are what made this panel
      // unreadable. The clean case has its own case below.
      await spawnSession('web-build', 'sh', ['-c', 'exit 1'])
      const seen = observed()
      await tuiPanel.setup(makeContext(seen))

      // `exited`, not merely present: the row must say `exit 1`, and a row
      // rendered while the process was still up would say `0L`.
      const row = await waitForRow(seen, 'web-build', 'exited')
      if (!row) throw new Error('the panel never listed the spawned session as finished')
      expect(panelStore(seen).status).toMatch(/^\d+ sessions?$/)
      // Found through the record, so no throwaway session was created - which is
      // the whole reason the record exists. Scraping the transcript would have
      // needed one per poll.
      expect(seen.sessionCalls).toEqual([])

      // Expand, or the collapsed panel draws no rows - and open the archive, or the
      // only rows it will draw are the running ones.
      const prefs = seen.stores.get('opencode-pty.sidebar')
      if (!prefs) throw new Error('the plugin never created its prefs store')
      prefs.collapsed = false

      // Nothing is running, so with the archive closed the body says so.
      expect(await sidebarFrame(seen)).toContain('nothing running')

      prefs.showFinished = true
      const frame = await sidebarFrame(seen)
      expect(frame).toContain('web-build')
      // `exit 1` rather than `exit ?`: a session that ended on its own has a code,
      // and a row reading "exit ?" looks like a bug in the panel.
      expect(frame).toContain('exit 1')
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
  // The archive's size lives in the sidebar's bottom, the one place a summary does not
  // push the host's own items down.
  test('claims the footer slot as well as the sidebar', async () => {
    const seen = observed()
    await tuiPanel.setup(makeContext(seen))
    expect(seen.footers[0]?.claim).toHaveProperty('append', 'sidebar.footer')
  })

  // The count must be the ARCHIVE's, not the visible rows'. The body below shows
  // nothing - no session is running and the failed one is hidden - and the footer still
  // names it. A footer that counted the rows would read "0 finished" exactly when the
  // reader needs to know there is something to look at.
  test('the footer counts the archive, not the rows on screen', async () => {
    const server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    try {
      await spawnSession('footer-archive-run', 'sh', ['-c', 'exit 3'])
      const seen = observed()
      await tuiPanel.setup(makeContext(seen))
      await waitForRow(seen, 'footer-archive-run', 'exited')

      const prefs = seen.stores.get('opencode-pty.sidebar')
      if (!prefs) throw new Error('the plugin never created its prefs store')
      prefs.collapsed = false
      prefs.showFinished = false

      // Expanded, and still nothing to draw: the one finished run failed, and the
      // archive is closed.
      expect(await sidebarFrame(seen)).toContain('nothing running')

      const closed = await footerFrame(seen)
      expect(closed).toContain('finished')
      expect(closed).toContain('1 failed')
      // Closed, and offering to open: the arrow points at what a click would do.
      expect(closed).toContain('\u25b8')

      prefs.showFinished = true
      expect(await sidebarFrame(seen)).toContain('footer-archive-run')
      const open = await footerFrame(seen)
      expect(open).toContain('\u25be')
      expect(open).not.toContain('\u25b8')
    } finally {
      server[Symbol.dispose]()
    }
  })

  // The same double-fire the header had: a click delivers both events, so a toggle
  // registered on each would open and immediately close, and the footer would look
  // broken rather than wrong.
  test('one click on the footer opens the archive, and one more closes it', async () => {
    const server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    try {
      await spawnSession('footer-toggle-run', 'sh', ['-c', 'exit 1'])
      const seen = observed()
      await tuiPanel.setup(makeContext(seen))
      await waitForRow(seen, 'footer-toggle-run', 'exited')

      const prefs = seen.stores.get('opencode-pty.sidebar')
      if (!prefs) throw new Error('the plugin never created its prefs store')
      expect(prefs.showFinished).toBe(false)

      await clickFooter(seen)
      expect(prefs.showFinished).toBe(true)

      await clickFooter(seen)
      expect(prefs.showFinished).toBe(false)
    } finally {
      server[Symbol.dispose]()
    }
  })

  // Expanding the panel may start a server - it is the only trigger that does. The
  // archive line looks like a control too, so it must not become a second one: the
  // sessions it would show are already in the store, so it needs no refresh at all.
  test('opening the archive does not start a server', async () => {
    const seen = observed()
    await tuiPanel.setup(makeContext(seen))
    await waitFor(() =>
      panelStore(seen).status === 'starting…' ? undefined : panelStore(seen).status
    )

    await clickFooter(seen)

    const prefs = seen.stores.get('opencode-pty.sidebar')
    expect(prefs?.showFinished).toBe(true)
    expect(seen.sessionCalls).not.toContain('create')
  })

  // The session panel is the host's own place for an extra view of a session, and a PTY
  // session belongs to the conversation that started it. Without the claim there is
  // nowhere to put that view.
  test('claims the session panel and registers a command that opens it', async () => {
    const seen = observed()
    await tuiPanel.setup(makeContext(seen))
    expect(seen.sessionPanels[0]?.claim).toHaveProperty('append', 'session.panel')

    const commands = seen.layers.flatMap((layer) => layer.commands ?? [])
    const command = commands.find((entry) => entry.id === 'opencode-pty.session-panel')
    if (!command?.run) throw new Error('the plugin registered no command for the panel')

    command.run()
    // The name the host reports back from `ui.panel.current()` has to be the one the
    // command opened, because that string is what the poll matches on. A mismatch would
    // leave the panel open and permanently empty, with nothing failing.
    expect(seen.opened).toEqual(['opencode-pty'])
    expect(seen.activePanel?.name).toBe('opencode-pty')
  })

  // The way out, by mouse. Reported by a reader who opened this panel and could not leave
  // it: the host has no key for closing a plugin panel, so every route they had - change
  // session, pick a terminal, open the sidebar - was a DIFFERENT action that happened to
  // close it. The only thing that worked was killing the terminal.
  test('the panel header closes the panel when its close control is clicked', async () => {
    const seen = observed()
    await tuiPanel.setup(makeContext(seen))
    await clickPanelClose(seen)
    // Exactly once: a click delivers a mouse-down and a mouse-up, and a handler on each
    // would fire twice - which reads as "nothing happened" rather than as "twice".
    expect(seen.panelCloses).toBe(1)
  })

  // The way out, without a mouse. `palette: true` is the guaranteed route, because the
  // palette is a host overlay this plugin cannot shadow - so it works even while the panel
  // holds focus and the composer is unreachable.
  test('registers a close command in the palette', async () => {
    const seen = observed()
    await tuiPanel.setup(makeContext(seen))
    const commands = seen.layers.flatMap((layer) => layer.commands ?? [])
    const command = commands.find((entry) => entry.id === 'opencode-pty.session-panel.close')
    if (!command) throw new Error('the plugin registered no command to close the panel')
    expect(command.palette).toBe(true)
  })

  test('the close command closes the panel', async () => {
    const seen = observed()
    await tuiPanel.setup(makeContext(seen))
    const commands = seen.layers.flatMap((layer) => layer.commands ?? [])
    const command = commands.find((entry) => entry.id === 'opencode-pty.session-panel.close')
    if (!command?.run) throw new Error('the close command cannot be run')
    command.run()
    expect(seen.panelCloses).toBe(1)
  })

  // A binding that does nothing the rest of the time teaches the reader to distrust the
  // one time it matters, so the key only exists while there is something to leave.
  test('the close key is only live while a panel is open', async () => {
    const seen = observed()
    await tuiPanel.setup(makeContext(seen))
    const commands = seen.layers.flatMap((layer) => layer.commands ?? [])
    const command = commands.find((entry) => entry.id === 'opencode-pty.session-panel.close')
    if (!command?.enabled) throw new Error('the close command has no enabled predicate')
    expect(command.enabled()).toBe(false)
    seen.activePanel = { name: 'opencode-pty', sessionID: 'test-parent-session' }
    expect(command.enabled()).toBe(true)
  })

  // Expanding the sidebar is the only trigger that may start a server, and opening this
  // panel asks for the same thing, so it is the same trigger. Otherwise the panel would
  // be empty on a host where nothing else ever asked for one - and the empty state says
  // "this conversation started no PTY session", which would be a lie.
  test('opening the panel starts the server, like expanding the sidebar does', async () => {
    const holder: { server: PTYServer | null } = { server: null }
    const seen = observed(async () => {
      holder.server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    })
    try {
      await tuiPanel.setup(makeContext(seen))
      const commands = seen.layers.flatMap((layer) => layer.commands ?? [])
      const command = commands.find((entry) => entry.id === 'opencode-pty.session-panel')
      if (!command?.run) throw new Error('the plugin registered no command for the panel')

      command.run()
      await waitFor(() => (seen.sessionCalls.includes('command') ? true : undefined))

      expect(seen.sessionCalls).toContain('create')
      // And the scratch session is cleaned up again, exactly as the sidebar's is.
      await waitFor(() => (seen.sessionCalls.includes('remove') ? true : undefined))
      expect(seen.sessionCalls).toContain('remove')
    } finally {
      holder.server?.[Symbol.dispose]()
    }
  })

  // The grouping end to end: a session created through the real spawn tool carries the
  // parent id, and the panel shows it. A fixture that fabricated the parent would prove
  // only that the filter can compare two strings.
  test('the panel shows the sessions this conversation started', async () => {
    const server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    try {
      await spawnSession('mine', 'sh', ['-c', 'sleep 30'])
      const seen = observed()
      await tuiPanel.setup(makeContext(seen))
      await waitForRow(seen, 'mine', 'running')

      const commands = seen.layers.flatMap((layer) => layer.commands ?? [])
      const command = commands.find((entry) => entry.id === 'opencode-pty.session-panel')
      if (!command?.run) throw new Error('the plugin registered no command for the panel')
      command.run()

      const rows = await waitFor(() => {
        const stored = seen.stores.get('opencode-pty.session-panel') as
          | { sessions?: { title?: string }[] }
          | undefined
        const listed = stored?.sessions ?? []
        return listed.some((row) => row.title === 'mine') ? listed : undefined
      })
      expect(rows?.map((row) => row.title)).toContain('mine')
    } finally {
      server[Symbol.dispose]()
    }
  })

  // The reason the panel exists: the screen of a process this conversation started,
  // readable without a modal in the way. Driven through the real screen route, so this
  // covers the poll, the grouping and the read in one go - the panel showing nothing is
  // exactly what every one of those three failing looks like.
  test('reads the screen of the selected session while the panel is open', async () => {
    const server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    try {
      await spawnSession('talker', 'sh', ['-c', 'printf "hello from the pty"; sleep 30'])
      const seen = observed()
      await tuiPanel.setup(makeContext(seen))
      await waitForRow(seen, 'talker', 'running')

      const commands = seen.layers.flatMap((layer) => layer.commands ?? [])
      const command = commands.find((entry) => entry.id === 'opencode-pty.session-panel')
      if (!command?.run) throw new Error('the plugin registered no command for the panel')
      command.run()

      // Longer than the 2.5s poll, because the screen is read on the tick rather than on
      // the click - a modal-free panel may as well arrive with its content.
      const screen = await waitFor(() => {
        const stored = seen.stores.get('opencode-pty.session-panel') as
          | { screen?: string }
          | undefined
        const text = stored?.screen ?? ''
        return text.includes('hello from the pty') ? text : undefined
      }, 8000)
      expect(screen).toContain('hello from the pty')
    } finally {
      server[Symbol.dispose]()
    }
  })

  // `ui.panel.current()` reports the panel the HOST has open, so a name check is what
  // stops this plugin reading a screen because somebody else's panel is on screen. The
  // SDK documents the accessor as "this plugin's active panel", so the case is defensive
  // - and a defensive check that nothing exercises is a check that will be dropped by the
  // next reader who does not know that. So it is exercised here.
  test('reads nothing while a panel of another name is open', async () => {
    const server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    try {
      await spawnSession('talker', 'sh', ['-c', 'printf "not yours"; sleep 30'])
      const seen = observed()
      await tuiPanel.setup(makeContext(seen))
      await waitForRow(seen, 'talker', 'running')

      // The server is up and the session exists; only the panel's identity differs.
      seen.activePanel = { name: 'some-other-plugin', sessionID: 'test-parent-session' }
      await Bun.sleep(3000)

      const stored = seen.stores.get('opencode-pty.session-panel') as
        | { sessionID?: string | null; screen?: string }
        | undefined
      expect(stored?.sessionID).toBeNull()
      expect(stored?.screen).not.toContain('not yours')
    } finally {
      server[Symbol.dispose]()
    }
  })

  // The claim being REGISTERED is not the claim working: a render callback that throws, or
  // reads the wrong field, is invisible until something renders it. So the panel is
  // rendered here, through the slot the host would call.
  test('the panel claim renders, and a click in it selects a row', async () => {
    const server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    try {
      await spawnSession('one', 'sh', ['-c', 'sleep 30'])
      await spawnSession('two', 'sh', ['-c', 'sleep 30'])
      const seen = observed()
      await tuiPanel.setup(makeContext(seen))
      await waitForRow(seen, 'two', 'running')

      const commands = seen.layers.flatMap((layer) => layer.commands ?? [])
      const command = commands.find((entry) => entry.id === 'opencode-pty.session-panel')
      if (!command?.run) throw new Error('the plugin registered no command for the panel')
      command.run()
      await waitFor(() => {
        const stored = seen.stores.get('opencode-pty.session-panel') as
          | { sessions?: unknown[] }
          | undefined
        return (stored?.sessions?.length ?? 0) >= 2 ? true : undefined
      })

      const setup = await renderSessionPanel(seen)
      const frame = setup.captureCharFrame()
      expect(frame).toContain('PTY')
      expect(frame).toContain('2 sessions')
      expect(frame).toContain('two')

      // Row 0 is the header, so row 1 is the first session. The click has to reach the
      // panel's own handler and not just stop at the element - a claim that renders and
      // ignores every click is still broken.
      await setup.mockMouse.click(4, 1)
      await setup.renderOnce()
      const stored = seen.stores.get('opencode-pty.session-panel') as
        | { selected?: string | null }
        | undefined
      expect(stored?.selected).not.toBeNull()

      // Deliberately NOT asserted here: that the claim hands the view the sidebar's fresh
      // list rather than its own snapshot. Passing the stale one fails nothing a reader
      // would notice - the two differ by at most one poll interval, and the only effect is
      // a run timer that keeps counting for up to 2.5s after a process exits. The rule it
      // serves is unit-tested in `selectedLive`; pinning the one line that passes it would
      // need a timing test whose failure is a quarter of a second of drift.
    } finally {
      server[Symbol.dispose]()
    }
  })

  // A screen that cannot be read must say so where the reader is looking. Left silent,
  // the panel would keep showing the PREVIOUS session's output, which reads as the panel
  // tracking the wrong process rather than as a failed request.
  //
  // The server answers the list and fails the screen, because that is the only way to
  // reach this deterministically: a server that is gone entirely takes the LIST with it,
  // the panel ends up with no sessions at all, and the read is never attempted - which is
  // correct behaviour and a different property (covered below).
  test('a screen that cannot be read says so in the panel', async () => {
    const requests: string[] = []
    let originFile: string | null = null
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        requests.push(path)
        if (path === '/api/sessions') {
          return Response.json([
            {
              id: 'pty_broken',
              title: 'talker',
              status: 'running',
              parentSessionId: 'test-parent-session',
              createdAt: new Date().toISOString(),
            },
          ])
        }
        if (path === '/health') return Response.json({ status: 'healthy', sessions: {} })
        // The screen route failing, which is what a VT that cannot be replayed does.
        return Response.json({ error: 'render failed' }, { status: 500 })
      },
    })
    try {
      const port = server.port
      if (typeof port !== 'number') throw new Error('the stub server bound no port')

      // Published the way the real server publishes itself, so the plugin finds the stub
      // through its own discovery rather than through a hook no production path has.
      // The returned path is what `removeOrigin` takes - the record is a file, and
      // removing it by content would need a second way to address it.
      originFile = writeOrigin({ directory: project, hostname: '127.0.0.1', port })
      if (originFile === null) throw new Error('could not publish the stub origin')

      const seen = observed()
      // The panel counts as open from the first tick, so the failure is reached without
      // going through the command.
      seen.activePanel = { name: 'opencode-pty', sessionID: 'test-parent-session' }
      await tuiPanel.setup(makeContext(seen))

      const message = await waitFor(() => {
        const stored = seen.stores.get('opencode-pty.session-panel') as
          | { screen?: string }
          | undefined
        const text = stored?.screen ?? ''
        return text.includes('could not read the screen') ? text : undefined
      }, 8000)
      expect(message).toContain('500')
      // The request really was made, so this is the screen route failing and not the
      // panel deciding on its own that it cannot read.
      expect(requests.some((path) => path.includes('/screen'))).toBe(true)
    } finally {
      server.stop(true)
      // The origin record outlives the process that wrote it; left behind, the next test
      // in this file would find a port nothing is listening on.
      removeOrigin(originFile)
    }
  }, 20000)

  // The other half of the same question: when the server is gone the panel must not keep
  // a stale screen on display. Showing the last output of a process whose server no longer
  // answers reads as a live view of something that is not there.
  test('a server that is gone leaves no stale screen behind', async () => {
    const server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    try {
      await spawnSession('talker', 'sh', ['-c', 'printf "first output"; sleep 30'])
      const seen = observed()
      await tuiPanel.setup(makeContext(seen))
      await waitForRow(seen, 'talker', 'running')

      const commands = seen.layers.flatMap((layer) => layer.commands ?? [])
      const command = commands.find((entry) => entry.id === 'opencode-pty.session-panel')
      if (!command?.run) throw new Error('the plugin registered no command for the panel')
      command.run()
      await waitFor(() => {
        const stored = seen.stores.get('opencode-pty.session-panel') as
          | { screen?: string }
          | undefined
        return (stored?.screen ?? '').includes('first output') ? true : undefined
      }, 8000)

      server[Symbol.dispose]()
      await waitFor(() => {
        const stored = seen.stores.get('opencode-pty.session-panel') as
          | { screen?: string; sessions?: unknown[] }
          | undefined
        return (stored?.sessions?.length ?? 0) === 0 ? true : undefined
      }, 8000)

      const stored = seen.stores.get('opencode-pty.session-panel') as
        | { screen?: string }
        | undefined
      expect(stored?.screen).not.toContain('first output')
    } finally {
      server[Symbol.dispose]()
    }
  }, 20000)

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
