/**
 * One thing to tell the reader.
 *
 * A notice is the plugin's way of saying "this is what I just did" to a surface
 * that has no other way of hearing it: a slash command's result is dropped by the
 * host, and a roll of the daemon changes machine state that nobody's window is
 * watching.
 *
 * It lives here, in `src/shared`, because the two halves of the plugin and the web
 * server all speak it, and none of them should have to load the others: the TUI
 * half turns it into a toast, the web interface renders it in a corner, and the
 * server half is the one that decides what it says.
 */

/** How a notice is dressed. The four a toast API knows. */
export type NoticeVariant = 'info' | 'success' | 'warning' | 'error'

/** One thing to tell the reader. */
export interface Notice {
  readonly message: string
  readonly variant: NoticeVariant
  /**
   * The id of the action that caused this notice, when there was one.
   *
   * The surface that starts an action makes the id up and puts it in the request;
   * the half that performs the action puts it back into the notice; the surface
   * that started it recognises its own and stays quiet, because it has already
   * shown the answer to the question it asked. Every other surface shows it -
   * which is how a roll started in the browser reaches the TUI, and the other way
   * round.
   *
   * Absent for a notice that no request caused, such as a command a human typed:
   * there is no surface to keep quiet.
   */
  readonly origin?: string
}

/**
 * The origin out of a request that carries one, or undefined.
 *
 * The id crosses a process boundary and arrives as whatever the other side sent, so
 * it is checked rather than trusted: anything that is not a non-empty string is no
 * id - and a notice without an origin is still a notice, one nobody suppresses.
 */
export function originFrom(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { actionId?: unknown }
  return typeof record.actionId === 'string' && record.actionId !== '' ? record.actionId : undefined
}

/**
 * The ids of the actions this surface started.
 *
 * A roll of the daemon is announced to every surface, and the surface that started
 * it already showed the answer to its own question - so it has to recognise its own
 * notice and stay quiet, or the reader is told the same thing twice. Every other
 * surface has no way of knowing the machine changed and shows it.
 *
 * Deliberately not a plain boolean: two surfaces can roll the daemon at nearly the
 * same time, and a mark that only said "somebody on this page asked" would suppress
 * the notice about the *other* page's roll as well.
 */
export class OriginClaim {
  private readonly ids = new Set<string>()

  /**
   * `make` is injectable so a test can say what the id is; the default is a uuid,
   * which is unique across surfaces without either of them coordinating.
   */
  constructor(
    private readonly make: () => string = () => crypto.randomUUID(),
    private readonly limit = 8
  ) {}

  /** A fresh id, remembered as this surface's own. */
  start(): string {
    const id = this.make()
    this.ids.add(id)
    // Bounded: an id whose notice never arrives - a roll that failed before it was
    // announced, a dropped event - must not accumulate for the life of the process.
    while (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value
      if (oldest === undefined) break
      this.ids.delete(oldest)
    }
    return id
  }

  /** Whether this notice is about an action this surface started. */
  owns(origin: string | undefined): boolean {
    if (origin === undefined) return false
    return this.ids.delete(origin)
  }
}
