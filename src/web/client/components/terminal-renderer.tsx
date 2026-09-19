import React from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { RenderIntent } from '../lib/raw-stream.ts'
import '@xterm/xterm/css/xterm.css'

// Global module augmentation to extend Window interface
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

  /**
   * Fit the terminal to its container and report the resulting dimensions to
   * the parent via `onResize`. Safe to call when the container has no layout
   * yet (fit errors are swallowed and zero dimensions are not reported).
   */
  public fit(): void {
    if (!this.fitAddon || !this.xtermInstance) return
    try {
      this.fitAddon.fit()
    } catch {
      // Container may not be laid out yet; xterm throws on zero dimensions.
    }
    this.emitResize()
  }

  /**
   * Apply a reconciled render instruction from the raw stream. Keeping the
   * transcript in the emulator instead of React state avoids copying the whole
   * buffer on every chunk.
   */
  public applyRender(intent: RenderIntent): void {
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
    this.initializeTerminal()
  }

  override componentWillUnmount() {
    if (this.xtermInstance) {
      this.xtermInstance.dispose()
    }
  }

  private initializeTerminal() {
    const term = new Terminal({
      cursorBlink: true,
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
      this.fit()
    }

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
    return (
      <div ref={this.terminalRef} className="xterm" style={{ width: '100%', height: '100%' }} />
    )
  }
}
