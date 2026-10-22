# Web UI

## Web UI

This plugin includes a modern React-based web interface for monitoring and interacting with PTY sessions.

![opencode-pty Web UI](docs/media/web-ui-demo.gif)

If you instruct the coding agent to run something in background, you have to name it "session",
i.e. "run xy as a background SESSION".
If you name it "task" or "process" or anything else, the agent will sometimes run it as background subprocess using `&`.

### Starting the Web UI

1. Run opencode with the plugin.
2. Run slash command `/pty-open-background-spy`.

This will start the background sessions observer cockpit server and launch the browser with web UI.

### Starting it without OpenCode

The interface is also a binary of its own, for a harness that is not OpenCode:

```bash
bunx opencode-pty-web
```

It serves the same interface against the daemon and prints the address on stdout,
once. The daemon is the state: the sessions, the archive and the generation live
there, so the interface shows the same sessions an OpenCode instance would - and a
machine with no daemon gets one started rather than an error.

**No permission authorizer is installed on this path.** The interface is a human's
own surface, and the host's rules are the host's business - but that also means
anything that can reach the port can start a process, which is why it binds to the
loopback address by default (`PTY_WEB_HOSTNAME` moves it).

The server writes an origin record keyed by the directory it was started in, so a
running OpenCode TUI can find it; the record is removed when the process ends.

### Version

Settings shows the version and the short Git commit of the build that is running,
and one click copies it. The value is served by the server rather than baked into
the page bundle, so a stale bundle sitting next to a freshly built server cannot
report a commit that is not running. The same identity is on `GET /api/server`.

### The daemon

Settings has a **Daemon** section with a *Restart the daemon* button. It rolls
the daemon — the same roll the TUI's sidebar footer offers — and reports the
result under the button, next to the action that caused it.

The daemon is machine state that every OpenCode instance on the machine shares:
one socket, one pid file, one process that owns every PTY. So a roll is a
decision about the machine, not about the browser tab that asked for it.

**A roll ends every session the daemon owns.** The PTY masters belong to that
process, so the sessions in the list disappear with it; the archive on disk
survives and stays restorable.

The button is disabled while a roll runs: two rolls at once are how a machine
ends up with two daemons.

### Features

- **Session List**: View all PTY sessions with status indicators, split into running and finished
- **Session Groups**: Sessions are grouped by their parent OpenCode session, with the parent title, agent and child count
- **Real-time Output**: Live streaming of process output via WebSocket
- **Interactive Input**: Send commands and input to running processes
- **Mouse Selection**: Select text with the mouse, including applications that capture the mouse, and copy the selection
- **Themes**: Light and dark theme, following the system preference by default
- **Accurate Colors**: Terminals answer OSC 10/11 color queries, so themes and prompts report true colors
- **Download**: Save the visible buffer or a range of it as a file
- **Session Management**: Kill sessions directly from the UI
- **Settings**: Configure viewport, scrollback and display preferences
- **Connection Status**: Visual indicator of WebSocket connection status

