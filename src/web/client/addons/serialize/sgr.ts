import type { IBufferCell } from './types.ts'

export function constrain(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high))
}

export function equalFg(cell1: IBufferCell, cell2: IBufferCell): boolean {
  return (
    cell1.getFgColorMode() === cell2.getFgColorMode() && cell1.getFgColor() === cell2.getFgColor()
  )
}

export function equalBg(cell1: IBufferCell, cell2: IBufferCell): boolean {
  return (
    cell1.getBgColorMode() === cell2.getBgColorMode() && cell1.getBgColor() === cell2.getBgColor()
  )
}

export function equalFlags(cell1: IBufferCell, cell2: IBufferCell): boolean {
  return (
    !!cell1.isInverse() === !!cell2.isInverse() &&
    !!cell1.isBold() === !!cell2.isBold() &&
    !!cell1.isUnderline() === !!cell2.isUnderline() &&
    !!cell1.isBlink() === !!cell2.isBlink() &&
    !!cell1.isInvisible() === !!cell2.isInvisible() &&
    !!cell1.isItalic() === !!cell2.isItalic() &&
    !!cell1.isDim() === !!cell2.isDim() &&
    !!cell1.isStrikethrough() === !!cell2.isStrikethrough()
  )
}

type ColorTarget = 'fg' | 'bg'

const COLOR_PARAMETERS: Record<
  ColorTarget,
  { base: number; brightBase: number; extended: number; reset: number }
> = {
  fg: { base: 30, brightBase: 90, extended: 38, reset: 39 },
  bg: { base: 40, brightBase: 100, extended: 48, reset: 49 },
}

function appendColorSequence(
  sgrSeq: number[],
  mode: number,
  color: number,
  target: ColorTarget
): void {
  const { base, brightBase, extended, reset } = COLOR_PARAMETERS[target]
  if (mode === 2 || mode === 3 || mode === -1) {
    sgrSeq.push(extended, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff)
  } else if (mode === 1) {
    if (color >= 16) {
      sgrSeq.push(extended, 5, color)
    } else {
      sgrSeq.push(color & 8 ? brightBase + (color & 7) : base + (color & 7))
    }
  } else {
    sgrSeq.push(reset)
  }
}

function hasDefaultFlags(cell: IBufferCell): boolean {
  return (
    !cell.isBold() &&
    !cell.isItalic() &&
    !cell.isUnderline() &&
    !cell.isBlink() &&
    !cell.isInverse() &&
    !cell.isInvisible() &&
    !cell.isDim() &&
    !cell.isStrikethrough()
  )
}

export function isAttributeDefault(cell: IBufferCell, nullCell: IBufferCell): boolean {
  const mode = cell.getFgColorMode()
  const bgMode = cell.getBgColorMode()

  if (mode === 0 && bgMode === 0) {
    return hasDefaultFlags(cell)
  }

  return (
    cell.getFgColor() === nullCell.getFgColor() &&
    cell.getBgColor() === nullCell.getBgColor() &&
    hasDefaultFlags(cell)
  )
}

export function diffStyle(
  cell: IBufferCell,
  oldCell: IBufferCell,
  nullCell: IBufferCell
): number[] {
  const sgrSeq: number[] = []
  const fgChanged = !equalFg(cell, oldCell)
  const bgChanged = !equalBg(cell, oldCell)
  const flagsChanged = !equalFlags(cell, oldCell)

  if (!fgChanged && !bgChanged && !flagsChanged) {
    return sgrSeq
  }

  if (isAttributeDefault(cell, nullCell)) {
    if (!isAttributeDefault(oldCell, nullCell)) {
      sgrSeq.push(0)
    }
    return sgrSeq
  }

  if (flagsChanged) {
    if (!!cell.isInverse() !== !!oldCell.isInverse()) {
      sgrSeq.push(cell.isInverse() ? 7 : 27)
    }
    if (!!cell.isBold() !== !!oldCell.isBold()) {
      sgrSeq.push(cell.isBold() ? 1 : 22)
    }
    if (!!cell.isUnderline() !== !!oldCell.isUnderline()) {
      sgrSeq.push(cell.isUnderline() ? 4 : 24)
    }
    if (!!cell.isBlink() !== !!oldCell.isBlink()) {
      sgrSeq.push(cell.isBlink() ? 5 : 25)
    }
    if (!!cell.isInvisible() !== !!oldCell.isInvisible()) {
      sgrSeq.push(cell.isInvisible() ? 8 : 28)
    }
    if (!!cell.isItalic() !== !!oldCell.isItalic()) {
      sgrSeq.push(cell.isItalic() ? 3 : 23)
    }
    if (!!cell.isDim() !== !!oldCell.isDim()) {
      sgrSeq.push(cell.isDim() ? 2 : 22)
    }
    if (!!cell.isStrikethrough() !== !!oldCell.isStrikethrough()) {
      sgrSeq.push(cell.isStrikethrough() ? 9 : 29)
    }
  }

  if (fgChanged) {
    appendColorSequence(sgrSeq, cell.getFgColorMode(), cell.getFgColor(), 'fg')
  }
  if (bgChanged) {
    appendColorSequence(sgrSeq, cell.getBgColorMode(), cell.getBgColor(), 'bg')
  }

  return sgrSeq
}
