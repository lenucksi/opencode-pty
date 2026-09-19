/**
 * Structural views of the ghostty-web terminal buffer. These mirror the
 * emulator's internal interfaces without importing its private types.
 */
export interface IBuffer {
  readonly type: 'normal' | 'alternate'
  readonly cursorX: number
  readonly cursorY: number
  readonly viewportY: number
  readonly baseY: number
  readonly length: number
  getLine(y: number): IBufferLine | undefined
  getNullCell(): IBufferCell
}

export interface IBufferLine {
  readonly length: number
  readonly isWrapped: boolean
  getCell(x: number): IBufferCell | undefined
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export interface IBufferCell {
  getChars(): string
  getCode(): number
  getWidth(): number
  getFgColorMode(): number
  getBgColorMode(): number
  getFgColor(): number
  getBgColor(): number
  isBold(): number
  isItalic(): number
  isUnderline(): number
  isStrikethrough(): number
  isBlink(): number
  isInverse(): number
  isInvisible(): number
  isFaint(): number
  isDim(): boolean
}

export type TerminalBuffers = {
  active?: IBuffer
  normal?: IBuffer
  alternate?: IBuffer
}

export interface ISerializeOptions {
  /**
   * The row range to serialize. When an explicit range is specified, the cursor
   * will get its final repositioning.
   */
  range?: ISerializeRange
  /**
   * The number of rows in the scrollback buffer to serialize, starting from
   * the bottom of the scrollback buffer. When not specified, all available
   * rows in the scrollback buffer will be serialized.
   */
  scrollback?: number
  /**
   * Whether to exclude the terminal modes from the serialization.
   * Default: false
   */
  excludeModes?: boolean
  /**
   * Whether to exclude the alt buffer from the serialization.
   * Default: false
   */
  excludeAltBuffer?: boolean
}

export interface ISerializeRange {
  /**
   * The line to start serializing (inclusive).
   */
  start: number
  /**
   * The line to end serializing (inclusive).
   */
  end: number
}
