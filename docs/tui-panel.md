# TUI Sidebar & Session Panel

## TUI Sidebar Panel

OpenCode's terminal UI has no page for PTY sessions, so a session the agent
started is invisible there: the terminal shows the chat, not the processes. This
plugin contributes a collapsible **PTY** section to the sidebar, next to the
built-in items (MCP, File Tree, Todo), and shows a session's live output in a
dialog.

| Row shows        | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `120L`           | Running, with that many lines of output                     |
| `exit 0`         | Ended on its own with that exit code                        |
| `signal SIGTERM` | Ended on a signal                                            |
| `killing`        | Asked to stop; the teardown is still running                 |
| `killed`         | Stopped, no exit code of its own                            |

Each row has a `✕`. On a running session it asks first, because it kills a live
process; on a finished one it acts at once. The header offers *(clear finished)*
whenever there is something finished to clear — never for a running session.

Rows are grouped by the conversation that started them, one collapsible heading per
parent session, named with that conversation's title (or `Session <id>` once it is gone).
A group of more than two folds on its chevron; a smaller one is always open, so the fold
can never hide the one process you came to watch. A session nobody's conversation started
sits under `Ungrouped`. The archive in the footer stays a single count rather than its own
groups: 200 sessions across 20 conversations would be a wall of headings in a ~40-column
sidebar.

`/pty-filter` narrows the list. The host's own prompt does the typing — the plugin draws no
text field and handles no keys of its own — so the query is asked for from the palette or as
a slash command and is stored with the other preferences. Matching goes through the same
shared matcher the web sidebar uses: case-insensitively, against the conversation heading and
every field a row already shows, and a conversation whose heading matches keeps its whole
group. While a filter is set the header reads `N of 200`, so the true total stays visible, the
query sits beside it as a chip you can click to clear, and an empty list names the query
instead of claiming nothing is running. A dismissed prompt leaves the filter as it was; an
empty answer clears it.

The panel needs the PTY server, and starts it when you expand the section. It
does **not** start it on OpenCode's startup: starting it creates and deletes a
session, which does not belong on a load path. If the PTY plugin is not
registered in the project's `opencode.jsonc`, the header says so rather than
offering a retry that cannot work.

The panel asks this plugin's own server half where it is listening — over the
host's plugin RPC (`@opencode/plugin/rpc`), so the answer is read from the live
server and needs no project key — and only then falls back to the address the
server published for a project. That order matters when one
`opencode serve --service` hosts the plugin for several projects: the published
record is filed under the directory that process was started in, which a panel
cannot derive from its own session, and deriving it alone meant reading *not
running* beside a server that answered.

### Requirements

The panel needs an OpenCode build with the V2 TUI plugin API — 2.0.23 and later.
There is nothing else to install: the host maps `@opentui/solid`, its JSX runtime,
`solid-js` and `@opencode/plugin/tui` onto the copies it has already loaded, so the
panel uses the same runtime instances the built-in sidebar items do rather than a
second set of its own.

They are declared as **optional peer** dependencies anyway, at the floors
`@opencode/plugin` itself declares, because that is what the SDK asks for and because
it keeps them visible: they are needed to *build* the panel, and the development
dependencies pin them so the TUI contract is type-checked.

What the panel does need from the configuration is a **package** entry rather than a
path to a file:

```json
{
  "plugin": [{ "package": "opencode-pty/v2", "options": { "port": 4200, "autostart": true } }]
}
```

OpenCode probes `<configured name>/tui`, so only a package name can reach the panel.
A local `.ts` wrapper loads the tools but leaves the sidebar without a panel, which
looks like a broken panel rather than a missing declaration.

The panel is additive, so on a build without the V2 TUI API it simply does not
appear.

### The daemon line

The footer's second line is the daemon: `daemon · restart`, and the pid of the
daemon that answered the last roll once there is one. Clicking it rolls the
daemon; while the roll runs the line says `daemon · restarting…`, and the
result arrives as a toast.

