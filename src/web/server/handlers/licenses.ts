import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { FileReader } from '../../../shared/file-reader.ts'
import {
  LICENSE_CREDITS,
  type LicenseGroup,
  type LicensePackage,
  type LicenseReport,
  type LicensesResponse,
} from '../../shared/licenses.ts'
import { JsonResponse } from './responses.ts'
import { SECURITY_HEADERS } from './security-headers.ts'

/**
 * Third-party notices for the Licences tab of the docs dialog.
 *
 * The package data is not in this source tree: `scripts/licenses.ts` writes it
 * into `dist/licenses.json` at build time, because it is generated from the
 * lockfile and committing it would leave the tree dirty after every build. This
 * handler reads that artifact per request, so a rebuild under a running server
 * is picked up on the next page load, exactly like a new bundle.
 *
 * Missing artifact is not an error. A checkout that was never built still has a
 * docs dialog, and it still knows its credits; it answers `available: false`
 * rather than a 404 the client would show as a broken tab.
 */

const PROJECT_ROOT = resolve(import.meta.dir, '../../../..').replace(/[\\/]dist$/, '')

/** Where the build puts the artifact. */
export const LICENSES_ARTIFACT_PATH = join(PROJECT_ROOT, 'dist', 'licenses.json')

const readFileOrNull: FileReader = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parsePackage(value: unknown): LicensePackage | null {
  if (!isRecord(value)) return null
  const { name, version, license } = value
  if (typeof name !== 'string' || name === '') return null
  if (typeof version !== 'string') return null
  if (typeof license !== 'string' || license === '') return null
  return { name, version, license }
}

function parseGroup(value: unknown): LicenseGroup | null {
  if (!isRecord(value) || typeof value.license !== 'string') return null
  if (!Array.isArray(value.packages)) return null
  const packages = value.packages
    .map(parsePackage)
    .filter((pkg): pkg is LicensePackage => pkg !== null)
  // The count is recomputed rather than trusted: a stale count would label a
  // collapsed group with a number its own list contradicts.
  return { license: value.license, count: packages.length, packages }
}

/**
 * Validate the artifact into the served shape.
 *
 * Rebuilt field by field instead of cast, so an artifact from another version of
 * the generator cannot smuggle an unexpected shape into the API. A report that
 * does not parse is `null`, which the handler treats like a missing file.
 */
export function parseLicenseReport(raw: string): LicenseReport | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.groups)) return null
  const groups = parsed.groups
    .map(parseGroup)
    .filter((group): group is LicenseGroup => group !== null)
  return {
    total: groups.reduce((sum, group) => sum + group.count, 0),
    groups,
  }
}

export function readLicenseReport(
  path: string = LICENSES_ARTIFACT_PATH,
  read: FileReader = readFileOrNull
): LicenseReport | null {
  const raw = read(path)
  return raw === null ? null : parseLicenseReport(raw)
}

/**
 * `GET /api/licenses`.
 *
 * Carries the security headers the older JSON handlers do not. They were left as
 * they are on purpose: `JsonResponse` is the response for every error path too,
 * and changing it would add a document CSP to answers nobody navigates to, in a
 * commit that is about a licence list. Here the headers come from the same
 * constant the static server uses, so there is one definition, not a second one.
 */
export function handleLicenses(path: string = LICENSES_ARTIFACT_PATH): JsonResponse {
  const report = readLicenseReport(path)
  const payload: LicensesResponse = report
    ? { available: true, ...report, credits: LICENSE_CREDITS }
    : { available: false, total: 0, groups: [], credits: LICENSE_CREDITS }
  return new JsonResponse(payload, 200, SECURITY_HEADERS)
}
