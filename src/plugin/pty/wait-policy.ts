/**
 * How a route waits.
 *
 * The wait tool is the same tool on every route, but the routes differ in what a
 * wait may cost. On OpenCode a model can wait as long as it likes - the host asks
 * no questions and the conversation carries the answer. On MCP the transport cuts a
 * call that takes too long, and a call that is cut says nothing about the session
 * it was waiting for. So the route says here what a wait may cost, and the tool
 * stays the same.
 */

/**
 * The cap for a wait without an explicit timeout, in seconds.
 *
 * Absent means no cap: the caller's own timeout, or none at all.
 */
export interface WaitPolicy {
  readonly maxSeconds?: number
  /**
   * How often the heartbeat runs, in milliseconds.
   *
   * The route's own clock: the transport's idle window is the route's business,
   * and so is how often the route has to say that it is still there.
   */
  readonly heartbeatMs?: number
  /**
   * Called while the wait runs, so a transport that needs a heartbeat gets one.
   *
   * The token is the progress token of the call in flight, when the route has
   * one: a progress notification without a token is not a progress notification.
   */
  readonly heartbeat?: (elapsedMs: number, progressToken?: string | number) => void
}

/**
 * What a route adds to the context the tools see.
 *
 * The progress token of the call in flight is the one thing a tool cannot know and
 * a route must say: it belongs to the request, and the tool is called with it.
 */
export interface RouteContext {
  readonly progressToken?: string | number
}

let _policy: WaitPolicy = {}

/** The policy of the route this process serves. */
export function setWaitPolicy(policy: WaitPolicy): void {
  _policy = policy
}

export function getWaitPolicy(): WaitPolicy {
  return _policy
}
