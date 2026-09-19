import React from 'react'
import { FitAddon, init, Terminal, type ITheme } from 'ghostty-web'
import { SerializeAddon } from '../addons/serialize.ts'
import type { RenderIntent } from '../lib/raw-stream.ts'

// Global module augmentation to extend Window interface. The `xterm*` names are
// kept for E2E test compatibility even though the emulator is now ghostty-web.
declare global {
  interface Window {
    xtermTerminal?: Terminal
    xtermSerializeAddon?: SerializeAddon
  }
}

/**
 * Resolve the terminal palette from the application theme. The colors are
 * defined once as CSS custom properties (`--app-bg` / `--app-fg`) so the
 * emulator stays in sync with the rest of the UI instead of hardcoding a
 * separate dark palette.
 *
 * ghostty-web applies the theme when the renderer is created (`open()`), so the
 * palette has to be passed to the constructor rather than set afterwards.
 */
function readAppTheme(): ITheme {
  const rootStyles = getComputedStyle(document.documentElement)
  const bodyStyles = getComputedStyle(document.body)
  return {
    background: rootStyles.getPropertyValue('--app-bg').trim() || bodyStyles.backgroundColor,
    foreground: rootStyles.getPropertyValue('--app-fg').trim() || bodyStyles.color,
  }
}

interface RawTerminalProps {
  onSendInput?: (data: string) => void
  onInterrupt?: () => void
  onResize?: (cols: number, rows: number) => void
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
        term.write(intent.data)
        break
      case 'rewrite':
        term.reset()
        term.write(intent.data)
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
    // Load the shared WASM instance. `init()` is idempotent.
    await init()
    if (generation !== this.initGeneration) return

    const term = new Terminal({
      cursorBlink: true,
      // Theme is applied at renderer construction; the fork does not reliably
      // update colors after `open()`.
      theme: readAppTheme(),
      fontFamily: 'monospace',
      fontSize: 14,
      scrollback: 5000,
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
