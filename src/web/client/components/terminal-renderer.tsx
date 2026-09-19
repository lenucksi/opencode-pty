import React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'

// Global module augmentation to extend Window interface
declare global {
  interface Window {
    xtermTerminal?: Terminal
    xtermSerializeAddon?: SerializeAddon
  }
}

interface RawTerminalProps {
  rawOutput: string
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

  private emitResize(): void {
    const term = this.xtermInstance
    if (!term || !this.props.onResize) return
    if (term.cols <= 0 || term.rows <= 0) return
    this.props.onResize(term.cols, term.rows)
  }

  override componentDidMount() {
    this.initializeTerminal()
    if (this.xtermInstance && this.props.rawOutput) {
      this.xtermInstance.write(this.props.rawOutput)
    }
  }

  override componentDidUpdate(prevProps: RawTerminalProps) {
    if (!this.xtermInstance) return

    const currentData = this.props.rawOutput
    const prevData = prevProps.rawOutput

    // Optimized diff-based writing - only write new content
    if (currentData.startsWith(prevData)) {
      const newData = currentData.slice(prevData.length)
      if (newData) {
        this.xtermInstance.write(newData)
      }
    } else {
      // Session switch/truncate/etc - clear and rewrite
      this.xtermInstance.clear()
      this.xtermInstance.write(currentData)
    }
  }

  override componentWillUnmount() {
    if (this.xtermInstance) {
      this.xtermInstance.dispose()
    }
  }

  private initializeTerminal() {
    const term = new Terminal({
      cursorBlink: true,
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      fontFamily: 'monospace',
      fontSize: 14,
      scrollback: 5000,
      convertEol: true,
      allowTransparency: true,
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

    // CRITICAL: Expose terminal and serialize addon for E2E testing
    window.xtermTerminal = term
    window.xtermSerializeAddon = this.serializeAddon

    // Set up input handling
    this.setupInputHandling(term)
  }

  private setupInputHandling(term: Terminal) {
    const { onSendInput, onInterrupt, disabled } = this.props

    if (disabled) return

    const handleData = (data: string) => {
      if (data === '\u0003') {
        // Ctrl+C
        onInterrupt?.()
      } else {
        // Send input to PTY server (PTY will echo back for interactive sessions)
        onSendInput?.(data)
      }
    }

    term.onData(handleData)
  }

  override render() {
    return (
      <div ref={this.terminalRef} className="xterm" style={{ width: '100%', height: '100%' }} />
    )
  }
}
