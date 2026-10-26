/**
 * The first look, retried until it lands.
 *
 * The panel refreshes once at setup and then on a 2.5 s poll. That single first refresh runs
 * while the server half is still starting - it has not bound its web server yet, so the RPC
 * answer is `not_running` and there is no origin record either - and a refresh that finds
 * nothing returns at once. The next chance is a full poll interval away, so a boot that is
 * 300 ms slower than the panel costs 2.5 s of empty sidebar, which reads as "waiting for the
 * PTY daemon" because the daemon is what the server half was waiting for.
 *
 * This is that missing middle ground: ask a few more times, quickly, and stop for good at the
 * first list. It is bounded on both ends - `attempts` caps the burst, and `found()` ends it
 * early - so a machine with no server behaves exactly as before once the burst is spent.
 *
 * It never starts a server. Starting one means creating and deleting a session, which does not
 * belong on a load path; only a refresh the user asked for by expanding the panel may do that.
 */

/** How many extra looks a start gets before the ordinary poll takes over. */
export const FIRST_LOOK_ATTEMPTS = 12

/**
 * How long to wait between them.
 *
 * A quarter second, not the poll's 2.5: the server half finishes in hundreds of milliseconds
 * once its plugin setup is done, and this burst covers that window and no more.
 */
export const FIRST_LOOK_INTERVAL_MS = 250

export interface FirstLookDeps {
  /** One refresh, of the kind that must not start a server. */
  readonly refresh: () => Promise<void>
  /** Whether a server has been found yet. */
  readonly found: () => boolean
  /** A disposed plugin must not keep refreshing. */
  readonly disposed: () => boolean
  /** Waiting, injectable so a test does not spend the budget sleeping. */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Retry the first look until it finds something, or the attempts are spent.
 *
 * Returns as soon as `found()` is true - including when the setup refresh already won the
 * race, in which case nothing is refreshed here at all.
 */
export async function firstLookBurst(
  deps: FirstLookDeps,
  attempts: number = FIRST_LOOK_ATTEMPTS,
  intervalMs: number = FIRST_LOOK_INTERVAL_MS
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (deps.disposed() || deps.found()) return
    await sleep(intervalMs)
    if (deps.disposed()) return
    await deps.refresh()
    if (deps.found()) return
  }
}
