# Licence and credits

agentterm is MIT-licensed; see [LICENSE](../LICENSE), which carries both the
upstream notice and this fork's.

## The projects this stands on

| Project                                                           | Licence | What it does here                                                                                                                                  |
| ----------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenCode](https://opencode.ai)                                   | MIT     | The host that loads the plugin, its TUI half and this web interface.                                                                               |
| [bun-pty](https://github.com/sursaone/bun-pty)                    | MIT     | The cross-platform PTY bindings every session runs on.                                                                                             |
| [ghostty-web](https://github.com/anomalyco/ghostty-web)           | MIT     | The VT parser behind `pty_screen` and the browser terminal. Pinned as a maintained fork with a local patch whose upstream pull request is pending. |
| [shekohex/opencode-pty](https://github.com/shekohex/opencode-pty) | MIT     | The upstream project this repository forks.                                                                                                        |

## The dependencies

The full notice is **generated, not written**: `bun pm licenses --json` plus the
licence file inside each installed package, reduced at build time into

- `dist/licenses.json` — packages grouped by licence, with the copyright line each
  one ships, and every distinct licence body reproduced once;
- `dist/THIRD-PARTY-NOTICES.md` — the same data as a flat file, for a reader who
  would rather grep than open a browser.

Both travel in the published tarball, which is what "the notice must accompany every
copy" asks for. The web interface shows the same data in the docs dialog's
**Licences** tab, served by `GET /api/licenses`.

Nothing here is hand-maintained except the four rows above, because a project cannot
discover from its lockfile that it is built on another project.
