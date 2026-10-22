/**
 * What the sidebar knows about the daemon behind the list.
 *
 * The daemon is machine state, not panel state: every opencode instance on the
 * machine talks to the same daemon over one socket, so the sidebar's line about
 * it is a report on the machine. The footer is where the sidebar says what is
 * not a session, and this is what it says.
 *
 * Separate from the session list's own state, because the two have nothing to
 * do with each other: a list of sessions can be right while the daemon's line is
 * wrong, and neither transition says anything about the other.
 */

/** What the line says. */
export interface DaemonStatus {
  /** Whether a roll is running right now. */
  readonly restarting: boolean
  /** The daemon's pid, once a roll has reported one. */
  readonly pid: number | null
}

/** Nothing known yet: the line offers the roll and names no daemon. */
export const DAEMON_IDLE: DaemonStatus = { restarting: false, pid: null }

/**
 * The footer's daemon line.
 *
 * The action is on the line, because the line is the only place in the sidebar
 * that talks about the machine rather than about a session.
 */
export function daemonLabel(status: DaemonStatus): string {
  if (status.restarting) return 'daemon · restarting…'
  return status.pid === null ? 'daemon · restart' : `daemon ${status.pid} · restart`
}

/**
 * Whatever holds the daemon's status.
 *
 * Structural, so this module does not have to know about the panel's own state:
 * the panel's state satisfies it, and so does a test's two-line object.
 */
export interface DaemonHolder {
  daemon: DaemonStatus
}

/**
 * A roll started.
 *
 * The line says so while it runs: a roll takes a second or two, and a line that
 * does not move reads as a click that did nothing.
 */
export function noteDaemonRestarting(state: DaemonHolder): void {
  state.daemon = { restarting: true, pid: state.daemon.pid }
}

/**
 * The roll is over, whatever it did.
 *
 * The pid is what the roll reported, so the line can name the daemon that is
 * running now.
 */
export function noteDaemonRestarted(state: DaemonHolder, pid: number | null): void {
  state.daemon = { restarting: false, pid }
}
