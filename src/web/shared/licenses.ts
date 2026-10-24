/**
 * Third-party notices, as the Licences tab of the docs dialog shows them.
 *
 * The package data is generated at build time from `bun pm licenses --json` (see
 * `scripts/licenses.ts`); this module only carries the shape, so the generator,
 * the server handler and the React client agree on it. The credits below are the
 * one hand-written part, because a project that is built on another project
 * cannot discover that fact from its lockfile.
 */

/** Where a package's copyright line came from, or that none could be found. */
export type CopyrightSource = 'license-file' | 'author-field' | 'none'

/** One installed package. `license` repeats the group's licence on purpose: a
 * flat reader (a test, a future export) should not have to walk the group. */
export interface LicensePackage {
  name: string
  version: string
  license: string
  /**
   * The copyright lines as the package's own licence file spells them - owner and
   * year, verbatim.
   *
   * MIT and BSD require the notice to travel with every copy, so it is not enough
   * to name the licence: the line has to be reproduced, which is what
   * `https://…/LICENSE` in a package's tarball is for and what a reader of this tab
   * needs to see.
   */
  copyright: string[]
  /**
   * `license-file` when the lines were read out of the package's own licence file,
   * `author-field` when it has none and the manifest's author is all there is,
   * `none` when even that is missing. A reader should be able to see which one they
   * are looking at rather than assume the notice is complete.
   */
  copyrightSource: CopyrightSource
}

/**
 * One licence body, reproduced once.
 *
 * The texts are grouped by their content, not by their identifier: two MIT
 * packages can ship differently worded files, and a licence id is not a text. Each
 * distinct body appears once, with the number of packages that carry it, so an
 * Apache-2.0 text of eleven kilobytes is not repeated 75 times.
 */
export interface LicenseText {
  /** The licence identifier this body was filed under. */
  license: string
  /** How many packages ship this exact body. */
  packageCount: number
  /** The body, verbatim apart from normalised line endings. */
  text: string
}

/** Installed packages under one licence, sorted by package name. */
export interface LicenseGroup {
  license: string
  /** Length of `packages`, carried so a collapsed group can be labelled. */
  count: number
  packages: LicensePackage[]
}

/** What the build writes into `dist/licenses.json`. */
export interface LicenseReport {
  total: number
  groups: LicenseGroup[]
  /** Every distinct licence body, once, largest group first. */
  texts: LicenseText[]
}

/** A project this repository is built on, named by hand. */
export interface LicenseCredit {
  name: string
  license: string
  note: string
  url: string
}

/** `GET /api/licenses`, the artifact plus the credits. */
export interface LicensesResponse extends LicenseReport {
  /**
   * False when the running build has no artifact (a checkout that was never
   * built). The credits are still served: they are hand-written and known.
   */
  available: boolean
  credits: readonly LicenseCredit[]
}

/**
 * The four projects this repository stands on.
 *
 * Deliberately short. The full dependency licence list is generated; these are
 * the ones a reader should know about without expanding a group of 300 package
 * names, including the fork and the local patch that are easy to miss.
 */
export const LICENSE_CREDITS: readonly LicenseCredit[] = [
  {
    name: 'OpenCode',
    license: 'MIT',
    note: 'The host that loads the plugin, its TUI half and the web interface.',
    url: 'https://opencode.ai/docs',
  },
  {
    name: 'bun-pty',
    license: 'MIT',
    note: 'The cross-platform PTY bindings every session runs on.',
    url: 'https://github.com/sursaone/bun-pty',
  },
  {
    name: 'ghostty-web',
    license: 'MIT',
    note: 'The VT parser behind pty_screen and the browser terminal. Pinned as a maintained fork with a local patch whose upstream pull request is still pending.',
    url: 'https://github.com/anomalyco/ghostty-web',
  },
  {
    name: 'shekohex/opencode-pty',
    license: 'MIT',
    note: 'The upstream project this repository forks.',
    url: 'https://github.com/shekohex/opencode-pty',
  },
]
