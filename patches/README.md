# Patches

Dependency patches applied by `bun install` (see `patchedDependencies` in
`package.json`).

## `ghostty-web.patch`

**Upstream:** `anomalyco/ghostty-web` (pinned to `6e24d04`).
**Remove when:** the fix is released upstream and the pin points to a commit that contains it.

`Terminal.reset()` frees the WASM terminal it was built with and creates a
replacement. Components created during `open()` could retain the freed instance,
so they kept reading stale state after a reset:

- `SelectionManager.getSelection()` returned empty cells, so copying a
  highlighted block produced blank lines only;
- selection dimensions came from the old instance (for example 80x24), which
  clamped selection and highlighting to the stale grid;
- application mouse-mode callbacks could continue querying the freed terminal
  instead of the replacement buffer.

The patch resolves selection and mouse-mode state from the terminal's current
WASM instance, clears selection state before freeing the old instance, and keeps
the existing Shift override for native text selection. The application triggers
`reset()` whenever the raw stream is re-seeded (session switch, buffer snapshot,
gap resync), which is why the bug was easy to hit in normal use.

### Backport: resolved black backgrounds

`anomalyco/ghostty-web#8` (`4a7026e`) fixes explicit RGB black cell
backgrounds on non-black themes. The renderer used to treat every resolved
`(0, 0, 0)` cell as transparent, even though Ghostty had already resolved the
application's requested color. The patch paints that cell as real black while
preserving selection and inverse-video precedence.

Remove this hunk when the pin points to a commit containing the upstream fix.

### Backport: fragmented OSC color queries

`anomalyco/ghostty-web#9` (`5006e8e`) replaces the regex-based OSC 10/11
observer with bounded byte-wise parser state. The backport handles fragmented
string and binary writes, combined foreground/background queries, matching BEL
or ST reply terminators, cancellation, escape interruption, and terminal reset.
It also refreshes Ghostty's render state before returning resolved colors.

The scope remains 7-bit OSC foreground/background queries. Raw C1 controls,
additional color slots, and per-query snapshots interleaved with color changes
inside one WASM write remain outside this patch.

Remove this hunk when the pin points to a commit containing the upstream fix.
