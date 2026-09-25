import { OpencodeClient } from '@opencode-ai/sdk'
import { initManager } from '../../src/plugin/pty/manager.ts'
import { setParentSessionTitleResolver } from '../../src/plugin/pty/parent-session-title.ts'
import { PTYServer } from '../../src/web/server/server.ts'

/**
 * Server for the README demo recording. Mirrors `test-web-server.ts`, but with
 * fixed parent session titles so the recording is deterministic.
 */

const DEMO_PARENT_TITLES: Record<string, string> = {
  ses_demo_build: 'Refactor CI pipeline',
  ses_demo_api: 'Ship metrics endpoint',
}

initManager(new OpencodeClient())
setParentSessionTitleResolver({
  getTitle: async (sessionID) => DEMO_PARENT_TITLES[sessionID] ?? `Session ${sessionID}`,
})

const server = await PTYServer.createServer()

if (!server.server.url) {
  throw new Error('Server URL not available.')
}

await Bun.write('/tmp/demo-server-port.txt', server.server.url.href)

const response = await fetch(`${server.server.url}/api/sessions`)
if (!response.ok) {
  console.error('Demo server health check failed')
  process.exit(1)
}

console.log(`Demo server ready at ${server.server.url.href}`)
