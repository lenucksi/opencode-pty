/**
 * Wire protocol for the opencode-pty daemon.
 *
 * Newline-delimited JSON over a Unix socket. Each message is one JSON object
 * on one line. Requests carry an `id`; responses echo it. Push notifications
 * from the daemon have no `id`.
 *
 * Request:  {"id":1,"method":"spawn","params":{"command":"bun","args":["run","dev"]}}
 * Response: {"id":1,"result":{"id":"pty_a1b2c3d4","cols":240,"rows":80}}
 * Error:    {"id":1,"error":"command not found"}
 * Push:     {"method":"raw_data","params":{"id":"pty_a1b2c3d4","data":"...","offset":1234}}
 * Push:     {"method":"session_update","params":{"id":"pty_a1b2c3d4","status":"exited","exitCode":0}}
 */

export interface DaemonRequest {
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface DaemonResponse {
  id: number
  result?: unknown
  error?: string
}

export interface DaemonPush {
  method: string
  params: Record<string, unknown>
}

export type DaemonMessage = DaemonRequest | DaemonResponse | DaemonPush

export function encodeMessage(msg: DaemonMessage): string {
  return JSON.stringify(msg) + '\n'
}

export function parseMessage(line: string): DaemonMessage | null {
  try {
    const parsed = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as DaemonMessage
  } catch {
    return null
  }
}

export function isRequest(msg: DaemonMessage): msg is DaemonRequest {
  return 'id' in msg && 'method' in msg
}

export function isResponse(msg: DaemonMessage): msg is DaemonResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg)
}

export function isPush(msg: DaemonMessage): msg is DaemonPush {
  return 'method' in msg && !('id' in msg)
}
