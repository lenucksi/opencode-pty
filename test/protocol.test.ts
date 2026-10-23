import { describe, expect, it } from 'bun:test'

import {
  encodeMessage,
  isPush,
  isRequest,
  isResponse,
  type DaemonMessage,
  parseMessage,
} from '../src/daemon/protocol.ts'

/**
 * The wire, as the two processes that speak it see it.
 *
 * Newline-delimited JSON on a Unix socket: one message per line, requests carry an
 * `id`, pushes do not. Both sides parse whatever arrives - a truncated line, a
 * number, a message from a build that changed - so "not a message" has to be an
 * answer rather than an exception, and the three guards are how a daemon tells its
 * own replies from a client's requests.
 */

describe('encodeMessage', () => {
  it('writes one line per message', () => {
    expect(encodeMessage({ id: 1, method: 'ping' })).toBe('{"id":1,"method":"ping"}\n')
  })
})

describe('parseMessage', () => {
  it('reads a request back', () => {
    expect(parseMessage('{"id":1,"method":"ping","params":{}}')).toEqual({
      id: 1,
      method: 'ping',
      params: {},
    })
  })

  it('answers null for a line that is not JSON', () => {
    expect(parseMessage('{"id":1,')).toBeNull()
  })

  it('answers null for JSON that is not a message', () => {
    expect(parseMessage('42')).toBeNull()
    expect(parseMessage('null')).toBeNull()
    expect(parseMessage('"a string"')).toBeNull()
  })
})

describe('what a message is', () => {
  const request: DaemonMessage = { id: 1, method: 'spawn' }
  const response: DaemonMessage = { id: 1, result: { ok: true } }
  const failure: DaemonMessage = { id: 2, error: 'no such session' }
  const push: DaemonMessage = { method: 'raw_data', params: { data: 'x' } }

  it('tells a request from a notification', () => {
    expect(isRequest(request)).toBe(true)
    expect(isRequest(push)).toBe(false)
  })

  it('tells a reply from a request', () => {
    expect(isResponse(response)).toBe(true)
    expect(isResponse(failure)).toBe(true)
    // A request also has an `id`; what it does not have is a result to read.
    expect(isResponse(request)).toBe(false)
  })

  it('tells a notification from a request', () => {
    expect(isPush(push)).toBe(true)
    expect(isPush(request)).toBe(false)
  })
})
