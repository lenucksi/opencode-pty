# Configuration

## Configuration

### Environment Variables

| Variable                        | Default    | Description                                        |
| ------------------------------- | ---------- | -------------------------------------------------- |
| `PTY_MAX_BUFFER_LINES`          | `50000`    | Maximum lines to keep in output buffer per session |
| `PTY_READ_MAX_TOKENS`           | `25000`    | Default `pty_read` result budget, in tokens (~100 kB) |
| `PTY_READ_MAX_TOKENS_CEILING`   | `125000`   | Hard ceiling on a caller's `maxTokens` request (~500 kB) |
| `PTY_WEB_HOSTNAME`              | `::1`      | Hostname for the web server to bind to (IPv6 loopback by default) |
| `PTY_WEB_PORT`                  | `0` (random) | Port for the web server (0 = random port)        |

### Permissions

This plugin respects OpenCode's [permission settings](https://opencode.ai/docs/permissions/) for the `bash` tool. Commands spawned via `pty_spawn` are checked against your `permission.bash` configuration.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": {
      "bun *": "allow",
      "git push": "deny",
      "terraform *": "deny"
    }
  }
}
```

> [!IMPORTANT]
> **Where the gate applies, and where it does not:**
>
> - **The model's tool calls** (`pty_spawn`, `pty_write`) go through the host's own permission system: the same rules the built-in `bash` tool obeys, and the same prompt. A command that needs approval asks the user, and a refusal stops the spawn. The plugin does not have to turn "ask" into "deny" any more - it asks the host, and the host asks you.
> - **The web interface** is your own surface: a browser has no conversation for the rules to belong to, so the host cannot be asked about it, and the interface starts what you asked for in its form.
> - **A host without a permission domain** (an older build) leaves the plugin without a gate. The plugin log says so rather than pretending otherwise.
>
> The rules are the host's: the agent's own rules, the session's rules and the ones you saved earlier all apply, and the command is matched the way the host's own `bash` tool matches it - `"git *"` covers `git status` and `git push`.

#### Example: Allow specific commands for PTY

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": {
      "bun run dev": "allow",
      "bun run build": "allow",
      "bun test *": "allow",
      "cargo *": "allow",
      "python *": "allow"
    }
  }
}
```

