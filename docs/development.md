# Local Development

## Local Development

```bash
git clone https://github.com/shekohex/opencode-pty.git
cd opencode-pty
bun install --force --frozen-lockfile # Reinstall the exact bun.lock dependency graph
bun lint                              # Runs Biome linting checks
bun format                            # Runs Biome formatting checks
bun typecheck                         # Runs TypeScript type checking
bun build:dev                         # Build the React app for development
bun unittest                          # Runs the unit tests
bun test:e2e                          # Runs the e2e tests
```

### Full local quality gate

```bash
bun run test:local
```

This reinstalls the frozen dependency graph, checks Bun/dependency freshness,
runs type/lint/format/Aislop checks, unit and coverage suites, production and
E2E builds, the Socket.dev policy scan, and the Gitleaks/TruffleHog repository
scans. Authenticate Socket once with:

```bash
bunx socket@1.1.180 login
```

`test:local` then runs `socket ci` through the stored CLI login. A missing or
invalid login fails the gate; no token environment variable or repository
secret is required. Socket scans consume Socket API quota.

### Recording the demo

The animation at the top of this README is generated, not hand-captured:

```bash
bun run capture:demo
```

This records the Web UI at 1920x1080 against a throwaway server with an
isolated state directory, then writes `docs/media/web-ui-demo.gif` plus a
poster frame. Session output comes from the canned scripts in
`test/e2e/demo-*.py`, so the recording never contains real data.

### Manual TUI resize check

Resize negotiation is covered by unit tests (`SessionLifecycleManager.resize`) and
WebSocket tests (`resize` message). To verify a real full-screen TUI end to end,
start the Web UI, open a session, run `vim` or `htop`, then resize the browser
window: the TUI should reflow to the new width because `FitAddon` reports the new
`cols`/`rows` and the client sends a `resize` message to the server. A scripted
version of this check belongs in the e2e (Playwright) suite; it is not run in
headless environments without browser system libraries.

To load a local checkout in OpenCode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-pty/index.ts"]
}
```

