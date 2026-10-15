import { candidateOrigins, originsForProject, readOrigins } from '../shared/runtime.ts'
import { decodeScreen, isPtyHealth, type PanelSession } from './lib.ts'

/**
 * Everything the panel needs from the PTY server, over HTTP.
 *
 * No TUI, no host API and no plugin state, so all of it is testable against a
 * real server - which is what the tests do. The panel lives in opencode's TUI
 * process while the `pty_*` tools live in the server process, so there is no
 * shared manager to read and this HTTP surface is the only window onto a session.
 */

/** A hung server must not stall a panel that is otherwise fine. */
const FETCH_TIMEOUT_MS = 2000

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Is a candidate address serving a PTY server?
 *
 * A published record is only a hint about where to look: a server that died
 * without cleaning up leaves one behind, and something else on the machine can
 * answer on a loopback port - CUPS owns `[::1]:631` and returns an HTML error page
 * there. The payload's shape is what tells the two apart.
 */
export async function isHealthy(origin: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${origin}/health`)
    return res.ok && isPtyHealth(await res.json())
  } catch (_) {
    return false
  }
}

/**
 * The address of a PTY server serving this project, or null.
 *
 * Only records this project published are considered, and each candidate is
 * confirmed by a health probe, so neither a stale record nor an unrelated service
 * on the same port is mistaken for a server.
 */
export async function findProjectOrigin(directory: string | undefined): Promise<string | null> {
  // No location means no key to look up by. Nothing is written without a key
  // either, so there is genuinely nothing to find rather than something to probe
  // for - "not running" is the truthful answer rather than a guess.
  if (!directory) return null
  for (const record of originsForProject(directory)) {
    for (const candidate of candidateOrigins(record)) {
      if (await isHealthy(candidate)) return candidate
    }
  }
  return null
}

/**
 * The first healthy origin among several project keys, most specific first.
 *
 * There is ONE record per server, filed under the location it was started for, while this panel
 * renders inside a session whose location can be a different directory: the host hands a plugin
 * the SESSION's location (`packages/tui/src/routes/session/index.tsx` sets it from
 * `session().location`), and a server that `autostart` started is filed under the app's DEFAULT
 * location. Move a session with `/cd` and the two part company - which is how a panel ends up
 * saying "not running" next to a server that answers /health. Trying both keys is the honest
 * answer; trying only one assumes a session that never moves.
 */
export async function findAnyProjectOrigin(
  directories: readonly (string | undefined)[]
): Promise<string | null> {
  for (const directory of directories) {
    const origin = await findProjectOrigin(directory)
    if (origin !== null) return origin
  }
  return null
}

/**
 * The first healthy origin among EVERY record this user has, ignoring the project key.
 *
 * A last resort, and it exists because the key cannot always be derived: one long-lived
 * `opencode serve --service` hosts this plugin for several projects at once, so the record is
 * filed under the location THAT process was started in - a directory no panel can compute from
 * its own session. The project keys are tried first, so this only fires when there is nothing to
 * attribute; and when it does, there is one server and it answers `/health`.
 *
 * The trade-off is stated rather than hidden: the records are per-user and 0700, so "every
 * record" is every server this user started. With two of them, a panel that could not find its
 * own may show the other one's list - which is still a better answer than "not running" beside a
 * server that answers, but it is not the same as being right.
 */
export async function findAnyHealthyOrigin(): Promise<string | null> {
  for (const record of readOrigins()) {
    for (const candidate of candidateOrigins(record)) {
      if (await isHealthy(candidate)) return candidate
    }
  }
  return null
}

/** The sessions the server knows about, live and archived. */
export async function listSessions(origin: string): Promise<PanelSession[]> {
  const res = await fetchWithTimeout(`${origin}/api/sessions`)
  if (!res.ok) throw new Error(`the server answered ${res.status}`)
  const body: unknown = await res.json()
  // An array today. The envelope is accepted so that a future shape reads as an
  // empty panel rather than as a failure.
  const list = Array.isArray(body) ? body : (body as { sessions?: unknown } | null)?.sessions
  return Array.isArray(list) ? (list as PanelSession[]) : []
}

/**
 * A session's screen, as the program currently draws it.
 *
 * The screen, not the raw bytes. `buffer/plain` is `Bun.stripANSI(raw)`: the ANSI
 * codes go, and the cursor movement goes with them, so a full-screen program arrives as
 * unpainted text with its layout gone. The screen endpoint replays the same bytes
 * through the same VT emulator `pty_screen` uses and answers the question a dialog
 * actually asks - what does this look like now.
 *
 * No `cols`/`rows`: the endpoint defaults to the geometry the process was given at
 * spawn and every `pty_resize` recorded, so the snapshot is the screen the program
 * believes it has. Asking for a different size would answer a different question, and
 * the dialog has no width to ask with.
 */
export async function readScreen(origin: string, id: string): Promise<string> {
  // The history the reader means by "scroll all the way up": the server prepends up to
  // this many scrollback rows before the visible screen. Rounded to the emulator's own
  // cap by the endpoint.
  const res = await fetchWithTimeout(`${origin}/api/sessions/${id}/screen${'?scrollback=2000'}`)
  if (!res.ok) throw new Error(`the server answered ${res.status}`)
  return decodeScreen(await res.json())
}

/**
 * Write bytes to a running session, exactly as the program behind it receives them.
 *
 * The same route the web UI's terminal uses (`onSendInput` in app.tsx). NO translation
 * happens here: what the caller sends is what the process reads, so a caller that means a
 * key has to send that key's bytes rather than its name.
 */
export async function writeInput(origin: string, id: string, data: string): Promise<void> {
  const res = await fetchWithTimeout(`${origin}/api/sessions/${id}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  if (!res.ok) throw new Error(`the server refused the request (${res.status})`)
}

/**
 * Drop a session from the server's store, killing it first when it is still
 * running.
 *
 * CLEANUP rather than a plain kill: cleanup deletes the entry, while a plain kill
 * keeps the session for log access - which is why the list only ever grew.
 */
export async function cleanupSession(origin: string, id: string): Promise<void> {
  const res = await fetchWithTimeout(`${origin}/api/sessions/${id}/cleanup`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`the server refused the request (${res.status})`)
}
