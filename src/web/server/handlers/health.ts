import { getPtyManager } from '../../../plugin/pty/manager.ts'
import type { HealthResponse } from '../../shared/types.ts'
import { JsonResponse } from './responses.ts'

export async function handleHealth(server: Bun.Server<undefined>) {
  const sessions = await getPtyManager().list()
  const activeSessions = (sessions as any[]).filter((s: any) => s.status === 'running').length
  const totalSessions = sessions.length

  // Calculate response time (rough approximation)
  const startTime = Date.now()

  const healthResponse: HealthResponse = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    sessions: {
      total: totalSessions,
      active: activeSessions,
    },
    websocket: {
      connections: server.pendingWebSockets,
    },
    memory: process.memoryUsage
      ? {
          rss: process.memoryUsage().rss,
          heapUsed: process.memoryUsage().heapUsed,
          heapTotal: process.memoryUsage().heapTotal,
        }
      : undefined,
  }

  // Add response time
  const responseTime = Date.now() - startTime
  healthResponse.responseTime = responseTime

  return new JsonResponse(healthResponse)
}
