/**
 * Recover the `pty_*` calls a model actually made, from an opencode transcript.
 *
 * opencode 2.0.x does not hand a model the tool list directly. It wraps every
 * enabled tool in a Code Mode sandbox and exposes one `execute` tool, so a call
 * looks like `await tools.pty_read({ id, since: 100000 })` inside the JavaScript
 * the `execute` tool received. Denying `execute` on an agent removes the sandbox
 * *and* every tool in it, so there is no configuration that puts `pty_*` back on
 * the native list. Parsing the sandbox is therefore not a convenience here, it
 * is the only place the calls exist.
 *
 * Native calls are still recognised, so a future opencode that exposes the tools
 * directly keeps working.
 */

export const PTY_TOOL_NAMES = [
  'pty_spawn',
  'pty_write',
  'pty_read',
  'pty_screen',
  'pty_list',
  'pty_resize',
  'pty_wait',
  'pty_kill',
] as const

export type PtyToolName = (typeof PTY_TOOL_NAMES)[number]

/** The single `shell` tool name in this opencode generation; earlier ones used `bash`. */
export const SHELL_TOOL_NAMES = ['shell', 'bash'] as const

export type CallOrigin = 'native' | 'codemode'

export interface ToolCallRecord {
  name: string
  /** Verbatim argument text as written in the call, braces included. */
  args: string
  origin: CallOrigin
  /** The tool output the model received for this call, when it is available. */
  output: string
}

interface RawToolCall {
  tool: string
  input: string
  output: string
}

const PTY_NAME_SET: ReadonlySet<string> = new Set<string>(PTY_TOOL_NAMES)

export function isPtyToolName(name: string): name is PtyToolName {
  return PTY_NAME_SET.has(name)
}

/**
 * Extract `name(args)` pairs from a JavaScript source.
 *
 * The scan tracks bracket depth and skips string literals so a `)` inside
 * `sleep(3)` cannot end the argument list early, and it drops a match that only
 * appears inside a string or a comment: a commented-out `tools.pty_kill(...)`
 * is not a kill. Unbalanced source (a truncated tool call) yields the rest of
 * the source as the arguments rather than nothing, because a partial answer
 * beats a dropped one.
 */
