import type { Plugin } from '@opencode/plugin/tui'
import type { MouseEvent } from '@opentui/core'

import { isFinished, type PanelSession } from './lib.ts'
import {
  noteDialogClosed,
  noteDialogOpened,
  noteDialogOutput,
  noteDialogTick,
  type PanelState,
} from './panel-state.ts'
import { dialogRows, dialogSize, outputDialogView, type Tones } from './render.ts'
import { cleanupSession, readScreen, writeInput } from './server.ts'

/**
 * What a person can do to a session from the panel, and what each one costs.
 *
 * Split out of the plugin entry so that the decisions - confirm before killing a
 * live process, act at once on a record, never race a teardown - sit in one place
 * that is about behaviour rather than about wiring.
 */

/** How often an open dialog re-reads its buffer. Matches the list's cadence. */
const DIALOG_POLL_MS = 2500

type ToastVariant = 'info' | 'warning' | 'error'

export interface ActionDeps {
  readonly context: Plugin.Context
  /** The panel's live state. Read for decisions, never mutated here. */
  readonly state: PanelState
  readonly update: (mutate: (draft: PanelState) => void) => void
  /** Re-list. `force` for a refresh the user is waiting on. */
  readonly refresh: (mayStart?: boolean, force?: boolean) => Promise<void>
  readonly notify: (message: string, variant: ToastVariant) => void
  /**
   * The origin this app's server published, under whichever key it was filed.
   *
   * A lookup rather than a directory: the server is filed under the location it was STARTED
   * for, and this panel runs inside a session that can be elsewhere - see
   * `findAnyProjectOrigin`.
   */
  readonly findOrigin: () => Promise<string | null>
  readonly debug: (event: string, detail?: unknown) => void
  /**
   * The theme slots to draw with.
   *
   * Passed in rather than read from `context.theme` here, because the sidebar and the
   * session panel need the same six, and three copies of a palette is three places for a
   * rename to miss.
   */
  readonly tones: () => Tones
}

export interface Actions {
  removeSession(session: PanelSession): Promise<void>
  confirmRemove(session: PanelSession): void
  clearFinished(): Promise<void>
  openOutput(session: PanelSession): Promise<void>
  /** Ask for a line and write it to the process, with a newline appended. */
  sendInput(session: PanelSession): Promise<void>
  /** The header's clear handler, which must stop the click reaching the toggle. */
  onClear(event: MouseEvent): void
}

/**
 * The outcome of an action that needed a server.
 *
 * `ran` and the action's own answer are separate questions, and conflating them was
 * a real bug found by a test: a refusal from the server still means the action ran,
 * so reporting success on `ran` told a user their session was gone while its row
 * stayed on screen.
 */
export interface Outcome<Value> {
  /** Whether the action reached a server at all. */
  readonly ran: boolean
  /** What the action itself reported, when it ran. */
  readonly result: Value | undefined
}

/**
 * Run an action against the server, resolving its address first if needed.
 *
 * `quiet` is for the read path: a buffer read that finds no server should say so
 * once, not toast on every poll tick.
 */
export async function withOrigin<Value>(
  deps: ActionDeps,
  action: (origin: string) => Promise<Value>,
  quiet = false
): Promise<Outcome<Value>> {
  const known = deps.state.origin
  if (known !== null) return { ran: true, result: await against(deps, known, action) }
  const found = await deps.findOrigin()
  if (found === null) {
    if (!quiet) deps.notify('PTY server unavailable', 'warning')
    return { ran: false, result: undefined }
  }
  return { ran: true, result: await against(deps, found, action) }
}

async function against<Value>(
  deps: ActionDeps,
  origin: string,
  action: (origin: string) => Promise<Value>
): Promise<Value> {
  deps.update((draft) => {
    draft.origin = origin
  })
  return action(origin)
}

/**
 * Ask the reader for a line and hand it to the process.
 *
 * A COMMAND LINE, and not key forwarding, because key forwarding is not available: a plugin
 * gets named commands from `context.keymap` and no raw key events, so typing would mean
 * binding every printable key separately - and `q`, the key every full-screen program uses to
 * quit, is already bound by the host's `diff.close`, whose command carries no `enabled`
 * predicate and is therefore reachable at any time. `ui.dialog.prompt` is the one input the
 * SDK genuinely offers: the host renders the field, handles editing and history, and returns
 * the string. That reaches everything a program reads as text - `q`, `k`, `1`, `/pattern`,
 * `H` - which is the whole reason the view is usable rather than a screenshot.
 *
 * The newline is appended here rather than asked for, because a reader who types `q` means
 * the key and not a prompt. A line that already ends in one is sent as it stands, so a
 * deliberate empty Enter is still possible.
 */
