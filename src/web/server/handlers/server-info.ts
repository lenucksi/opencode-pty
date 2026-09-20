import { manager } from '../../../plugin/pty/manager.ts'
import { JsonResponse } from './responses.ts'

/**
 * Where the PTY server is and which boot it is.
 *
 * Handy for a human, and for a model whose session survived a restart: it can
 * point the user at the UI and tell which generation its session ids belong to.
 */
export function handleServerInfo(server: Bun.Server<undefined>) {
  const store = manager.getSessionStore()
  const description = manager.describeServer()

  return new JsonResponse({
    generation: description.generation,
    uiUrl: `${server.url.origin}/`,
    port: Number(server.url.port),
    sessions: {
      total: description.sessions,
      running: description.running,
      archived: description.archived,
    },
    persist: {
      enabled: description.persist,
      retention: store.getRetention(),
    },
  })
}