export function extractCallsFromSource(source: string): Array<{ name: string; args: string }> {
  const live = codePositions(source)
  const found: Array<{ name: string; args: string }> = []
  const pattern = /tools\s*(?:\.\s*([A-Za-z_][\w]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*\(/g
  let match: RegExpExecArray | null = pattern.exec(source)
  while (match !== null) {
    const name = match[1] ?? match[2] ?? ''
    const openIndex = pattern.lastIndex - 1
    const closeIndex = findClosingParen(source, openIndex)
    if (live[match.index] === true) {
      found.push({ name, args: source.slice(openIndex + 1, closeIndex) })
    }
    pattern.lastIndex = closeIndex + 1
    match = pattern.exec(source)
  }
  return found
}

/** True for every index of `source` that is real code, not a string or comment. */
export function codePositions(source: string): boolean[] {
  const live: boolean[] = new Array<boolean>(source.length).fill(true)
  let quote: string | null = null
  let index = 0
  while (index < source.length) {
    const char = source[index] as string
    if (quote !== null) {
      live[index] = false
      if (char === '\\') {
        if (index + 1 < source.length) live[index + 1] = false
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      live[index] = false
      index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index)
      const end = newline === -1 ? source.length : newline
      for (let cut = index; cut < end; cut += 1) live[cut] = false
      index = end
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      for (let cut = index; cut < stop; cut += 1) live[cut] = false
      index = stop
      continue
    }
    index += 1
  }
  return live
}

/** Index of the `)` that closes the `(` at `openIndex`, or the end of the source. */
export function findClosingParen(source: string, openIndex: number): number {
  let depth = 0
  let index = openIndex
  let quote: string | null = null
  while (index < source.length) {
    const char = source[index] as string
    if (quote !== null) {
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index)
      index = newline === -1 ? source.length : newline
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  return source.length
}

/** The `code` property of an `execute` input, or null when it is not there. */
export function extractExecuteCode(input: string): string | null {
  if (input === '') return null
  try {
    const parsed: unknown = JSON.parse(input)
    if (typeof parsed === 'object' && parsed !== null) {
      const code = (parsed as Record<string, unknown>).code
      if (typeof code === 'string') return code
    }
  } catch {
    // Fall through to the textual probe below.
  }
  const match = /"code"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input)
  if (!match || match[1] === undefined) return null
  return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

/**
 * Every `pty_*` call in the transcript, in order, whether it reached the tool
 * natively or through the Code Mode sandbox.
 */
export function collectPtyCalls(toolCalls: readonly RawToolCall[]): ToolCallRecord[] {
  const calls: ToolCallRecord[] = []
  for (const call of toolCalls) {
    if (isPtyToolName(call.tool)) {
      calls.push({ name: call.tool, args: call.input, origin: 'native', output: call.output })
      continue
    }
    if (call.tool !== 'execute') continue
    const code = extractExecuteCode(call.input)
    if (code === null) continue
    for (const inner of extractCallsFromSource(code)) {
      if (!isPtyToolName(inner.name)) continue
      calls.push({ name: inner.name, args: inner.args, origin: 'codemode', output: call.output })
    }
  }
  return calls
}

/** Every shell command the model issued, native or through the sandbox. */
export function collectShellCommands(toolCalls: readonly RawToolCall[]): string[] {
  const commands: string[] = []
  const shellNames: ReadonlySet<string> = new Set<string>(SHELL_TOOL_NAMES)
  for (const call of toolCalls) {
    if (shellNames.has(call.tool)) {
      commands.push(readStringField(call.input, 'command') ?? call.input)
      continue
    }
    if (call.tool !== 'execute') continue
    const code = extractExecuteCode(call.input)
    if (code === null) continue
    for (const inner of extractCallsFromSource(code)) {
      if (!shellNames.has(inner.name)) continue
      const command = readStringField(inner.args, 'command')
      if (command !== null) commands.push(command)
    }
  }
  return commands
}

/** Read `key: "value"`, `key: 'value'` or `key: `value`` from an argument blob. */
export function readStringField(args: string, key: string): string | null {
  const pattern = new RegExp(
    `(?:"${key}"|'${key}'|\\b${key})\\s*:\\s*(?:"([^"]*)"|'([^']*)'|\\x60([^\\x60]*)\\x60)`,
    'm'
  )
  const match = pattern.exec(args)
  if (!match) return null
  return match[1] ?? match[2] ?? match[3] ?? null
}

/** Read `key: true` / `"key": false` from an argument blob. */
export function readBooleanField(args: string, key: string): boolean | null {
  const pattern = new RegExp(`(?:"${key}"|'${key}'|\\b${key})\\s*:\\s*(true|false)`, 'm')
  const match = pattern.exec(args)
  if (!match || match[1] === undefined) return null
  return match[1] === 'true'
}

/** Read `key: 123` or `"key": 123` from an argument blob. */
export function readNumberField(args: string, key: string): number | null {
  const pattern = new RegExp(`(?:"${key}"|'${key}'|\\b${key})\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'm')
  const match = pattern.exec(args)
  if (!match || match[1] === undefined) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/**
 * Every `nextSince` the model was ever shown.
 *
 * The point of the read-budget slice is that the cursor is handed to the caller
 * in the result tag, so a check that the model used *the cursor it was given*
 * has to be grounded in these values rather than in any number it typed.
 */
export function collectOfferedCursors(text: string): number[] {
  const cursors = new Set<number>()
  const pattern = /nextSince[=\\:"']+(-?\d+)/g
  let match: RegExpExecArray | null = pattern.exec(text)
  while (match !== null) {
    const value = Number(match[1])
    if (Number.isFinite(value)) cursors.add(value)
    match = pattern.exec(text)
  }
  return [...cursors].sort((left, right) => left - right)
}

/** Was any result the model received flagged as cut short? */
export function sawTruncationMarker(text: string): boolean {
  return /truncated[=\\:"']*true/.test(text) || /\[\s*truncated:/.test(text)
}

/** Did any result the model received claim to be the end of the data? */
export function sawEndOfBufferClaim(text: string): boolean {
  return /End of buffer/.test(text)
}