export function createSendInput(deps: ActionDeps) {
  return async (session: PanelSession): Promise<void> => {
    // Nothing to write to: the process is gone, and the server would answer 400 for every
    // attempt. Checked before anything else, so no input field opens for it.
    if (isFinished(session)) {
      deps.notify('That session has ended', 'warning')
      return
    }
    const label = session.title || session.id

    // The origin is resolved BEFORE the prompt opens, and that ordering is the fix for a
    // real flaw: asking first meant a reader with no server to talk to was prompted for a
    // line that could not be delivered anywhere. A test caught it - it asserted "no prompt
    // without a server" and watched the prompt appear anyway.
    // `sent` and not `outcome.ran`: `ran` only says the ORIGIN was found. Reporting success
    // from it claimed "Sent to ..." after the reader pressed Escape in the field, which is a
    // confirmation of something that did not happen - and a confirmation is exactly what a
    // reader trusts when the program then ignores the key they typed.
    let sent = false
    try {
      const outcome = await withOrigin(deps, async (origin) => {
        const typed = await deps.context.ui.dialog.prompt({
          title: `Send to ${label}`,
          description: 'One line. It reaches the program as if typed, plus Enter.',
          placeholder: 'q',
        })
        if (typed === undefined) return
        if (typed.trim().length === 0) return

        const data = typed.endsWith('\n') ? typed : `${typed}\n`
        await writeInput(origin, session.id, data)
        sent = true
        deps.debug('input.sent', { id: session.id, chars: data.length })
      })
      // `ran === false` already toasted "PTY server unavailable"; nothing was sent either way.
      if (!outcome.ran) return
    } catch (error) {
      deps.notify(`Not sent: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }

    if (sent) deps.notify(`Sent to ${label}`, 'info')
  }
}

/**
 * Remove one session.
 *
 * The success toast sits outside the removal's own `try`, so a throwing toast
 * cannot be mistaken for a rejected delete and reported as one.
 */
export function createRemoveSession(deps: ActionDeps) {
  return async (session: PanelSession): Promise<void> => {
    const label = session.title || session.id
    const { ran, result } = await withOrigin(deps, async (origin) => {
      try {
        await cleanupSession(origin, session.id)
        deps.debug('remove.done', { id: session.id })
        return true
      } catch (error) {
        deps.notify(`Could not remove ${label}: ${String(error)}`, 'error')
        deps.debug('remove.failed', { id: session.id, error: String(error) })
        return false
      }
    })
    // The success toast needs the action's OWN answer, not merely that the request
    // left the panel.
    if (ran && result === true) deps.notify(`Removed ${label}`, 'info')
    // force: the user is waiting for this one.
    await deps.refresh(false, true)
  }
}

/**
 * Removing a RUNNING session kills a live process, so it is confirmed; a finished
 * one is only a record, so its ✕ acts at once.
 *
 * Only `running` earns the question. A `killing` session has already been asked to
 * die - cleanup merely drops the record - so asking there would present a question
 * with exactly one sane answer. That is also why `isFinished`, which drives
 * clear-finished, excludes `killing`: it must not race the process teardown.
 */
export function createConfirmRemove(deps: ActionDeps, remove: (s: PanelSession) => Promise<void>) {
  return (session: PanelSession): void => {
    deps.debug('row.remove', { id: session.id, status: session.status })
    if (session.status !== 'running') {
      void remove(session)
      return
    }
    void deps.context.ui.dialog
      .confirm({
        title: 'Remove PTY session',
        message: `Kill the running session “${session.title || session.id}” and remove it?`,
        label: { confirm: 'Remove', cancel: 'Keep' },
      })
      .then((confirmed: boolean | undefined) => {
        if (confirmed === true) void remove(session)
      })
      .catch((error: unknown) => deps.debug('row.remove.confirm.failed', { error: String(error) }))
  }
}

/** Drop every finished session. Never touches a running one, so no question. */
export function createClearFinished(deps: ActionDeps) {
  return async (): Promise<void> => {
    const targets = deps.state.sessions.filter(isFinished)
    if (targets.length === 0) return
    const { ran } = await withOrigin(deps, async (origin) => {
      const results = await Promise.all(
        targets.map((session) =>
          cleanupSession(origin, session.id).then(
            () => true,
            () => false
          )
        )
      )
      const failed = results.filter((ok) => !ok).length
      // A partial failure is reported: the rows that went are gone, and reporting
      // all of them as gone would be a lie the list then tells.
      if (failed > 0) {
        deps.notify(`Could not remove ${failed} of ${targets.length} finished sessions`, 'error')
      }
      return failed
    })
    // Only an unreachable server skips the re-list. A partial refusal still changed
    // the list - the rows that went are gone - so the panel has to be told.
    if (!ran) return
    // force: the user is waiting for this one.
    await deps.refresh(false, true)
  }
}

/**
 * Open a session's output, and keep it fresh while it is open.
 *
 * The resolved address is captured for the dialog's lifetime: the panel's own
 * `origin` is shared state that a failed refresh clears, so reading it per poll
 * would report a buffer-read failure for a session that is fine.
 */
export function createOpenOutput(deps: ActionDeps) {
  return async (session: PanelSession): Promise<void> => {
    const origin = deps.state.origin ?? (await deps.findOrigin())
    if (origin === null) {
      deps.notify('PTY server unavailable', 'warning')
      return
    }
    deps.update((draft) => noteDialogOpened(draft, session.id, Date.now()))

    let stopped = false
    const load = async (): Promise<void> => {
      try {
        const text = await readScreen(origin, session.id)
        deps.update((draft) => noteDialogOutput(draft, text))
      } catch (error) {
        deps.update((draft) => noteDialogOutput(draft, '(failed to read buffer)'))
        deps.debug('output.failed', { id: session.id, error: String(error) })
      }
    }

    const live = (): PanelSession =>
      deps.state.sessions.find((candidate) => candidate.id === session.id) ?? session

    deps.context.ui.dialog.show(
      () =>
        outputDialogView({
          tones: deps.tones(),
          session,
          live: live(),
          now: deps.state.dialog?.now ?? Date.now(),
          output: deps.state.dialog?.output ?? '',
          rows: dialogRows(deps.context.renderer.height),
        }),
      () => {
        stopped = true
        clearInterval(bufferTimer)
        clearInterval(clockTimer)
        deps.update((draft) => noteDialogClosed(draft))
      }
    )
    // AFTER show(): pushing the entry resets the size, so setting it beforehand is
    // silently overridden.
    deps.context.ui.dialog.set({ size: dialogSize(deps.context.renderer.width) })
    deps.debug('dialog.opened', { id: session.id })
    clearStaleSelection(deps.context)

    const bufferTimer = setInterval(() => {
      if (!stopped) void load()
    }, DIALOG_POLL_MS)
    // A finished session's duration is fixed, so only a running one needs a clock to
    // count - and a stopped one stops the wakeups instead of counting a frozen figure
    // for minutes.
    const clockTimer = setInterval(() => {
      if (isFinished(live())) {
        clearInterval(clockTimer)
        return
      }
      deps.update((draft) => noteDialogTick(draft, Date.now()))
    }, 1000)
    await load()
  }
}

/**
 * The host ignores an overlay's mouse-up dismissal when a text selection was active
 * on the preceding mouse-down, which is what made closing take two outside clicks.
 * Clearing a stale selection first means the next click finds nothing to protect and
 * closes on the first one. Best-effort: clearing is an optimisation.
 */
function clearStaleSelection(context: Plugin.Context): void {
  try {
    context.renderer.clearSelection()
  } catch (_) {
    /* best-effort */
  }
}

export function createActions(deps: ActionDeps): Actions {
  const removeSession = createRemoveSession(deps)
  return {
    removeSession,
    confirmRemove: createConfirmRemove(deps, removeSession),
    clearFinished: createClearFinished(deps),
    openOutput: createOpenOutput(deps),
    sendInput: createSendInput(deps),
    onClear: (event: MouseEvent): void => {
      // Without stopping propagation the click would also collapse the panel,
      // hiding the very list it is cleaning.
      event.stopPropagation()
      void createClearFinished(deps)()
    },
  }
}
