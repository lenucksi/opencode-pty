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

### Version

Settings shows the version and the short Git commit of the build that is running,
and one click copies it. The value is served by the server rather than baked into
the page bundle, so a stale bundle sitting next to a freshly built server cannot
report a commit that is not running. The same identity is on `GET /api/server`.

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

