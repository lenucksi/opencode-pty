import type { Plugin } from '@opencode/plugin/tui'

import { findAnyHealthyOrigin, findAnyProjectOrigin } from './server.ts'

/**
 * Where this app's PTY server is, and the three ways to find out.
 *
 * The order is the whole point. Asking the server half over RPC is exact: the answer is read off
 * the live server object, so it needs no project key and cannot be stale. The origin record comes
 * next, filed under a directory - and that key cannot always be derived, which is the failure this
 * chain exists for: one long-lived `opencode serve --service` hosts the plugin for every project
 * the user opens, so the record sits under the directory THAT process was started in, and a panel
 * in any other project read "not running" beside a server that answered `/health`. The last step
 * takes any healthy record at all, which is a guess - kept because a panel with no server is worse
 * than one showing a list from another instance, and logged because it is a guess.
 *
 * Starting a server is deliberately NOT part of a plain poll: it creates and deletes a session,
 * which does not belong on a load path. Only the caller that the user asked (by expanding the
 * panel) passes `mayStart`.
 */

/** The scratch session the bootstrap runs in; a permanent row in the user's list would be worse. */
const BOOTSTRAP_TITLE = 'opencode-pty sidebar bootstrap'
const BOOTSTRAP_ATTEMPTS = 20
const BOOTSTRAP_INTERVAL_MS = 300

export interface OriginDeps {
  /** The host's client, for the one route that starts a server. */
  readonly client: Plugin.Context['client']
  /**
   * The raw RPC call to the server half.
   *
   * Raw on purpose: it throws when the host has no RPC at all, and rejects with the declared
   * `not_running` when none is listening. Both mean "look somewhere else" rather than "failed".
   */
  readonly ask: () => Promise<unknown>
  /** The project keys the record may be filed under, most specific first. */
  readonly keys: () => string[]
  /** Given the cause when a start attempt failed, so the header can name it. */
  readonly onStartError: (error: unknown) => void
  readonly debug: (event: string, detail?: unknown) => void
  /** Waiting, injectable so a test of the bootstrap does not spend its budget sleeping. */
  readonly sleep?: (ms: number) => Promise<void>
}

export interface OriginFinder {
  /** The origin, or null. Starts a server only when `mayStart` is set. */
  find(mayStart: boolean): Promise<string | null>
}

/**
 * The URL out of an RPC answer.
 *
 * Narrowed rather than trusted: a JSON Schema types its output as `unknown` in TypeScript, and
 * this crosses a process boundary - an answer that is not the shape the schema promised has to
 * read as "no answer", not as `undefined` reaching a fetch.
 */
export function originFromRpcAnswer(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null
  const url = (answer as { url?: unknown }).url
  return typeof url === 'string' && url.length > 0 ? url : null
}

/**
 * The project keys a record may be filed under, most specific first.
 *
 * The session's location is what the host hands a plugin; the app's default is where a server that
 * `autostart` started publishes. Empty and missing entries are dropped rather than probed: a
 * record is never written without a key, so there is nothing to find under one.
 */
export function projectKeys(session: string | undefined, fallback: string | undefined): string[] {
  const keys = session && session !== fallback ? [session, fallback] : [fallback]
  return keys.filter((key): key is string => typeof key === 'string' && key.length > 0)
}

export function createOriginFinder(deps: OriginDeps): OriginFinder {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))

  const askServerOrigin = async (): Promise<string | null> => {
    try {
      return originFromRpcAnswer(await deps.ask())
    } catch (error) {
      deps.debug('origin.rpc.failed', { error: String(error) })
      return null
    }
  }

  /** Ask, then the record by a key that can be named, then any record at all. */
  const look = async (): Promise<string | null> => {
    const asked = await askServerOrigin()
    if (asked !== null) return asked

    const keys = deps.keys()
    const attributed = await findAnyProjectOrigin(keys)
    if (attributed !== null) return attributed

    // Logged, because this is the step where the panel stops being able to tell one instance's
    // server from another's, and a wrong answer here is otherwise invisible.
    const unattributed = await findAnyHealthyOrigin()
    deps.debug('origin.unattributed', { keys, found: unattributed })
    return unattributed
  }

  /**
   * Start a server through the plugin's own command, then wait for it to say where it bound.
   *
   * The scratch session is removed either way: it exists to carry one command, and leaving it
   * behind would put a "sidebar bootstrap" row in the user's session list forever.
   */
  const start = async (): Promise<string | null> => {
    let sessionID: string | null = null
    let failure: unknown = null
    try {
      sessionID = (await deps.client.session.create({ title: BOOTSTRAP_TITLE })).id
      await deps.client.session.command({ sessionID, name: 'pty-show-server-url', text: '' })
    } catch (error) {
      failure = error
    }
    if (sessionID !== null) {
      await deps.client.session.remove({ sessionID }).catch((error: unknown) => {
        deps.debug('start.cleanup.failed', { sessionID, error: String(error) })
      })
    }
    if (failure !== null) {
      deps.onStartError(failure)
      return null
    }
    // The server publishes after binding, so this is a poll rather than a single check. Bounded:
    // one that never comes up must not spin.
    for (let attempt = 0; attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
      await sleep(BOOTSTRAP_INTERVAL_MS)
      const found = await look()
      if (found !== null) {
        deps.debug('start.done', { origin: found, attempt })
        return found
      }
    }
    return null
  }

  return {
    find: async (mayStart) => {
      const found = await look()
      if (found !== null) return found
      return mayStart ? start() : null
    },
  }
}
