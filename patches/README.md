# Patches

Dependency patches applied by `bun install` (see `patchedDependencies` in
`package.json`).

## `ghostty-web.patch`

**Upstream:** `anomalyco/ghostty-web` (pinned to `6e24d04`).
**Remove when:** the fix is released upstream and the pin points to a commit that contains it.

`Terminal.reset()` frees the WASM terminal it was built with and creates a
replacement. `SelectionManager` stores that instance in its constructor, so
after a reset it kept reading the *freed* one:

- `getSelection()` returned empty cells, so copying a highlighted block
  produced blank lines only;
- `getDimensions()` reported the size the old instance was created with
  (80x24), which clamped selection and highlight to that area — dragging past
  those rows did nothing, even though the rendered grid was much larger.

The patch adds `SelectionManager.setWasmTerm()` and calls it from
`Terminal.reset()`, so selection always reads the live buffer.

The application triggers `reset()` whenever the raw stream is re-seeded
(session switch, buffer snapshot, gap resync), which is why the bug was easy to
hit in normal use.
