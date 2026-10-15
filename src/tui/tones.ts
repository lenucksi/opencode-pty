/**
 * The colour slots every surface of this plugin draws with, named rather than typed.
 *
 * Its own module because three surfaces need them - the sidebar, its output dialog and the session
 * panel - and three copies of a palette is three places for a rename to miss. Typed as `unknown`
 * because the host's resolved theme is a chain of optional lookups and the panel reads six slots,
 * not the whole type.
 */
export interface Tones {
  readonly base: unknown
  readonly muted: unknown
  readonly success: unknown
  readonly error: unknown
  readonly border: unknown
  readonly raised: unknown
}
