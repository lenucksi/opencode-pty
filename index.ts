/**
 * opencode-pty — the package entry.
 *
 * The bare package name loads the V2 plugin, so `"plugin": ["opencode-pty"]` and
 * `"plugin": ["opencode-pty/v2"]` are the same plugin. It used to be the other way
 * round: the bare name was the V1 plugin, and the V2 half had to be named
 * explicitly - which meant two shapes of the same plugin in one package, and a
 * configuration that broke silently when the host generation changed.
 *
 * The TUI half is a different entry (`opencode-pty/v2/tui`), because a plugin
 * directory can have one and a package export cannot: the host resolves
 * `<plugin>/tui` beside `<plugin>/index`.
 */
export { default } from './src/v2/index.ts'
