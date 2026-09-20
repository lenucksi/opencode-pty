import React from 'react'
import { FitAddon, Ghostty, Terminal, type ITheme } from 'ghostty-web'
// Vite emits the package's `ghostty-vt.wasm` as a same-origin, content-hashed
// asset and rewrites this import to its final URL. Passing that URL to
// `Ghostty.load()` keeps the WASM out of the JS bundle and avoids the
// `data:application/wasm` fallback, which the app CSP (`connect-src 'self'`)
// would block.
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url'
import { SerializeAddon } from '../addons/serialize/index.ts'
import type { RenderIntent } from '../lib/raw-stream.ts'
import { readTerminalTheme, type ThemeScheme } from '../lib/theme.ts'

/**
 * Load the shared Ghostty WASM instance once per page. `Ghostty.load(path)`
 * fetches the externalized asset; the promise is cached so every terminal in
 * the app reuses the same instance (mirroring the package's own `init()`).
 */
let ghosttyPromise: Promise<Ghostty> | null = null
function loadGhostty(): Promise<Ghostty> {
  // Reset the cache on failure so a transient load error does not poison every
  // subsequent terminal in the page (the package's `init()` also retries).
  ghosttyPromise ??= Ghostty.load(ghosttyWasmUrl).catch((err) => {
    ghosttyPromise = null
    throw err
  })
  return ghosttyPromise
}

// Global module augmentation to extend Window interface. The `xterm*` names are
// kept for E2E test compatibility even though the emulator is now ghostty-web.
declare global {
  interface Window {
    xtermTerminal?: Terminal
    xtermSerializeAddon?: SerializeAddon
  }
}

interface RawTerminalProps {
  onSendInput?: (data: string) => void
  onInterrupt?: () => void
  onResize?: (cols: number, rows: number) => void
  /** Light/dark hint handed to the emulator (OSC 10/11, DEC 2031). */
  colorScheme?: ThemeScheme
  disabled?: boolean
}

export class RawTerminal extends React.Component<RawTerminalProps> {
  private terminalRef = React.createRef<HTMLDivElement>()
  private xtermInstance: Terminal | null = null
  private fitAddon: FitAddon | null = null
  private serializeAddon: SerializeAddon | null = null

  // ghostty-web needs `await init()` (WASM load) before a Terminal can accept
  // writes. Render intents that arrive during that window are queued and
  // replayed once the emulator is ready.
  private ready = false
  private pendingIntents: RenderIntent[] = []
  // Monotonic init generation. React StrictMode mounts, unmounts and remounts
  // the same component instance, so a single `disposed` boolean races with the
  // async `init()`: the first mount's await can resume *after* the remount and
  // bail (or create a duplicate terminal). Each mount takes a new generation and
  // only the latest one is allowed to install its terminal.
  private initGeneration = 0

  /**
   * Fit the terminal to its container and report the resulting dimensions to
   * the parent via `onResize`. Safe to call when the container has no layout
   * yet (fit errors are swallowed and zero dimensions are not reported).
   */
  public fit(): void {
    if (!this.ready || !this.fitAddon || !this.xtermInstance) return
    try {
      this.fitAddon.fit()
    } catch {
      // Container may not be laid out yet; fit throws on zero dimensions.
    }
    this.emitResize()
  }

  /**
   * Swap the palette of a live terminal. ghostty-web rebuilds its color palette
   * and repaints the whole viewport when the `theme` option changes, so the
   * transcript survives and no re-initialisation is needed.
   */
  public applyTheme(theme: ITheme, scheme: ThemeScheme): void {
    const term = this.xtermInstance
    if (!this.ready || !term) return
    term.setOption('theme', theme)
    term.setOption('colorScheme', scheme)
  }

  /**
   * Apply a reconciled render instruction from the raw stream. Keeping the
   * transcript in the emulator instead of React state avoids copying the whole
   * buffer on every chunk.
   */
  public applyRender(intent: RenderIntent): void {
    if (!this.ready) {
      this.pendingIntents.push(intent)
      return
    }
    this.applyIntent(intent)
  }

  private applyIntent(intent: RenderIntent): void {
    const term = this.xtermInstance
    if (!term) return

    switch (intent.type) {
      case 'append':
        // ghostty-web's `GhosttyTerminal.write()` throws a `RangeError:
        // offset is out of bounds` for empty input (`alloc(0)` yields a
        // pointer that is not addressable in the typed-array view). Skip it.
        if (intent.data.length > 0) {
          term.write(intent.data)
        }
        break
      case 'rewrite':
        term.reset()
        if (intent.data.length > 0) {
          term.write(intent.data)
        }
        break
      case 'reset':
        term.reset()
        break
      default:
        break
    }
  }

