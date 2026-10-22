import { describe, expect, it } from 'bun:test'

// This test ensures `bun pm pack` (which triggers the package's `prepack` script)
// produces a tarball that includes the built web UI (`dist/web/**`) and the
// plugin bundle (`dist/opencode-pty.js`). `bun pm pack` is used because the
// suite is bun-based and must not require a separate `npm` install.

async function run(cmd: string[], opts: { cwd?: string } = {}) {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // Wait for stdout/stderr and for the process to exit. In some Bun
  // versions `proc.exitCode` may be null until the process finishes,
  // so await `proc.exited` to reliably get the exit code.
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

function findPackFileFromOutput(stdout: string): string | null {
  // `bun pm pack` prints the created tarball filename on its own line
  const lines = stdout.trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line?.trim().endsWith('.tgz')) return line.trim()
  }
  return null
}

describe('package pack structure', () => {
  it('includes dist web assets', async () => {
    // 1) Create tarball via bun pm pack (triggers prepack build)
    const pack = await run(['bun', 'pm', 'pack'])
    expect(pack.code).toBe(0)
    const tgz = findPackFileFromOutput(pack.stdout)
    expect(typeof tgz).toBe('string')

    // 2) List tarball contents via tar -tf
    const list = await run(['tar', '-tf', tgz as string])
    expect(list.code).toBe(0)
    const files = list.stdout.split(/\r?\n/).filter(Boolean)

    // 3) Validate required files exist; NPM tarballs use 'package/' prefix
    expect(files).toContain('package/dist/web/index.html')

    // At least one hashed JS and CSS asset
    const hasJsAsset = files.some((f) => /package\/dist\/web\/assets\/[^/]+\.js$/.test(f))
    const hasCssAsset = files.some((f) => /package\/dist\/web\/assets\/[^/]+\.css$/.test(f))
    expect(hasJsAsset).toBeTrue()
    expect(hasCssAsset).toBeTrue()

    // 4) Cleanup the pack file
    await run(['rm', '-f', tgz as string])
  }, 20000)

  it('ships the MCP server and the tool descriptions it needs', async () => {
    // The MCP server is a bin, and it reads the descriptions from the text files
    // beside the compiled tools. A package without them starts and then answers
    // every call with nothing.
    const pack = await run(['bun', 'pm', 'pack'])
    expect(pack.code).toBe(0)
    const tgz = findPackFileFromOutput(pack.stdout)
    expect(typeof tgz).toBe('string')

    const list = await run(['tar', '-tf', tgz as string])
    expect(list.code).toBe(0)
    const files = list.stdout.split(/\r?\n/).filter(Boolean)

    expect(files).toContain('package/dist/src/mcp/entry.js')
    expect(files).toContain('package/dist/src/mcp/index.js')
    expect(files).toContain('package/dist/src/mcp/server.js')
    // Every description the tools import.
    for (const name of ['spawn', 'write', 'read', 'list', 'kill', 'wait', 'resize', 'screen']) {
      expect(files).toContain(`package/dist/src/plugin/pty/tools/${name}.txt`)
    }

    await run(['rm', '-f', tgz as string])
  }, 20000)
})
