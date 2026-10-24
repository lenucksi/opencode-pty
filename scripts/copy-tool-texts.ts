/**
 * Copy the tool descriptions into `dist`.
 *
 * `tsc` emits JavaScript and declarations; the `.txt` file a tool imports as its
 * description is neither, so it is left behind. This used to be `bun x copyfiles`,
 * which downloads a package on every build - a build step that fetches its own
 * tool from the network is not reproducible, and two characters in its flags
 * decide whether the whole source tree or only the text files land in `dist`.
 *
 * Recursive by hand rather than by glob: the layout under `dist` must mirror
 * `src` exactly, because the tool modules import their description by a path
 * relative to themselves.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SOURCE = 'src'
/**
 * `dist`, with the source path kept: `tsc` emits from the repository root (rootDir
 * is `.`), so `src/plugin/pty/tools/spawn.txt` belongs at
 * `dist/src/plugin/pty/tools/spawn.txt` - not at `dist/plugin/...`, which is where a
 * `copyfiles -u 0` style copy lands and where the compiled tool cannot find it.
 */
const TARGET = 'dist'

/** How many tool descriptions the last copy found. */
let copied = 0

function copyTextFiles(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      copyTextFiles(path)
      continue
    }
    if (!entry.name.endsWith('.txt')) continue
    const target = join(TARGET, path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(path, target)
    copied += 1
  }
}

copyTextFiles(SOURCE)
if (copied === 0) {
  throw new Error(`no tool descriptions found under ${SOURCE}/ - did they move?`)
}
console.log(`Copied ${copied} tool description(s) to ${TARGET}/`)
