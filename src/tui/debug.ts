import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeDir } from '../shared/runtime.ts'

/**
 * The panel's event log, which is the only way to diagnose a TUI plugin.
 *
 * A TUI plugin has no console, and its wiring cannot be driven headlessly by the test
 * suite, so a small event log is the only way to see what an interaction did. Off by
 * default: it appends unboundedly, and a plugin that quietly grows a file forever is not
 * acceptable. `PTY_TUI_DEBUG=1` turns it on.
 *
 * Its own module because it is the one part of the wiring that writes to disk, and because a
 * file that is opened and closed here once is easier to reason about than the same code in the
 * middle of a plugin's setup.
 */

const DEBUG_ENV = 'PTY_TUI_DEBUG'

function debugEnabled(): boolean {
  const value = process.env[DEBUG_ENV]
  return typeof value === 'string' && value !== '' && value !== '0'
}

export function debug(event: string, detail?: unknown): void {
  if (!debugEnabled()) return
  try {
    // The runtime dir, so this lands beside the origin records: per-user and
    // already 0700, rather than a world-readable path in /tmp.
    const dir = runtimeDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail)}`
    appendFileSync(join(dir, 'tui-debug.log'), `${new Date().toISOString()} ${event}${suffix}\n`, {
      mode: 0o600,
    })
  } catch (_) {
    /* logging must never break the panel */
  }
}
