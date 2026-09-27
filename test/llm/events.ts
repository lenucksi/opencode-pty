/**
 * Parse `opencode run --format=json` output into something a scenario can assert
 * on.
 *
 * The stream is NDJSON: one JSON object per line, in the order the host emitted
 * it. A malformed line is kept as a parse error rather than thrown away, because
 * "the host printed something this harness does not understand" is a harness bug
 * worth seeing instead of silently dropping.
 */

export interface RawEvent {
  type: string
  timestamp?: number
  sessionID?: string
  part?: Record<string, unknown>
  error?: { type?: string; message?: string }
}

export interface ToolInvocation {
  /** Tool name as the host reported it. */
  tool: string
  status: string
  /** `state.input`, serialised. Only ever used for diagnostics and regex probing. */
  input: string
  /** `state.output`, as delivered. */
  output: string
}

export interface StepUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export interface Transcript {
  events: RawEvent[]
  /** Lines that were not valid JSON, in order. */
  malformed: string[]
  /** Assistant text parts, in order. */
  texts: string[]
  /** Every tool call the host recorded, in order. */
  toolCalls: ToolInvocation[]
  /** One entry per finished step. */
  steps: StepUsage[]
  errors: Array<{ type: string; message: string }>
  sessionId: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readTokens(part: Record<string, unknown> | null): Omit<StepUsage, 'cost'> {
  const tokens = asRecord(part?.tokens)
  const cache = asRecord(tokens?.cache)
  return {
    input: asNumber(tokens?.input),
    output: asNumber(tokens?.output),
    reasoning: asNumber(tokens?.reasoning),
    cacheRead: asNumber(cache?.read),
    cacheWrite: asNumber(cache?.write),
  }
}

function readToolCall(event: RawEvent): ToolInvocation | null {
  const part = asRecord(event.part)
  if (!part) return null
  const state = asRecord(part.state)
  return {
    tool: asString(part.tool),
    status: asString(state?.status),
    input: serialiseInput(state?.input),
    output: asString(state?.output),
  }
}

/** Tool inputs are arbitrary JSON; keep them as text so probes stay simple. */
function serialiseInput(input: unknown): string {
  if (input === undefined) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return String(input)
  }
}

export function emptyTranscript(): Transcript {
  return {
    events: [],
    malformed: [],
    texts: [],
    toolCalls: [],
    steps: [],
    errors: [],
    sessionId: null,
  }
}

/** Parse a whole NDJSON stream. Tolerates CRLF and a missing trailing newline. */
export function parseEventStream(raw: string): Transcript {
  const transcript = emptyTranscript()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      transcript.malformed.push(trimmed)
      continue
    }
    const event = asRecord(parsed)
    if (!event) {
      transcript.malformed.push(trimmed)
      continue
    }
    const type = asString(event.type)
    const raw: RawEvent = { type }
    if (typeof event.timestamp === 'number') raw.timestamp = event.timestamp
    if (typeof event.sessionID === 'string') raw.sessionID = event.sessionID
    const part = asRecord(event.part)
    if (part !== null) raw.part = part
    const error = asRecord(event.error)
    if (error !== null) raw.error = error as RawEvent['error']
    transcript.events.push(raw)
    if (typeof event.sessionID === 'string') transcript.sessionId = event.sessionID

    switch (type) {
      case 'text': {
        const text = asString(part?.text)
        if (text !== '') transcript.texts.push(text)
        break
      }
      case 'tool_use': {
        const call = readToolCall(raw)
        if (call) transcript.toolCalls.push(call)
        break
      }
      case 'step_finish': {
        transcript.steps.push({
          ...readTokens(part),
          cost: asNumber(part?.cost),
        })
        break
      }
      case 'error': {
        transcript.errors.push({
          type: asString(error?.type),
          message: asString(error?.message),
        })
        break
      }
      default:
        break
    }
  }
  return transcript
}

export function totalUsage(transcript: Transcript): StepUsage {
  return transcript.steps.reduce<StepUsage>(
    (total, step) => ({
      input: total.input + step.input,
      output: total.output + step.output,
      reasoning: total.reasoning + step.reasoning,
      cacheRead: total.cacheRead + step.cacheRead,
      cacheWrite: total.cacheWrite + step.cacheWrite,
      cost: total.cost + step.cost,
    }),
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  )
}

/** Everything the assistant said, joined, for "did the answer contain X" probes. */
export function finalAnswer(transcript: Transcript): string {
  return transcript.texts.join('\n')
}
