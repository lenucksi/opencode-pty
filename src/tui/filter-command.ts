import type { Plugin } from '@opencode/plugin/tui'

/**
 * The command that sets or clears the sidebar's filter.
 *
 * The typing is the HOST's: `ui.dialog.prompt` renders the dialog and handles the keys, which is
 * the whole reason the filter is a prompt rather than a text field this plugin would have to
 * implement - including the editing, the cursor and every key it would swallow.
 *
 * Its own module because it is a self-contained interaction with the host UI, separate from the
 * sidebar's own rendering: the panel never draws the query, it only shows what survived.
 */

export interface FilterCommandDeps {
  /** The current query, so the prompt can show the state it is about to replace. */
  readonly current: () => string
  /** Store an answer. Called only for an answer that is not the dismissed dialog. */
  readonly set: (query: string) => void
  readonly debug: (event: string, detail?: unknown) => void
}

/**
 * Register the command.
 *
 * A palette entry and a slash command, and no keybind, for the reason the panel command has none:
 * any guess could collide with the host's own, and a collision is discovered by the user pressing
 * the wrong thing. The id lets it be bound in the user's keymap config. `global`, so it answers
 * outside the prompt too - the sidebar is visible the whole time.
 */
export function registerFilterCommand(context: Plugin.Context, deps: FilterCommandDeps): void {
  /**
   * Ask for a query.
   *
   * `undefined` is the DISMISSED dialog: clearing on a cancel would throw away a filter the
   * reader never asked to change, and an empty answer is the documented way to clear it.
   *
   * Best-effort, like a toast: a host that cannot show a prompt must not take the keymap command
   * down with it, and must not change the filter either.
   */
  const openPrompt = async (): Promise<void> => {
    let answer: string | undefined
    try {
      answer = await context.ui.dialog.prompt({
        title: 'Filter PTY sessions',
        description:
          'Matches the conversation and every field a row shows. An empty answer clears it.',
        placeholder: 'e.g. build',
        value: deps.current(),
      })
    } catch (error) {
      deps.debug('filter.prompt.failed', { error: String(error) })
      return
    }
    if (answer === undefined) return
    deps.set(answer)
    deps.debug('filter.set', { filter: answer })
  }

  context.keymap.layer(() => ({
    mode: 'global',
    commands: [
      {
        id: 'opencode-pty.sidebar.filter',
        title: 'Filter the PTY sidebar',
        description: 'Narrow the session list by conversation, title, command or agent.',
        group: 'opencode-pty',
        palette: true,
        slash: { name: 'pty-filter' },
        run: () => void openPrompt(),
      },
    ],
  }))
}
