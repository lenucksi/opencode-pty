# PTY Daemon

The PTY daemon (`opencode-ptyd`) runs as a separate process that owns all PTY
sessions. When enabled, sessions survive opencode server restarts — the plugin
becomes an IPC client over a Unix socket.

## Why

Without the daemon, every PTY session dies when opencode restarts. The daemon
keeps sessions alive across restarts, so a dev server you started in one
opencode session is still running when you open a new one.

## Enabling

### Option 1: Plugin option

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [{ "package": "@lenucksi/agentterm/v2", "options": { "daemon": true } }]
}
```

### Option 2: Environment variable

```bash
PTY_DAEMON=1 opencode
```

### Option 3: Manual

Start the daemon yourself, then point the plugin at it:

```bash
bun run src/daemon/index.ts --socket /tmp/ptyd.sock --state-dir ~/.local/share/opencode-pty
```

```json
{
  "plugin": [
    {
      "package": "@lenucksi/agentterm/v2",
      "options": { "daemon": true, "socketPath": "/tmp/ptyd.sock" }
    }
  ]
}
```

## How it works

1. On startup, the plugin checks if the daemon socket exists.
2. If not, it starts the daemon (setsid + nohup, detached from opencode).
3. The plugin connects as a client over the Unix socket.
4. All tool calls go through IPC to the daemon.
5. The daemon pushes output and status updates back to the client.
6. If the daemon crashes, the client detects the stale socket and restarts it.
7. If the connection drops, the client reconnects with exponential backoff.

## Architecture

```
┌─────────────┐     Unix socket     ┌─────────────┐
│   opencode  │ ◄─────────────────► │   daemon    │
│   plugin    │   NDJSON over IPC   │  (PTYs)     │
│  (client)   │                     │  (store)    │
└─────────────┘                     └─────────────┘
```

- **Daemon**: owns PTYManager, SessionStore, socket server
- **Client (plugin)**: thin wrapper, forwards tool calls via IPC
- **Push**: daemon pushes raw_data, session_update, session_removed, exit_notification
- **Heartbeat**: client sends heartbeat every 30s; daemon shuts down after 1h idle

## Socket location

Default: `$XDG_RUNTIME_DIR/opencode-pty/ptyd.sock` (or `/tmp/opencode-pty/ptyd.sock`)

## State directory

Default: sessions root (from `sessionsRoot()`). Override with `--state-dir`.

## Idle timeout

The daemon shuts down after 1 hour of no client connections. Sessions are flushed
to disk before shutdown. On next startup, the daemon reloads them (marked as "lost"
if they were running).

## Debugging

Check daemon logs:

```bash
cat ~/.local/share/opencode-pty/daemon.log  # if configured
```

Check if daemon is running:

```bash
ls -la $XDG_RUNTIME_DIR/opencode-pty/ptyd.sock
```

Kill a stuck daemon:

```bash
kill $(cat $XDG_RUNTIME_DIR/opencode-pty/ptyd.pid)
```

## Limitations

- Opt-in only (default: in-process, sessions don't survive restarts)
- Web UI and TUI panel work in daemon mode but use the daemon's session list
- Exit notifications require the daemon to have a notifier configured (automatic in daemon mode)
- Sessions are not shared across reboots (in-memory daemon state is lost)
