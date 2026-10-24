import { captureCommand, runInherited } from './process.ts'

export const MINIMUM_BUN_VERSION = '1.4.4'
export const EXPECTED_PACKAGE_MANAGER = `bun@${MINIMUM_BUN_VERSION}`

function versionParts(version: string): [number, number, number] | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  const [, major, minor, patch] = match
  if (major === undefined || minor === undefined || patch === undefined) return null
  return [Number(major), Number(minor), Number(patch)]
}

export function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  if (!leftParts || !rightParts) throw new Error(`Invalid semantic version: ${left} or ${right}`)
  for (let index = 0; index < leftParts.length; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

export function validateBunToolchain(actualVersion: string, packageManager: string): void {
  if (packageManager !== EXPECTED_PACKAGE_MANAGER) {
    throw new Error(`packageManager must be ${EXPECTED_PACKAGE_MANAGER}`)
  }
  if (compareVersions(actualVersion, MINIMUM_BUN_VERSION) < 0) {
    throw new Error(`Bun ${MINIMUM_BUN_VERSION}+ is required; found ${actualVersion}`)
  }
}

/** How long one registry lookup may take before it counts as unknown. */
const REGISTRY_TIMEOUT_MS = 3000

export function parseOutdatedDependencies(output: string): string[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.slice(1)
}

/**
 * How long a release must have existed before this gate calls a dependency
 * outdated.
 *
 * Read from `renovate.json` so the window has exactly one home: the gate and the
 * bot then cannot disagree about what "too new" means. Without this the gate was
 * STRICTER than the policy - it demanded the newest version the instant it was
 * published, which is the opposite of waiting a day for a release to settle, and
 * it turned every publish into a red gate.
 */
export async function minimumReleaseAgeDays(): Promise<number> {
  const renovate: unknown = await Bun.file('renovate.json').json()
  if (typeof renovate !== 'object' || renovate === null) return 0
  const age = (renovate as Record<string, unknown>).minimumReleaseAge
  if (typeof age === 'string') {
    const match = /^(\d+)\s*(day|days|hour|hours|minute|minutes)?$/.exec(age.trim())
    if (!match) return 0
    const amount = Number(match[1])
    return match[2]?.startsWith('hour') || match[2]?.startsWith('minute') ? amount / 24 : amount
  }
  return 0
}

/**
 * The outdated rows a release-age window excuses, named.
 *
 * `bun outdated` prints a table, not JSON, so the age of each candidate is asked
 * of the registry. A lookup that fails counts as "old enough": the gate must not
 * pass because the network was down, and the audit step above it is what
 * actually guards against vulnerable versions.
 */
export async function excuseRecentReleases(
  rows: string[],
  ageDays: number,
  // The VERSION, not the row, on purpose. Handing the row over meant a caller had to
  // re-parse it to find out which version was being asked about, so no test could observe
  // that choice without duplicating the parsing - and the first version of this fix shipped
  // with a green suite that way, while the wiring read the wrong column. With the version
  // passed explicitly, "which version is this asking about" is directly assertable.
  publishedAt: (name: string, version: string) => Promise<number | null> = registryPublishTime,
  now: number = Date.now()
): Promise<string[]> {
  if (ageDays <= 0 || rows.length === 0) return rows
  const cutoff = now - ageDays * 24 * 60 * 60 * 1000
  const findings = rows.filter((row) => {
    // The table's own furniture is not a dependency. `bun outdated` frames its
    // rows with separator lines and prints a header, and once the real findings
    // are excused those two are all that is left - so keeping them made an empty
    // result still fail the gate, with an error message showing an empty table.
    if (isOutdatedRowNoise(row)) return false
    // Not recognisable as furniture: kept, so a parsing regression fails loudly
    // instead of passing quietly.
    return outdatedRowName(row).length > 0
  })
  // Concurrently, and with a bounded lookup in `registryPublishTime`: done one
  // after another with an unbounded fetch, a slow registry took this step past its
  // three-minute budget and the gate failed on its own freshness check.
  const ages = await Promise.all(
    findings.map((row) => publishedAt(outdatedRowName(row), outdatedRowTarget(row)))
  )
  return findings.filter((_, index) => {
    const published = ages[index] ?? null
    // Unknown age counts as old enough: the gate must not pass because the registry
    // was unreachable, and `bun audit` is what guards vulnerabilities.
    if (published === null) return true
    return published <= cutoff
  })
}

/**
 * The package name in an outdated row, or empty when the row has none.
 *
 * `bun outdated` annotates the name with where it comes from - `(dev)`,
 * `(optional)` - and those annotations are not part of the name. Asking the
 * registry for `@vitejs/plugin-react (dev)` is a 404, which reads as "date
 * unknown", which reads as "old enough", and the gate then fails on a release it
 * meant to wait out. So the annotation is stripped before the lookup.
 */
/**
 * Whether an outdated row is the table's own furniture.
 *
 * Exactly two shapes: a separator line of dashes and pipes, and the header whose
 * first cell is the literal word `Package`. Anything else is treated as a finding,
 * which is what keeps a parsing regression from turning the gate green.
 */
export function isOutdatedRowNoise(row: string): boolean {
  const trimmed = row.trim()
  if (/^[-|\s]+$/.test(trimmed)) return true
  return (trimmed.split('|')[1]?.trim().toLowerCase() ?? '') === 'package'
}

export function outdatedRowName(row: string): string {
  const cell = row.split('|')[1]?.trim() ?? ''
  return cell.replace(/\s*\((?:dev|optional|peer)\)\s*$/, '').trim()
}

/**
 * The version an outdated row would actually move to, or empty when it names none.
 *
 * `bun outdated` prints three version columns - Current, Update, Latest - and which one a
 * bump lands on depends on how the dependency is declared. Reading only `Update` gets an
 * exactly-pinned dependency wrong: for `@opencode/theme` pinned at `2.0.23`, Update is also
 * 2.0.23, because there is nothing a `bun update` could install within an exact pin, while
 * Latest is 2.0.24, which is what a manifest edit would take.
 *
 * That is not cosmetic. The age lookup treats an unnamed version as "old enough", and the
 * gate excuses a release younger than `minimumReleaseAge`. So `Update` alone made the gate
 * unable to wait out a bump for an exactly-pinned dependency AT ALL, and it demanded that
 * same-day bump instead - which is precisely the failure `minimumReleaseAge` exists to
 * prevent, and the one AGENTS.md records as "a gate stricter than the policy it enforces
 * will fail on every publish".
 *
 * The symptom was one package giving two answers in the same run: the `@opencode/theme`
 * `(dev)` row looked up 2.0.23 and failed the gate, the `(peer)` row looked up 2.0.24 and
 * waited it out.
 */
export function outdatedRowTarget(row: string): string {
  const cells = row.split('|')
  const current = cells[2]?.trim() ?? ''
  const update = cells[3]?.trim() ?? ''
  const latest = cells[4]?.trim() ?? ''
  // A range the current version already satisfies can move within itself.
  if (update.length > 0 && update !== 'Latest' && update !== current) return update
  // An exact pin, or a range that has already moved out: the manifest has to change, so
  // the newest release is the candidate.
  // A row whose newest release is the current one names no candidate at all. Such a row
  // does not appear in `bun outdated`, but answering '8.3.0' for it would name a version
  // to wait for that is by definition the one already installed.
  if (latest.length > 0 && latest !== 'Latest' && latest !== current) return latest
  return ''
}

/** When `version` of `name` was published, or null if unknown. */
async function registryPublishTime(name: string, version: string): Promise<number | null> {
  const wanted = version
  if (!wanted) return null
  try {
    // Bounded, because this runs inside a quality gate with its own budget: an
    // unbounded fetch that hangs would spend it here rather than on a check.
    const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { time?: Record<string, string> }
    const stamp = body.time?.[wanted]
    return stamp ? Date.parse(stamp) : null
  } catch (_) {
    return null
  }
}

export async function runBunToolchainCheck(): Promise<void> {
  const packageJson: unknown = await Bun.file('package.json').json()
  if (typeof packageJson !== 'object' || packageJson === null || Array.isArray(packageJson)) {
    throw new Error('package.json must be an object')
  }
  const record: Record<string, unknown> = { ...packageJson }
  const packageManager = record.packageManager
  if (typeof packageManager !== 'string') throw new Error('packageManager must be a string')
  validateBunToolchain(Bun.version, packageManager)
  console.log(`Bun ${Bun.version}; packageManager ${packageManager}`)
}

export async function runDependencyCheck(timeoutMs = 0): Promise<void> {
  // Unscoped, and it stays that way. A `file:` install copies, a devDependency is audited
  // like any other, and the temptation when a build-time advisory appears is to narrow the
  // check until it is quiet. The alternative taken here was an `overrides` entry for
  // `seroval`, which fixes the advisory for `bun audit` and for Aislop's own
  // `security/vulnerable-dependency` rule at once - and `seroval-plugins` declares
  // `seroval` as a peer of `^1.0`, so 1.6.8 is inside the range its own package asks for.
  // Unscoped, at every severity, and with no `--ignore`: an advisory the gate cannot
  // fix is an override with a written expiry, not a silence. `--audit-level` is
  // deliberately not used either - it would drop every moderate and low advisory.
  await runInherited('bun', ['audit'], { timeoutMs })
  const result = await captureCommand('bun', ['outdated'], { timeoutMs })
  const reported = parseOutdatedDependencies(result.stdout)
  const ageDays = await minimumReleaseAgeDays()
  const outdated = await excuseRecentReleases(reported, ageDays)
  // Counted before and after, both excluding the table's own furniture: counting
  // it turned one waited-out release into "5", which reads as five dependencies
  // being held back when there is one.
  const findings = reported.filter((row) => !isOutdatedRowNoise(row))
  const waited = findings.filter((row) => !outdated.includes(row))
  if (waited.length > 0) {
    // Said out loud rather than silently passing: a release inside the window is
    // skipped on purpose, and the next run will pick it up.
    console.log(`Waiting out ${waited.length} release(s) younger than ${ageDays} day(s)`)
  }
  if (outdated.length > 0) {
    throw new Error(`Outdated direct dependencies:\n${outdated.join('\n')}`)
  }
  console.log('No outdated direct dependencies')
}
