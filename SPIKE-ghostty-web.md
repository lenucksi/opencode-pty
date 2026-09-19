# SPIKE: Replace xterm.js with ghostty-web (web UI)

Branch: `spike/ghostty-web` (based on `fix/terminal-stream-protocol`, base commit `737833a`).
Status: **working tree only, not committed.** Partial spike — production swap works, but the
DOM-based E2E contract is a hard blocker for a drop-in migration.

## TL;DR / recommendation

**Do not migrate now (drop-in).** ghostty-web is production-viable in this app, but adopting it
requires (a) rewriting the repo's xterm-DOM-scraping E2E tests, (b) relaxing the app CSP, and
(c) accepting a ~2.4× gzip bundle increase. None of these are hard, but together they are a
migration project, not a drop-in. If the team accepts those costs, the code path below is a
working starting point.

## What changed

| File | Change |
| --- | --- |
| `package.json` / `bun.lock` | added devDependency `ghostty-web` (pinned to `anomalyco/ghostty-web#83c0a07`) |
| `src/web/client/components/terminal-renderer.tsx` | swapped `@xterm/xterm` → `ghostty-web` (`init()`, `Terminal`, `FitAddon`); queues render intents until WASM ready; generation-guards StrictMode double-mount; sets theme at init; keeps `window.xtermTerminal`/`window.xtermSerializeAddon` globals; adds `terminal`/`xterm` classes (ghostty does not) |
| `src/web/client/addons/serialize.ts` (new) | port of opencode's ghostty-web `SerializeAddon` (642 lines), adjusted for repo tsconfig (`override`, removed dead xterm fields, no `!`) |
| `src/web/server/handlers/static.ts` | CSP: add `'wasm-unsafe-eval'` and `connect-src data:` (required by ghostty WASM) |
| `test/e2e/xterm-test-helpers.ts` | `waitForTerminalRegex` no longer uses `term.onWriteParsed` (absent in ghostty); polls the serialized buffer instead |
| `test/e2e/{extract-serialize-addon,serialize-addon-vs-server-buffer,server-buffer-vs-terminal-consistency,buffer-extension,local-vs-remote-echo-fast-typing}.pw.ts` | converted readiness waits from `.xterm:has-text(...)` (no DOM text with canvas) to the repo's canonical SerializeAddon waiter. Assertions unchanged. |

`@xterm/*` devDependencies are now unused and can be dropped during the real migration.

## WASM / Vite integration

- No `vite.config.ts` change was needed. `init()` calls `Ghostty.load()` with no path, which
  loads an **embedded base64 `data:application/wasm`** (the package inlines the 967 KB
  `ghostty-vt.wasm` in `dist/ghostty-web.js`). Vite bundles it as ordinary JS.
- Consequently there is **no `dist/web/**/*.wasm` asset**; the WASM lives inside the JS bundle.
- The app CSP blocked it in two ways: `fetch(data:…)` (connect-src) and
  `WebAssembly.compile` (needs `'wasm-unsafe-eval'`). Both were fixed in `static.ts`.
- Alternative for a follow-up: `Ghostty.load('/ghostty-vt.wasm')` + `new Terminal({ ghostty })`
  with the `.wasm` copied into `dist/web`. Keeps the JS bundle lean and cacheable; still needs
  `'wasm-unsafe-eval'` (but not `connect-src data:`). Gzip total is roughly a wash
  (~478 KB vs ~480 KB), but raw/parse cost and caching are better.

## Bundle sizes (minified production builds, `bun run build:prod`)

| Build | JS raw | JS gzip | CSS raw/gzip | WASM asset |
| --- | --- | --- | --- | --- |
| xterm (base) | 504,131 B | 138,669 B | 3,621 / 1,014 B | — |
| ghostty-web | 1,546,904 B | 480,393 B | none | embedded (967,563 B → base64 inside JS) |
| **delta** | **+1,042,773 B (+207%)** | **+341,724 B (+246%)** | −3,621 B | — |

For reference, the unminified `NODE_ENV=test` E2E builds: xterm ≈1,477,004 B / 270,191 gz,
ghostty ≈2,491,910 B / 616,540 gz. (The `dist/` present at session start was an unminified E2E
build; numbers above are the fair minified comparison.)

## E2E / compat outcome (local, chromium)

- Baseline (base branch): 32 passed / 2 failed (34 total). The 2 failures were flaky interactive
  prompt tests (also failed on the base tree).
- ghostty-web across runs: **29–30 passed / 4–5 failed**.
- **Deterministic failures (3)** — all assert on xterm's **DOM text layer**, which a canvas
  renderer does not have:
  - `dom-scraping-vs-xterm-api.pw.ts` — scrapes `.xterm-rows > div` (returns `[]`)
  - `dom-vs-api-interactive-commands.pw.ts` — same
  - `extraction-methods-echo-prompt-match.pw.ts` — asserts on `getTerminalPlainText` (DOM)
- **Flaky (load-dependent, pass in isolation):**
  - `local-vs-remote-echo-fast-typing.pw.ts` (also flaky at baseline)
  - `ws-raw-data-counter.pw.ts` (passes 3/3 in isolation)
- **All serialize-based tests pass**: the 10 `pty-buffer-readraw.pw.ts` tests,
  `newline-verification` (×2), `visual-verification`, `extract-serialize-addon`,
  `serialize-addon-vs-server-buffer`, `server-buffer-vs-terminal-consistency`,
  `buffer-extension`. This validates the ported `SerializeAddon` and ghostty's
  `buffer.active` / `getLine` / `translateToString` compatibility.

`bun test`: 107 pass / 1 skip / 5 fail — identical to base (all 5 verified pre-existing by
stashing this branch).

Toolchain: `bun run format`, `bun run lint`, `bun run build:prod`, `bun run typecheck` all clean.

## Compatibility gaps found

1. **No DOM render layer (blocker).** ghostty-web is canvas-only: no `.xterm-rows`, no text
   nodes, so `.xterm:has-text(...)` and DOM scraping cannot work. Making those pass would
   require injecting a hidden DOM text mirror — an explicit hack — so they were left failing.
2. **No `onWriteParsed`.** The only trigger used by `waitForTerminalRegex`. Replaced with a 50 ms
   poll (ghostty parses writes synchronously). `onRender` exists but is never fired.
3. **No DOM classes.** xterm added `terminal`/`xterm` on `open()`; ghostty does not. Added
   manually, with `xterm` added on open so it doubles as a real readiness signal.
4. **Async init + React StrictMode.** `await init()` introduces a readiness window and races the
   StrictMode mount/unmount/remount cycle. Handled with a generation guard; without it, two
   terminals/canvases leak.
5. **Theme must be set at init.** The fork does not reliably apply theme changes after `open()`.
6. **CSP.** Requires `'wasm-unsafe-eval'` and `connect-src data:` (or serving `.wasm`).
7. **Bundle.** ~+342 KB gzip, mostly the embedded WASM.

## AC status

1. `terminal-renderer.tsx` switched to ghostty-web — **done**.
2. Bundle (+WASM) measured — **done** (see table).
3. Serialize addon ported; serialize-based E2E tests pass — **done** (DOM-scraping tests excluded by design, see gap 1).
4. Git dependency wired — **done**.
5. Theme set at init — **done**.
6. Decision documented — **done** (this file).

## How to reproduce

```bash
bun add -d github:anomalyco/ghostty-web#83c0a07b8628b748aed073b232cb4b52a6ca11c1
bun run format && bun run lint && bun run build:prod && bun run typecheck && bun test
bash .local/e2e-local.sh --project=chromium
```
