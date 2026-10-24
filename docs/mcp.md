# MCP

The PTY tools for a harness that speaks **MCP** instead of OpenCode's plugin API.
Claude Code, Codex and anything else that can launch an MCP server get the same
eight tools, the same daemon and the same sessions an OpenCode instance would
have.

## Starting it

Claude Code reads the servers from `.mcp.json` in the project (or
`~/.claude.json` for a machine-wide one):

```json
{
  "mcpServers": {
    "pty": {
      "command": "bunx",
      "args": ["opencode-pty-mcp"]
    }
  }
}
```

The server is a stdio process: it speaks JSON-RPC on stdout and nothing else
there. Its log goes to a file
(`$XDG_STATE_HOME/opencode/opencode-pty.log`), and what has to reach the console
goes to stderr.

From a checkout:

```bash
bun run src/mcp/entry.ts
```

## What happens on the first launch

The server connects to the daemon, and starts it if the machine has none. The
daemon owns everything that outlives a process:

- the **sessions** and their PTYs - they keep running when the harness exits,
- the **archive** of finished sessions,
- the **generation** that tells two servers whether they see the same world.

Because the sessions live in the daemon, closing the harness does not kill the
processes, and starting a second harness shows the same sessions. The sessions of
one MCP server are grouped under `mcp-<pid>`, which is also how they are
collected.

## The tools

| Tool         | What it does                                              |
| ------------ | --------------------------------------------------------- |
| `pty_spawn`  | starts a process in a PTY                                 |
| `pty_write`  | sends input to a running session                          |
| `pty_read`   | reads the output, with paging and a pattern filter        |
| `pty_list`   | lists the sessions, running and finished                  |
| `pty_wait`   | waits for a session to end and answers with the exit code |
| `pty_resize` | changes the geometry of a running session                 |
| `pty_screen` | renders the screen the program currently draws            |
| `pty_kill`   | stops a session                                           |

The names, the arguments and the result tags are the ones the OpenCode plugin
uses - the same modules serve both routes, so a script that works against one
works against the other.

## Waiting for an exit

`pty_wait` is the completion signal on this route. A wait without a timeout is
capped (the transport cuts a call that takes too long, and a cut says nothing
about the session), and it answers with `<pty_wait_timeout>` when the cap is
reached - call it again to keep waiting.

`notifyOnExit` is accepted and has **no effect** here: there is no conversation
to deliver the exit message into, unlike the OpenCode plugin, where the exit
arrives as a message in the conversation that started the session. The tool
description says so, and the spawn result says so too.

## The permission gate

The OpenCode plugin asks the **host** whether a command may run: the host knows
its own rules, and it prompts the user. An MCP server has no host to ask.

So the MCP route enforces a **policy** of its own, read from your OpenCode
configuration (`permission.bash` and friends - the same patterns, the same
semantics):

- a command an `allow` rule covers runs,
- a command a `deny` rule covers is refused,
- a command no rule covers is **refused**, because here you have not said yes to
  anything yet,
- a rule that wants a human is refused: there is nobody to ask.

The rules are read from the global OpenCode configuration and the project's own,
so the rules you already wrote apply. A machine without OpenCode has no rules, and
everything is refused until you write some.

## The web interface

A harness that is not OpenCode has no way to show a human the sessions. The
interface is a binary of its own:

```bash
bunx opencode-pty-web
```

It serves the same UI against the daemon and prints the address once. **No
permission authorizer is installed on that path either** - the interface is a
human's own surface, and it binds to the loopback address by default.

## What is not here

- **Exit notifications into the conversation.** The daemon pushes the exit, but
  there is no conversation to push it into. `pty_wait` is the signal.
- **Permission prompts.** The host's prompt is the host's; the MCP route refuses
  what its policy does not allow.
- **The TUI panel.** It is an OpenCode plugin, and there is no slot for it
  elsewhere. The web interface is the human's window.