  private emitResize(): void {
    const term = this.xtermInstance
    if (!term || !this.props.onResize) return
    if (term.cols <= 0 || term.rows <= 0) return
    this.props.onResize(term.cols, term.rows)
  }

  override componentDidMount() {
    const generation = ++this.initGeneration
    void this.initializeTerminal(generation).catch((err) => {
      console.error('[RawTerminal] initializeTerminal failed', err)
    })
  }

  override componentDidUpdate(prevProps: RawTerminalProps) {
    if (prevProps.colorScheme === this.props.colorScheme) return
    // The token set is applied in an effect (which runs after this commit), so
    // read it on the next frame rather than immediately.
    requestAnimationFrame(() => {
      this.applyTheme(readTerminalTheme(), this.props.colorScheme ?? 'dark')
    })
  }

  override componentWillUnmount() {
    // Invalidate any in-flight init so it cannot install a terminal after the
    // component (or this mount pass) is gone.
    this.initGeneration++
    this.ready = false
    this.pendingIntents = []
    if (this.xtermInstance) {
      this.xtermInstance.dispose()
      this.xtermInstance = null
    }
    this.fitAddon = null
    this.serializeAddon = null
  }

  private async initializeTerminal(generation: number) {
    // Load the shared WASM instance from the same-origin asset. The promise is
    // shared across terminals and terminal remounts.
    const ghostty = await loadGhostty()
    if (generation !== this.initGeneration) return

    const term = new Terminal({
      cursorBlink: true,
      // Seed with the palette the app is currently rendering; `applyTheme`
      // swaps it live when the user changes the theme.
      theme: readTerminalTheme(),
      colorScheme: this.props.colorScheme ?? 'dark',
      fontFamily: 'monospace',
      fontSize: 14,
      scrollback: 5000,
      // Use the explicitly-loaded external WASM rather than the module-level
      // `init()` singleton (whose bundle inlines a blocked data: URL).
      ghostty,
    })

    this.fitAddon = new FitAddon()
    this.serializeAddon = new SerializeAddon()
    term.loadAddon(this.fitAddon)
    term.loadAddon(this.serializeAddon)

    this.xtermInstance = term

    if (this.terminalRef.current) {
      term.open(this.terminalRef.current)
      // xterm.js added the `xterm` class when the terminal opened, and the
      // E2E suite uses `.xterm` as a readiness signal before typing. ghostty-web
      // does not add classes, so mirror that behaviour here.
      this.terminalRef.current.classList.add('xterm')
    }

    this.ready = true

    // Replay any output that arrived while the WASM module was loading.
    const pending = this.pendingIntents
    this.pendingIntents = []
    for (const intent of pending) {
      this.applyIntent(intent)
    }

    this.fit()

    // The palette is read from CSS, and the theme hook updates the token set in
    // an effect that runs after this commit. Re-read it on the next frame so a
    // mount that races a theme switch still ends up with the right colors.
    requestAnimationFrame(() => {
      this.applyTheme(readTerminalTheme(), this.props.colorScheme ?? 'dark')
    })

    // Expose terminal and serialize addon for E2E testing. Gated behind a
    // build-time flag so production bundles never leak test hooks; dev builds
    // expose them too for local debugging.
    if (import.meta.env.DEV || import.meta.env.VITE_EXPOSE_TEST_HOOKS === '1') {
      window.xtermTerminal = term
      window.xtermSerializeAddon = this.serializeAddon
    }

    this.setupInputHandling(term)
  }

  private setupInputHandling(term: Terminal) {
    // Read props at event time: the terminal instance is reused across session
    // switches, so a captured `disabled`/callback would go stale.
    term.onData((data) => {
      if (this.props.disabled) return
      if (data === '\u0003') {
        // Ctrl+C
        this.props.onInterrupt?.()
      } else {
        // Send input to PTY server (PTY will echo back for interactive sessions)
        this.props.onSendInput?.(data)
      }
    })
  }

  override render() {
    // The `terminal` class is kept for E2E selectors (`.terminal.xterm`).
    // `xterm` is added once the emulator is open (see initializeTerminal) so it
    // doubles as a readiness signal, matching xterm.js behaviour.
    return (
      <div ref={this.terminalRef} className="terminal" style={{ width: '100%', height: '100%' }} />
    )
  }
}