The daemon is **machine state, not panel state**. Every OpenCode instance on the
machine talks to the same daemon over one socket, so a roll is a decision about
the machine rather than about the list you happen to be looking at. That is why
the line sits in the footer — the one place in the sidebar that talks about the
machine — and not in the header, whose actions (the filter, *clear finished*)
act on the list.

The roll is asked of the half that owns the client: the panel cannot do it
itself, because it is a different process and the daemon belongs to the server
half. The panel asks over the host's plugin RPC, the same channel it uses to
learn where the server listens.

**A roll ends every session the daemon owns.** The PTY masters belong to that
process, so a new daemon starts with an empty set of live sessions; the archive
on disk survives and the sessions in it stay restorable.

## Session Panel

The sidebar lists every PTY session. This panel shows the ones belonging to **the
conversation you are in** — the processes this chat started — with one of them on screen.
It claims OpenCode's `session.panel` slot, the same place its own Review and Files views
live.

Open it from the command palette or with `/pty-sessions`. It lists this conversation's
processes only, so a conversation that started none says so rather than showing an empty
box.

**Three ways out, on purpose.** OpenCode has no key for closing a plugin panel — the
routes that do close it (switching session, picking a terminal, opening the sidebar) are
different actions that happen to close it as a side effect. So this panel owes you a way
out of it and offers three:

| Route     | What it does                     | Key          |
| --------- | -------------------------------- | ------------ |
| Palette   | Close the PTY panel              | —            |
| Palette   | Enlarge the PTY panel            | —            |
| Palette   | Leave for the session list       | —            |
| Key       | Close the PTY panel              | `ctrl+y`     |
| Key       | Enlarge the PTY panel            | `f3`         |
| Pointer   | Close the PTY panel              | `✕ close`    |

The command ids are `opencode-pty.session-panel.close`, `.fullscreen` and `.sessions`, so
every key can be moved or dropped in your keymap config. The two keys are on `ctrl+y` and
`f3` because the obvious ones are taken by OpenCode: `escape` is *Interrupt current
session* and `q` is *Close diff viewer*. Switching sessions needs no key of ours —
OpenCode has it on `<leader>l`, and it closes this panel as a side effect.

Without this panel having an exit of its own, opening it left no way back except
killing the terminal. `f3` does nothing below 80 columns: OpenCode forces the panel
full-screen there, so there is no half to swap back to.

Clicking a session in the sidebar opens this panel on it — including one whose conversation lives in
another project, which the sidebar lists but no panel used to show: the click scopes the panel to the
conversation that started the process, and the parent id needs no live session to do that. The line
above the console names what is on screen (title, date, state, and the conversation that started it),
and the footer counts it — id, status, terminal size, output lines, and how many rows of the rendered
screen are on view. Size matters: a program given 120x40 and shown in 80 columns is wrapping, not
failing.

### Driving the program on screen

**Sending input works; free typing does not, and the difference is the SDK.**

A plugin gets named commands from `context.keymap` and no raw key events, so typing would
mean binding every printable key separately. `q` — the key every full-screen program uses to
quit — is bound by OpenCode's own *Close diff viewer*, whose command has no `enabled`
predicate and is therefore live at all times. There is no key left that a program would
recognise.

What the SDK does offer is `ui.dialog.prompt`: OpenCode renders a real text field, handles
editing, and returns the line. So the panel has a **command line** instead of a keystroke
forwarder:

| Route    | What it does                    | Key          |
| -------- | ------------------------------- | ------------ |
| Palette  | Send a line to the selected PTY | —            |
| Key      | Send a line to the selected PTY | `f4`         |
| Pointer  | `⌨ send` in the panel header    | —            |

Type `q`, `k`, `1`, `/pattern` or `H` and it arrives as if typed, with a newline. The control
appears only for a process that is still running, and the line is refused before you are asked
for it if there is no server to send it to. The command id is
`opencode-pty.session-panel.send`, so the key can be moved.

This is a command line, not a terminal: a program that wants arrow keys, function keys or
raw control characters will not get them. `top` is fully usable this way — `q`, `k`, `1`, `c`
all work — and `htop` needs its own key handling, which this SDK does not expose.

