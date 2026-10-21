# Diagrams

## Diagrams

### Sequence

#### Use Case 1 – Opening the PTY Monitor Web UI

```mermaid
sequenceDiagram
    participant User as Human User
    participant Chat as OpenCode Chat
    participant Core as OpenCode Core
    participant Plugin as PTY Plugin
    participant Manager as PTY Manager (in Plugin)
    participant WS as WebSocket Server (in Plugin)
    participant Browser as Web Browser

    Note over Plugin,WS: Plugin starts/owns the WS server and Manager

    User->>Chat: Types /pty-open-background-spy
    Chat->>Core: Slash command received
    Core->>Plugin: Dispatches to registered command handler
    Plugin->>Browser: open(server.url.origin)
    activate Browser
    Browser->>WS: Connects → ws://.../ws
    WS->>Manager: Queries for current sessions (manager.list())
    Manager-->>WS: Returns session data
    WS-->>Browser: Sends session_list + subscribes to updates
    Browser-->>User: PTY monitor UI appears (sessions + terminals)
```

#### Use Case 2 – Starting a Long-Running Background Process

```mermaid
sequenceDiagram
    participant User
    participant Chat as OpenCode Chat
    participant Agent as AI Agent
    participant Plugin as PTY Plugin
    participant Manager as PTY Manager
    participant PTY as bun-pty Process
    participant WS as WebSocket Server
    participant UI as PTY Web UI (optional)

    User->>Chat: "start vite dev server in background"
    Chat->>Agent: User message
    Agent->>Plugin: Calls pty_spawn(command="vite", args=["dev"], ...)
    Plugin->>Manager: spawn(options)
    Manager->>PTY: Launches real process
    activate PTY
    PTY-->>Manager: stdout/stderr chunks
    Manager->>Manager: Appends to RingBuffer
    Manager->>WS: Publishes raw_data + session_update
    alt UI already open
        WS-->>UI: Real-time terminal output
        UI-->>User: Live xterm.js view
    end
    Plugin-->>Agent: Returns session info
    Agent-->>Chat: "Dev server started (ID: pty_abc123)"
    Chat-->>User: Confirmation message
```

#### Use Case 3 – Sending Interactive Input to a Running Session

```mermaid
sequenceDiagram
    participant User
    participant UI as PTY Web UI
    participant WS as WebSocket Server
    participant Manager as PTY Manager
    participant PTY as bun-pty Process

    %% Variant A: Human typing in browser (most common)
    User->>UI: Types "rs<Enter>" or pastes text
    UI->>WS: Sends {type:"input", sessionId, data:"rs\n"}
    WS->>Manager: write(sessionId, data)
    Manager->>PTY: process.write(data)
    PTY-->>Manager: New output (restart message, etc.)
    Manager->>WS: Publishes raw_data
    WS-->>UI: Updates xterm.js live

    %% Variant B: AI sending input
    Note over User,UI: Alternative path – AI controlled
    Agent->>Plugin: pty_write(id, "\x03")  // e.g. Ctrl+C
    Plugin->>Manager: write(id, data)
    Manager->>PTY: process.write("\x03")
```

#### Use Case 4 – Reading Output / Logs On Demand

```mermaid
sequenceDiagram
    participant User
    participant Chat
    participant Agent as AI Agent
    participant Plugin as PTY Plugin
    participant Manager as PTY Manager
    participant Buffer as RingBuffer

    User->>Chat: "show me the last 200 lines of the dev server"
    Chat->>Agent: User question
    Agent->>Plugin: pty_read(id, offset?, limit=200, pattern?)
    Plugin->>Manager: read / search request
    Manager->>Buffer: read(offset, limit) or search(pattern)
    Buffer-->>Manager: Matching / paginated lines
    Manager-->>Plugin: Raw or formatted lines
    Plugin-->>Agent: Text response
    Agent-->>Chat: "Here are the logs:\n\n1 | [vite] ... \n..."
    Chat-->>User: Logs displayed in chat
```

#### Use Case 5A – Killing / Cleaning Up a Session via Web UI

```mermaid
sequenceDiagram
    participant User
    participant UI as PTY Web UI
    participant HTTP as HTTP Server
    participant Manager as PTY Manager
    participant PTY as bun-pty Process
    participant WS as WebSocket Server

    Note over PTY: Assuming PTY is active (running process)<br>notifyOnExit = false (no chat notification,<br>but WS/UI always gets status updates)

    activate PTY

    User->>UI: Clicks "Kill" / "×" on session
    UI->>HTTP: DELETE /api/sessions/:id  (or /cleanup)
    HTTP->>Manager: kill(id, cleanup?)
    Manager->>PTY: Sends SIGTERM (if running)
    PTY-->>Manager: onExit event (code, signal)
    deactivate PTY
    Manager->>WS: Publishes session_update (status: killed/exited)
    WS-->>UI: UI updates → shows "exited" or removes entry
```

#### Use Case 5B – Killing / Cleaning Up a Session via Agent

```mermaid
sequenceDiagram
    participant User
    participant Chat as OpenCode Chat
    participant Agent as AI Agent
    participant Plugin as PTY Plugin
    participant Manager as PTY Manager
    participant PTY as bun-pty Process
    participant WS as WebSocket Server
    participant UI as PTY Web UI (optional)

    Note over PTY: Assuming PTY is active (running process)<br>notifyOnExit = false (no chat notification,<br>but WS/UI always gets status updates)

    activate PTY

    User->>Chat: "kill the dev server"
    Chat->>Agent: User request
    Agent->>Plugin: pty_kill(id, cleanup=true)
    Plugin->>Manager: kill(id, true)
    Manager->>PTY: SIGTERM + remove from list (if cleanup)
    PTY-->>Manager: onExit event (code, signal)
    deactivate PTY
    Manager->>WS: Broadcast session_update (status: killed/exited)
    alt UI open
        WS-->>UI: UI updates → shows "exited" or removes entry
    end
    Plugin-->>Agent: Success response
    Agent-->>Chat: "Session killed"
    Chat-->>User: Confirmation in chat
```

#### Use Case 6 – Automatic Exit Notification

```mermaid
sequenceDiagram
    participant PTY as bun-pty Process
    participant Manager as PTY Manager
    participant Plugin as PTY Plugin
    participant Chat as OpenCode Chat
    participant Agent as AI Agent
    participant User

    %%{init: {'sequence': {'messageAlign': 'left'}}}%%

    activate PTY
    Note over PTY: Long-running process (dev server, tests, etc.)
    PTY-->>Manager: Process exits → exitCode
    deactivate PTY
    alt notifyOnExit was true when spawned
        Manager->>Plugin: Triggers exit notification
        Plugin->>Chat: Sends formatted message via SDK<br><pty_exited><br>ID: pty_abc123<br>Exit: 0<br>Lines: 342<br>Last: Server running at http://localhost:5173<br></pty_exited>
        Chat-->>User: Notification appears in chat
        Chat->>Agent: Triggers agent with exit message
    end
    Manager->>WS: Publishes final session_update (status: exited)
    alt UI open
        WS-->>UI: UI shows red "exited" badge / stops live output
    end
```

