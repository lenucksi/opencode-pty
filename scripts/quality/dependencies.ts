import { captureCommand, runInherited } from './process.ts'

export const MINIMUM_BUN_VERSION = '1.4.2'
export const EXPECTED_PACKAGE_MANAGER = `bun@${MINIMUM_BUN_VERSION}`

export type SocketTokenEnvironment = Readonly<Record<string, string | undefined>>

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

export function parseOutdatedDependencies(output: string): string[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.slice(1)
}

export function socketToken(environment: SocketTokenEnvironment): string | undefined {
  return (
    environment.SOCKET_CLI_API_TOKEN?.trim() ||
    environment.SOCKET_SECURITY_API_TOKEN?.trim() ||
    undefined
  )
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

export async function runDependencyCheck(): Promise<void> {
  await runInherited('bun', ['audit'])
  const result = await captureCommand('bun', ['outdated'])
  const outdated = parseOutdatedDependencies(result.stdout)
  if (outdated.length > 0) {
    throw new Error(`Outdated direct dependencies:\n${outdated.join('\n')}`)
  }
  console.log('No outdated direct dependencies')
}
