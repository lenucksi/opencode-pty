# Daemon Test Scenarios

Manual test scenarios for the PTY daemon. Each scenario describes what to do
and what to expect.

## Prerequisites

```bash
# Build the plugin
bun run build:prod

# Enable daemon mode
export PTY_DAEMON=1
```

## Scenario 1: Basic survival across restart

**Steps:**
1. Start opencode with `PTY_DAEMON=1`
2. Ask the agent: "Start `sleep 300` as a background session"
3. Note the session ID (e.g., `pty_abc123`)
4. Exit opencode (Ctrl+C or close terminal)
5. Start opencode again with `PTY_DAEMON=1`
6. Ask: "List PTY sessions"

**Expected:** The session from step 2 appears in the list with status `running`.
The process is still alive (check with `ps aux | grep sleep`).

## Scenario 2: Read output after restart

**Steps:**
1. Start opencode with `PTY_DAEMON=1`
2. Ask: "Start `echo hello; sleep 300` as a background session"
3. Exit opencode
4. Start opencode again
5. Ask: "Read the output of session pty_..." (use the ID from step 2)

**Expected:** Output contains "hello". The session is still running.

## Scenario 3: Kill after restart

**Steps:**
1. Start opencode with `PTY_DAEMON=1`
2. Start a `sleep 300` session
3. Exit opencode
4. Start opencode again
5. Ask: "Kill session pty_..."

**Expected:** Session is killed. Process no longer in `ps`.

## Scenario 4: Daemon auto-start

**Steps:**
1. Ensure no daemon is running: `rm -f $XDG_RUNTIME_DIR/opencode-pty/ptyd.sock`
2. Start opencode with `PTY_DAEMON=1`
3. Ask: "Start `echo test` as a background session"

**Expected:** Daemon starts automatically. Session is created. Socket file appears.

## Scenario 5: Daemon crash recovery

**Steps:**
1. Start opencode with `PTY_DAEMON=1`
2. Start a session
3. Kill the daemon: `kill $(cat $XDG_RUNTIME_DIR/opencode-pty/ptyd.pid)`
4. Ask: "List PTY sessions" or start a new session

**Expected:** Plugin detects stale socket, starts new daemon. New sessions work.
Old sessions are gone (daemon state was in-memory).

## Scenario 6: Exit notification

**Steps:**
1. Start opencode with `PTY_DAEMON=1`
2. Ask: "Start `echo done` as a background session with notifyOnExit"
3. Wait for the process to exit

**Expected:** A `<pty_exited>` notification appears in the chat.

## Scenario 7: Multiple clients

**Steps:**
1. Start opencode instance A with `PTY_DAEMON=1`
2. Start a session in A
3. Start opencode instance B with `PTY_DAEMON=1`
4. Ask B: "List PTY sessions"

**Expected:** B sees the session created in A.

## Scenario 8: Idle timeout

**Steps:**
1. Start opencode with `PTY_DAEMON=1`
2. Start a session
3. Exit opencode
4. Wait 1 hour (or set IDLE_TIMEOUT lower for testing)
5. Start opencode again

**Expected:** Daemon has shut down. New daemon starts. Old sessions are loaded from disk
(marked as "lost" if they were running).

## Scenario 9: Web UI in daemon mode

**Steps:**
1. Start opencode with `PTY_DAEMON=1` and `autostart: true`
2. Start a session
3. Open the Web UI (`/pty-open-background-spy`)

**Expected:** Web UI shows the session. Real-time output streaming works.

## Scenario 10: TUI panel in daemon mode

**Steps:**
1. Start opencode with `PTY_DAEMON=1`
2. Open the TUI panel (`/pty-sessions`)
3. Start a session via the agent

**Expected:** Session appears in the TUI panel. Coloured output renders.

## Automated verification

Run the integration tests:
```bash
bun test test/daemon-integration.test.ts
```

Run the full quality gate:
```bash
bun run test:local
```
