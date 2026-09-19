/**
 * SerializeAddon - serialize terminal buffer contents into a string that can be
 * written back to restore terminal state. Port of the xterm.js addon-serialize
 * addon for ghostty-web.
 *
 * Usage:
 * ```typescript
 * const serializeAddon = new SerializeAddon();
 * term.loadAddon(serializeAddon);
 * const content = serializeAddon.serialize();
 * ```
 */
import type { ITerminalAddon, ITerminalCore } from 'ghostty-web'
import { getTerminalBuffers, getTerminalMode } from './buffer-access.ts'
import { StringSerializeHandler } from './handlers.ts'
import { constrain } from './sgr.ts'
import type { IBuffer, ISerializeOptions, ISerializeRange } from './types.ts'

export type {
  IBuffer,
  IBufferCell,
  IBufferLine,
  ISerializeOptions,
  ISerializeRange,
  TerminalBuffers,
} from './types.ts'

export class SerializeAddon implements ITerminalAddon {
  private _terminal?: ITerminalCore

  public activate(terminal: ITerminalCore): void {
    this._terminal = terminal
  }

  public dispose(): void {
    this._terminal = undefined
  }

  public serialize(options?: ISerializeOptions): string {
    if (!this._terminal) {
      throw new Error('Cannot use addon until it has been loaded')
    }

    const buffer = getTerminalBuffers(this._terminal)

    if (!buffer) {
      return ''
    }

    const normalBuffer = buffer.normal ?? buffer.active
    const altBuffer = buffer.alternate

    if (!normalBuffer) {
      return ''
    }

    let content =
      !options?.excludeModes && getTerminalMode(this._terminal, 2031) ? '\u001b[?2031h' : ''
    content += options?.range
      ? this._serializeBufferByRange(normalBuffer, options.range, true)
      : this._serializeBufferByScrollback(normalBuffer, options?.scrollback)

    if (!options?.excludeAltBuffer && buffer.active?.type === 'alternate' && altBuffer) {
      const alternateContent = this._serializeBufferByScrollback(altBuffer, undefined)
      content += `\u001b[?1049h\u001b[H${alternateContent}`
    }

    return content
  }

  private _serializeBufferByScrollback(buffer: IBuffer, scrollback?: number): string {
    const maxRows = buffer.length
    const rows = this._terminal?.rows ?? 24
    const correctRows =
      scrollback === undefined ? maxRows : constrain(scrollback + rows, 0, maxRows)
    return this._serializeBufferByRange(
      buffer,
      {
        start: maxRows - correctRows,
        end: maxRows - 1,
      },
      false
    )
  }

  private _serializeBufferByRange(
    buffer: IBuffer,
    range: ISerializeRange,
    excludeFinalCursorPosition: boolean
  ): string {
    const terminal = this._terminal
    if (!terminal) {
      throw new Error('Cannot use addon until it has been loaded')
    }
    const handler = new StringSerializeHandler(buffer, terminal)
    const cols = terminal.cols ?? 80
    return handler.serialize(
      {
        start: { x: 0, y: range.start },
        end: { x: cols, y: range.end },
      },
      excludeFinalCursorPosition
    )
  }
}
