import { OpencodeClient } from '@opencode-ai/sdk'
import { initManager } from '../../src/plugin/pty/manager.ts'
import { registerSessionUpdateCallback } from '../../src/plugin/pty/manager-notifications.ts'
import { setParentSessionTitleResolver } from '../../src/plugin/pty/parent-session-title.ts'
import { setNoticeEmitter } from '../../src/v2/rpc.ts'
import { PTYServer } from '../../src/web/server/server.ts'

initManager(new OpencodeClient())
setParentSessionTitleResolver({
  getTitle: async (sessionID) => `Parent session ${sessionID}`,
})

const server = await PTYServer.createServer()

/**
 * A notice source, for the toast test.
 *
 * In production the notices come from the plugin's server half - a slash command's
 * result, a roll of the daemon - and this test server does not load that half. What
 * it can cause is a session ending, so that is what it announces, and only for a
 * session whose description asks for it: the rest of the suite must run without a
 * toast on screen.
 */
const NOTICE_PREFIX = 'notice:'
setNoticeEmitter((notice) => server.publishNotice(notice))
registerSessionUpdateCallback((session) => {
  if (!session.description?.startsWith(NOTICE_PREFIX)) return
  if (session.status !== 'exited' && session.status !== 'killed') return
  server.publishNotice({
    message: `Session ${session.description.slice(NOTICE_PREFIX.length)} ended.`,
    variant: 'info',
  })
})

// Only log in non-test environments or when explicitly requested

// Write server URL to file for tests to read
if (process.env.NODE_ENV === 'test') {
  const workerIndex = process.env.TEST_WORKER_INDEX || '0'
  if (!server.server.url) {
    throw new Error('Server URL not available. File an issue if you need this feature.')
  }
  await Bun.write(`/tmp/test-server-port-${workerIndex}.txt`, server.server.url.href)
}

// Health check for test mode
if (process.env.NODE_ENV === 'test') {
  try {
    const response = await fetch(`${server.server.url}/api/sessions`)
    if (!response.ok) {
      console.error('Server health check failed')
      process.exit(1)
    }
  } catch (error) {
    console.error('Server health check failed:', error)
    process.exit(1)
  }
}
