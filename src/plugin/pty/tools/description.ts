/**
 * The tool descriptions, per route.
 *
 * The text a model reads comes from one file per tool, with the parts that differ
 * between the routes filled in by the route. The OpenCode plugin is told about the
 * `<pty_exited>` message, because there is a conversation to deliver it into; the
 * MCP server is told that it has none, because there is not.
 *
 * One source, two fillings: a route with its own text file would drift from the
 * other one, and the difference would only show up as a model waiting for a
 * message that never comes.
 */

/** The routes that serve the tools. */
export type ToolRoute = 'opencode' | 'mcp'

/** What a route says where the text leaves a hole. */
const ROUTE_TEXT: Record<ToolRoute, Record<string, string>> = {
  opencode: {
    notifyOnExit: 'receive a `<pty_exited>` message when the process exits',
    completion:
      'To wait for completion prefer `pty_wait`, or `notifyOnExit` + `<pty_exited>`; never sleep+poll.',
    waitIntro: `Use this tool when you cannot go idle and wait for the \`<pty_exited>\` completion message, e.g., when
- Used with a \`/goal\` plugin which automatically resumes idle agents
- Used by a subagent whose parent interprets idleness as task completion`,
    completionSection: `Two supported strategies. Pick one; never invent a third.

1. **\\\`pty_wait({ id, timeoutSeconds? })\\\` - preferred.** It blocks inside the
   tool call until the session exits and returns the exit code plus the tail of
   the output. This is the right choice when you need the result to continue:
   the agent stays busy, so the parent session never sees an idle subagent.
   \\\`timeoutSeconds\\\` turns it into \\\`<pty_wait_timeout>\\\` instead of blocking
   forever.
2. **\\\`notifyOnExit: true\\\` + the future \\\`<pty_exited>\\\` message.** Use this for
   fire-and-forget processes while you do other work. Do not poll while you
   wait. If the message never arrives (notifications are unavailable on some
   hosts), do not wait indefinitely - use \\\`pty_wait\\\` instead.`,
    skill: 'See the `pty-usage` skill for the full guide.',
    notifyEffect:
      'The exit is delivered as a `<pty_exited>` message in the conversation that started the session.',
  },
  mcp: {
    notifyOnExit:
      'accepted, but this route has no conversation to deliver a message into - wait with `pty_wait` instead',
    completion:
      'To wait for completion use `pty_wait`: this route has no `<pty_exited>` message, and a wait answers on its own.',
    waitIntro: `Use this tool to wait for a session to finish: this route has no \`<pty_exited>\` message, so a wait is the only completion signal. A wait answers on its own, and a timeout answer asks you to call it again.`,
    completionSection: `One supported strategy: a wait.

**\\\`pty_wait({ id, timeoutSeconds? })\\\`.** It blocks inside the tool call until the
   session exits and returns the exit code plus the tail of the output. A wait
   without a timeout is capped here - the transport cuts a call that takes too
   long - and it answers with \\\`<pty_wait_timeout>\\\` when the cap is reached.
   Call it again to keep waiting.

\\\`notifyOnExit\\\` has no effect on this route: there is no conversation to deliver
the exit into. Wait for it instead of polling for it.`,
    skill: 'The `pty-usage` guide is available as an MCP prompt.',
    notifyEffect:
      'The exit is NOT delivered as a message on this route: there is no conversation to deliver it into. Use `pty_wait` to hear about the exit.',
  },
}

let _route: ToolRoute = 'opencode'

/**
 * The route this process serves.
 *
 * Set at startup, before a tool answers: the tools are the same on every route,
 * and what differs is what the route can promise.
 */
export function setToolRoute(route: ToolRoute): void {
  _route = route
}

export function getToolRoute(): ToolRoute {
  return _route
}

/**
 * The description of a tool, for a route.
 *
 * A hole the route does not fill stays a hole: an unfilled placeholder would be
 * read by a model, and it would say something the route does not do.
 */
export function describeForRoute(base: string, route: ToolRoute = _route): string {
  return base.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => ROUTE_TEXT[route][key] ?? whole)
}

/** What the route says about a promise it cannot keep. */
export function routeText(
  key: keyof (typeof ROUTE_TEXT)['opencode'],
  route: ToolRoute = _route
): string {
  return ROUTE_TEXT[route][key] ?? ''
}
