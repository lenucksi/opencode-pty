# How It Works & Session Lifecycle

## How It Works

1. **Spawn**: Creates a PTY using [bun-pty](https://github.com/sursaone/bun-pty), runs command in background
2. **Buffer**: Output is captured into a rolling line buffer (ring buffer)
3. **Read**: Agent can read buffer anytime with offset/limit pagination
4. **Filter**: Optional regex pattern filters lines before pagination
5. **Write**: Agent can send any input including escape sequences
6. **Lifecycle**: Sessions track status (running/exited/killed), persist until cleanup
7. **Notify**: When `notifyOnExit` is true, sends a message to the session when the process exits
8. **Web UI**: React frontend connects via WebSocket for real-time updates

## Session Lifecycle

```
spawn → running → [exited | killed]
                      ↓
              (stays in list until cleanup=true)
```

Sessions remain in the list after exit so the agent can:

- Read final output
- Check exit code
- Compare logs between runs

Use `pty_kill` with `cleanup=true` to remove completely.

## The screen and the raw stream

`pty_screen` is a **view**, not a mode. It takes the retained output, replays it into
a throwaway terminal and reports the cells - and it consumes nothing: the buffer and
its character count are the same before and after a screen read, and `pty_read` still
delivers the bytes byte for byte afterwards. The web interface and the TUI read the
same output and may present less of it, but what the program wrote is what the buffer
holds.

**The replay bound.** A live session is replayed from its whole ring buffer, because a
program that painted a row once and never touched it again must still be in the
replay - otherwise the screen is a reconstruction of what is still changing. An
archived session has no ring buffer, so its transcript is replayed from the last
4 MB (`ARCHIVE_REPLAY_WINDOW`). A caller can ask for less with `chars`, and a
narrower window is a reconstruction like any other: the result says how much of the
session it covered (`partial="1200/54000"`), so a missing row cannot pass for a row
the program never painted.

**`raw: true` is a spawn-time property.** It sets the line discipline of the PTY
(`stty raw -echo`), which changes how bytes _reach_ the program - a serial console
wants a `\r` to stay a `\r`. It has nothing to do with how the buffer is read or
rendered: the screen path reads the same bytes and replays them, either way.
