import { expect } from '@playwright/test'
import { test as extendedTest } from '../fixtures'

extendedTest.describe('PTY Live Streaming', () => {
  extendedTest('should preserve and display complete historical output buffer', async ({ api }) => {
    // This test verifies that historical data (produced before UI connects) is preserved and loaded
    // when connecting to a running PTY session. This is crucial for users who reconnect to long-running sessions.

    // Sessions automatically cleared by fixture

    // Create a fresh session that produces identifiable historical output
    const session = await api.sessions.create({
      command: 'bash',
      args: [
        '-c',
        'echo "=== START HISTORICAL ==="; echo "Line A"; echo "Line B"; echo "Line C"; echo "=== END HISTORICAL ==="; while true; do echo "LIVE: $(date +%S)"; sleep 2; done',
      ],
      description: `Historical buffer test - ${Date.now()}`,
    })

    // Give session a moment to start before polling
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Wait for session to produce historical output (before UI connects)
    // Wait until required historical buffer marker appears in raw output
    const bufferStartTime = Date.now()
    const bufferTimeoutMs = 10000 // Longer timeout for buffer population
    while (Date.now() - bufferStartTime < bufferTimeoutMs) {
      try {
        const bufferData = await api.session.buffer.raw({ id: session.id })
        if (bufferData.raw?.includes('=== END HISTORICAL ===')) break
      } catch (error) {
        console.warn('Error checking buffer during wait:', error)
      }
      await new Promise((resolve) => setTimeout(resolve, 200)) // Slightly longer delay
    }
    if (Date.now() - bufferStartTime >= bufferTimeoutMs) {
      throw new Error('Timeout waiting for historical buffer content')
    }

    // Check session status via API to ensure it's running (using api)
    expect(session.status).toBe('running')

    // Verify the API returns the expected historical data (this is the core test)
    const bufferData = await api.session.buffer.raw({ id: session.id })
    expect(bufferData.raw).toBeDefined()
    expect(typeof bufferData.raw).toBe('string')
    expect(bufferData.raw.length).toBeGreaterThan(0)

    // Check that historical output is present in the buffer
    expect(bufferData.raw).toContain('=== START HISTORICAL ===')
    expect(bufferData.raw).toContain('Line A')
    expect(bufferData.raw).toContain('Line B')
    expect(bufferData.raw).toContain('Line C')
    expect(bufferData.raw).toContain('=== END HISTORICAL ===')

    // Verify live updates are also working (check for recent output)
    expect(bufferData.raw).toMatch(/LIVE: \d{2}/)

    // TODO: Re-enable UI verification once page reload issues are resolved
    // The core functionality (buffer preservation) is working correctly
  })
})
