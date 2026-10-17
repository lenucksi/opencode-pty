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
> **Limitations compared to built-in bash tool:**
>
> - **"ask" permissions are treated as "deny"**: Since plugins cannot trigger OpenCode's permission prompt UI, commands matching an "ask" pattern will be denied. A toast notification will inform you when this happens. Configure explicit "allow" or "deny" for commands you want to use with PTY.
> - **"external_directory" with "ask" is treated as "allow"**: When the working directory is outside the project and `permission.external_directory` is set to "ask", this plugin allows it (with a log message). Set to "deny" explicitly if you want to block external directories.

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

