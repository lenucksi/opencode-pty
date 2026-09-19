# SPIKE 2: `ghostty-web` from UPSTREAM npm (`coder/ghostty-web@0.4.0`) vs the git fork

Branch: `spike/ghostty-web-upstream` (inherits `spike/ghostty-web`, base `a0a0c5e`).
Status: **working tree only, not committed.** Source swap is unchanged; only the dependency
moved from the fork git SHA to the upstream npm release. All verification ran locally.

## TL;DR

- **Dependency swap: clean.** `bun remove ghostty-web` + `bun add -d ghostty-web@0.4.0`.
  **No source adaptation was required** — `terminal-renderer.tsx`, the ported
  `SerializeAddon`, the CSP change and the e2e wait helpers all compile and run unchanged
  against 0.4.0. `bun run format`, `bun run lint`, `bun run build:prod`, `bun run typecheck`,
  `bun test` and the chromium e2e suite are all green at the same level as spike 1.
- **Bundle is ~half the fork's** because upstream's released WASM is 423 KB vs the fork's
  967 KB: 803,831 B raw / 239,006 B gzip vs the fork's 1,546,904 B / 480,393 B.
- **But upstream 0.4.0 still has two bugs that the fork fixed**, and both reproduce in a
  side-by-side browser probe:
  1. `scrollback` is interpreted as **bytes**, not lines — any positive value ≤ 1 MB yields
     a fixed ~854-line history; sustained heavy output prunes pages. The fork converts
     lines→bytes and honours the setting (10,000 lines → 4,977 retained, no drops).
  2. **Transient viewport row corruption** on repeated escape-heavy writes (8/30 reps in the
     fork's own regression fixture); the fork is clean (0/30).
- **Recommendation:** for an actual migration, keep the **git fork** pinned while these fixes
  are missing upstream; track `coder/ghostty-web` releases and switch to versioned npm once
  the scrollback/viewport fixes land (better dependency hygiene). The DOM-renderer blocker
  from spike 1 is unchanged, so the overall "not a drop-in" conclusion still stands.

## What changed vs Spike 1

| Item | Spike 1 (`spike/ghostty-web`) | Spike 2 (this branch) |
| --- | --- | --- |
| Dependency | `ghostty-web: github:anomalyco/ghostty-web#83c0a07` (v0.3.0, fork) | `ghostty-web: 0.4.0` (upstream npm, `latest`) |
| `terminal-renderer.tsx` | ghostty swap | **unchanged** |
| `addons/serialize.ts` | ported SerializeAddon | **unchanged** |
| `static.ts` CSP | `'wasm-unsafe-eval'` + `connect-src data:` | **unchanged** |
| e2e wait helpers/tests | adapted | **unchanged** |
| Embedded WASM | 967,563 B (fork build) | 423,045 B (upstream release) |
| Only files touched | — | `package.json`, `bun.lock`, this doc |

The API surface used by the app (`init`, `Terminal`, `FitAddon`, `ITerminalAddon`,
`ITerminalCore`, `ITheme`, `IBufferRange`, `term.write/reset/open/dispose/onData`,
`buffer.active/normal/alternate/getLine`, `wasmTerm.getMode`) is **identical** between the
fork's 0.3.0 d.ts and upstream 0.4.0 d.ts. 0.4.0 is a drop-in for the spike-1 code path.

## Verification (local, chromium)

- `bun run format` — clean (103 files).
- `bun run lint` — clean (104 files).
- `bun run build:prod` — clean.
- `bun run typecheck` — clean.
- `bun test` — **107 pass / 1 skip / 5 fail**, identical to spike 1 and to the base branch
  (all 5 failures are pre-existing and environment/packaging-related; the spike-1 doc records
  the same 107/1/5).
- `bash .local/e2e-local.sh --project=chromium`:
  - Run 1: **31 passed / 3 failed**.
  - Run 2: **30 passed / 4 failed** (same 3 + the known-flaky `local-vs-remote-echo-fast-typing`).
  - The 3 **deterministic** failures are exactly spike 1's DOM-renderer victims:
    `dom-scraping-vs-xterm-api.pw.ts`, `dom-vs-api-interactive-commands.pw.ts`,
    `extraction-methods-echo-prompt-match.pw.ts`. In isolation `dom-vs-api-interactive-commands`
    fails at `expect(domContent.length).toBe(terminalContent.length)` (DOM = 0, API = 37 lines):
    ghostty renders to canvas and has no `.xterm-rows` text layer. This is inherent to the
    renderer, not to the upstream/fork choice.

### E2E comparison

| Suite | Base `fix/terminal-stream-protocol` | Spike 1 (fork 0.3.0) | Spike 2 (upstream 0.4.0) |
| --- | --- | --- | --- |
| Passed | 32–34 (see note) | 29–30 | **30–31** |
| Failed | 2 flaky | 4–5 | **3–4** |
| Deterministic DOM failures | 0 | 3 | 3 (same tests) |
| Flaky | interactive-prompt tests | `local-vs-remote-echo-fast-typing`, `ws-raw-data-counter` | `local-vs-remote-echo-fast-typing` |

No regression vs the fork; the DOM blocker is identical. (The base-branch reference in the task
is "34 passed"; the spike-1 doc measured 32/2. The flakiness is load/thread dependent and not
attributable to the emulator.)

All serialize-based tests pass, validating the ported `SerializeAddon` against upstream 0.4.0's
`buffer.active` / `getLine` / `translateToString` / `wasmTerm.getMode`.

## Bundle measurements

`bun run build:prod` (minified, `NODE_ENV` unset), `dist/web/assets/index-*.js`:

| Build | JS raw | JS gzip (gzip -9) | CSS | WASM |
| --- | --- | --- | --- | --- |
| xterm (base, spike-1 measurement) | 504,131 B | 138,669 B | 3,621 / 1,014 B | — |
| ghostty fork 0.3.0 (spike 1) | 1,546,904 B | 480,393 B | none | embedded 967,563 B |
| **ghostty upstream 0.4.0 (this spike)** | **803,831 B** | **239,006 B** | none | embedded **423,045 B** |
| Δ upstream vs xterm | +299,700 B (+59%) | +100,337 B (+72%) | −3,621 B | — |
| Δ upstream vs fork | −743,073 B (−48%) | −241,387 B (−50%) | — | −544,518 B |

- Vite reports the gzip size as `242.31 kB`; `gzip -9` on the file gives 239,006 B.
- The WASM is still inlined as `data:application/wasm;base64,…` (one 564,060-char blob,
  decoding to 423,045 B). **No `dist/web/**/*.wasm` asset**, no Vite config change, and the
  same CSP requirement (`'wasm-unsafe-eval'`, `connect-src data:`) as spike 1.
- For reference, the unminified `NODE_ENV=test` e2e rebuild (what the e2e runner writes into
  `dist/`) is 1,740,387 B / 369,039 B gzip for upstream; spike 1 measured the fork's e2e build
  at 2,491,910 B / 616,540 B. Same ~2× relationship.

The entire delta between fork and upstream is the embedded WASM (726 KB of base64) plus ~17 KB
of minified app code. Upstream's released WASM is less than half the size of the fork's build,
which is the single biggest win of this spike.

## Scrollback / viewport behaviour — the real difference

I built a standalone dual-bundle browser probe (`/tmp/opencode/spike2/harness/`) that loads the
**upstream 0.4.0 bundle and the fork bundle side by side** and runs the fork's own
`viewport-row-merge` / `viewport-corruption` / scrollback-bytes fixtures against both. Chromium,
isolated `Ghostty.load()` per terminal.

### 1. `scrollback` units (fork's "scrollback_limit line→bytes" fix)

Write 5,000 lines at `cols=80, rows=24`, then read `wasmTerm.getScrollbackLength()`:

| `scrollback` option | upstream 0.4.0 retained | fork retained | expected if lines |
| --- | --- | --- | --- |
| 0 | 4,977 | 4,977 | unlimited |
| 100 | 854 | 854 | 4,976 |
| 500 | 854 | 854 | 4,976 |
| 1,000 | 854 | 854 | 4,976 |
| 2,000 | 854 | **1,443** | 4,976 |
| 10,000 | 854 | **4,977** | 4,976 |
| 100,000 | 854 | 4,977 | 4,976 |
| 1,000,000 | 854 | 4,977 | 4,976 |
| 10,000,000 | 4,977 | 4,977 | 4,976 |

Upstream ignores the configured value for anything up to ~1 MB and keeps a fixed ~854-line
history; its behaviour is consistent with `scrollback_limit` being read as **bytes** and
clamped/page-rounded (0 means unlimited; 10 MB is finally large enough to hold all 4,977 lines).
The fork converts the line count to bytes before handing it to WASM, so retention scales with
the option. **The app sets `scrollback: 5000`**, so on upstream it effectively gets ~854 lines.

### 2. Sustained escape-heavy writes (fork's stale-row / viewport-pinning fix)

Fork's `viewport-row-merge` fixture: 30 × ~25 KB of dense SGR/truecolor/Unicode at
`cols=160, rows=39, scrollback=10000`; compare each viewport snapshot against the first.
"Corrupt reps" = snapshots whose text differs from the baseline (transient, self-correcting):

| Metric | upstream 0.4.0 | fork |
| --- | --- | --- |
| Corrupt reps (of 30) | **[2, 7, 12, 14, 19, 24, 27, 29]** | **[]** |
| Scrollback length drops | **11** | **0** |
| Final scrollback length | 276 | 3,532 |
| `getViewport()` vs `getLine()` mismatches | 0 | 0 |

Upstream exhibits the exact regression the fork's viewport row-pinning + `renderStateGetViewport`
patch targets: periodically a row shows content concatenated/stale until the next write, and the
history is pruned repeatedly under load. The fork is clean.

### 3. Simpler cases (no difference)

- `markedMerge` (10 × 45 marked lines, cols=140×40): **0 merge violations** on both.
- `scrollViewport` (300 lines, then `scrollToTop()` / `scrollLines(-37)` at rows=10): top/bottom
  markers identical, **0 duplicate rows, 0 `getViewport`/`getLine` mismatches** on both.
- So plain scrolling is fine on upstream; the corruption needs high per-write byte volume with
  active page recycling, and the scrollback cap bug needs a large configured history.

Practical impact for this app: long-running/interactive sessions that emit a lot of styled output
(build logs, `ls --color`, TUIs) get a noticeably shorter scrollback and occasional transient
row artifacts on upstream, which the fork avoids. Neither is covered by the current e2e suite
(no test asserts large scrollback or viewport stability).

## Recommendation: npm upstream vs git fork

**Correctness today → git fork. Hygiene long-term → npm upstream.**
The two are in tension precisely because upstream's release automation is newer than the fork's
bug fixes.

1. **Do not "migrate to ghostty-web" based on this spike either.** The spike-1 blocker is
   unchanged: canvas-only rendering means the repo's three DOM-scraping e2e tests cannot pass
   without a hidden DOM mirror, and the bundle is still +72% gzip over xterm with a relaxed CSP.
   That is a migration project, not a drop-in.
2. **If/when the migration happens, use the fork's pinned SHA for now.** It is what the opencode
   host itself uses, it keeps `scrollback: 5000` meaningful, and it does not exhibit the
   viewport corruption. Upstream 0.4.0 is smaller and API-identical, but functionally regresses
   history length (~854 lines) and row stability.
3. **Dependency hygiene favours npm.** A versioned npm release is tracked by Renovate/Dependabot
   and scanned by Socket/SBOM tooling; a git-SHA dependency (`github:anomalyco/ghostty-web#…`)
   is opaque to those tools, needs network git access at install time, and would have to be
   bumped by hand. So the target state is: **watch `coder/ghostty-web` releases; once the
   scrollback line→bytes fix and the viewport row-pinning / stale-cell fix are released
   upstream, switch from the git SHA to a versioned npm range.** Until then the cleaner
   dependency graph costs correctness.
4. Intermediate option if a decision is needed now: vendor/patch the two small upstream gaps
   (scrollback unit conversion in `ghostty.ts`; the scrolled-row clear in the WASM) or keep the
   current xterm.js emulator and revisit.

## AC status

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Upstream `ghostty-web@0.4.0` runs in the app, swap unchanged except the dependency | **Done** — only `package.json`/`bun.lock` changed; build, typecheck and e2e green |
| 2 | Local e2e documented and compared with spike 1 (DOM blocker expected) | **Done** — 30–31 pass / 3–4 fail; same 3 deterministic DOM failures as the fork |
| 3 | Bundle measured and compared | **Done** — 803,831 B raw / 239,006 B gzip (−48% raw / −50% gzip vs fork) |
| 4 | Scrollback/viewport behaviour checked and compared with the fork | **Done** — side-by-side probe: upstream caps history at ~854 lines and reproduces transient viewport corruption; fork clean |
| 5 | Recommendation (npm upstream vs fork) documented | **Done** — correctness → fork SHA now; migrate to versioned npm once upstream carries the fixes |

**Blockers:** none for the swap itself. The only hard blocker remains spike 1's canvas/DOM issue
(3 deterministic e2e failures), and it is independent of upstream vs fork.

## How to reproduce

```bash
bun add -d ghostty-web@0.4.0
bun run format && bun run lint && bun run build:prod && bun run typecheck && bun test
bash .local/e2e-local.sh --project=chromium

# side-by-side scrollback/viewport probe (upstream vs fork bundles)
export LD_LIBRARY_PATH=/tmp/opencode/pw-libs/usr/lib64
bun /tmp/opencode/spike2/run-probe.mjs
```
