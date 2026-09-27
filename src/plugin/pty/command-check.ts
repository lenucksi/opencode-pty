import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

/**
 * Decides whether a command can be executed, before handing it to the PTY.
 *
 * Why this exists: bun-pty reports some exec failures and not others. An
 * absolute path to a file without the execute bit fails cleanly - the spawn
 * throws `PTY spawn failed` and the reason reaches the model. A *relative* path
 * does not: the spawn returns a session, the pty helper then aborts on
 * `output.write(&bytes).is_ok()`, and a Bun crash dump lands in the buffer.
 * Worse, the abort never delivers the exit event, so the session keeps reporting
 * `running` for a process that died in the first second and no `<pty_exited>`
 * ever arrives. A model that spawns such a session reads `panic(main thread):
 * abort() called` and `oh no: Bun has crashed. This indicates a bug in Bun, not
 * your code`, and concludes the plugin is broken: eight turns were spent on that,
 * blaming the tool instead of the missing execute bit.
 *
 * So the only reliable place to catch this is before the spawn, while the
 * command is still just a string.
 *
 * The check is deliberately one-sided. It fails only when it can show that the
 * file exists and cannot be run. Anything inconclusive - a command that is not
 * on `PATH` at all, a `stat` that throws, an empty string - passes through to
 * the real spawn, because a wrong "this cannot run" blocks a command that would
 * have worked, while a wrong "this is fine" only costs the confusing error we
 * already had.
 */

export type ExecCheck = { ok: true } | { ok: false; reason: string }

const ok: ExecCheck = { ok: true }

/** Directories to search, from the spawn's environment. */
function pathDirs(env: Record<string, string | undefined>): string[] {
  const raw = env.PATH ?? env.Path ?? env.path
  if (raw === undefined || raw === '') return []
  return raw.split(delimiter).filter((dir) => dir !== '')
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The file a command would run, or null when that cannot be determined.
 *
 * A command containing a `/` is a path: a relative one resolves against the
 * workdir, which is what the kernel will do. One without is a `PATH` lookup.
 */
export function resolveCommand(
  command: string,
  workdir: string | undefined,
  env: Record<string, string | undefined>
): string | null {
  if (command === '') return null
  if (command.includes('/')) {
    return isAbsolute(command) ? command : resolve(workdir ?? process.cwd(), command)
  }
  for (const dir of pathDirs(env)) {
    const candidate = join(dir, command)
    if (isFile(candidate)) return candidate
  }
  return null
}

/** The first line of a file, or null when it cannot be read. */
function firstLine(path: string): string | null {
  try {
    const contents = readFileSync(path, 'utf8')
    const end = contents.indexOf('\n')
    return end === -1 ? contents : contents.slice(0, end)
  } catch {
    return null
  }
}

/**
 * A concrete interpreter to suggest, or null when there is none worth naming.
 *
 * The shebang is *parsed*, not substring-matched. Matching `sh` against the line
 * answers "sh" for `#!/usr/bin/env fish`, because `fish` ends in those two
 * letters - and telling a model to run a fish script with `sh` is a worse answer
 * than saying nothing, because it looks authoritative.
 *
 * A missing shebang gets `sh`: with no interpreter named anywhere in the file,
 * that is the only one that can be named without guessing the language.
 */
function interpreterHint(path: string): string | null {
  const line = firstLine(path)
  if (line === null) return null
  if (!line.startsWith('#!')) return 'sh'

  // `#!/usr/bin/env bash`, `#!/bin/sh`, `#!/usr/bin/python3.11` and
  // `#!/usr/bin/env -S python3 -u` all reduce to the last token that is not an
  // option: with `-S` the rest of the line is arguments to the interpreter, so
  // the interpreter is not the final word.
  const tokens = line
    .slice(2)
    .split(/[\s/]+/)
    .filter((token) => token !== '' && !token.startsWith('-'))
    .map((token) => token.replace(/\(.*/, ''))
  const last = tokens.at(-1)
  if (last === undefined) return null

  if (last === 'bash') return 'bash'
  if (last === 'sh' || last === 'dash' || last === 'ash') return 'sh'
  if (last.startsWith('python')) return 'python3'
  if (last.startsWith('node')) return 'node'
  return null
}

/**
 * Check a command, returning a model-facing reason when it cannot be executed.
 *
 * The reason names the resolved path and the fix, because the model is the one
 * that has to act on it. A missing execute bit is a two-second fix; a stack
 * trace naming a file the model never mentioned is not actionable.
 */
export function checkExecutable(
  command: string,
  workdir: string | undefined,
  env: Record<string, string | undefined>
): ExecCheck {
  const path = resolveCommand(command, workdir, env)
  if (path === null) return ok
  // Only a file that is there and cannot be run is a verdict. A directory, a
  // vanished path, or a directory we may not search all stay inconclusive and
  // are left to the real spawn.
  if (!isFile(path)) return ok
  if (canExecute(path)) return ok

  const interpreter = interpreterHint(path)
  return {
    ok: false,
    reason:
      `'${command}' resolves to ${path}, which exists but is not executable. ` +
      `Add the execute bit (chmod +x ${command})` +
      (interpreter === null
        ? ', or start it through whatever runs it.'
        : `, or start it through its interpreter (${interpreter} ${command}).`),
  }
}
