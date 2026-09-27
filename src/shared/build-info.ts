/**
 * The identity of a running build.
 *
 * Kept hand-written and separate from the generated module so both the build
 * script and the consumers agree on the shape without the script having to
 * import a module that does not exist until it has run.
 */
export interface BuildInfo {
  /** Value of `version` in package.json. */
  version: string
  /**
   * Short commit hash, or `null` when the build had no Git checkout.
   *
   * `null` rather than a plausible-looking placeholder: a fabricated hash sends
   * someone looking for a commit that does not exist.
   */
  commit: string | null
  /** True when the checkout had uncommitted changes at build time. */
  dirty: boolean
}

/** What a build reports when nothing is known about it. */
export const UNKNOWN_BUILD: BuildInfo = { version: 'unknown', commit: null, dirty: false }

/**
 * One-line identity for display: `0.4.0 (3c60c5f)`.
 *
 * The commit is in parentheses rather than after a dash because the version is
 * what a human reads first and the hash is what they copy second.
 */
export function describeBuild(info: BuildInfo): string {
  const version = info.version === '' ? UNKNOWN_BUILD.version : info.version
  return info.commit === null ? version : `${version} (${info.commit})`
}
