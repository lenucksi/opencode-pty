import { BUILD_INFO } from '../../../plugin/pty/build-info.ts'
import { manager } from '../../../plugin/pty/manager.ts'
import { JsonResponse } from './responses.ts'

/**
 * Where the PTY server is, which boot it is, and which build it is.
 *
 * Handy for a human, and for a model whose session survived a restart: it can
 * point the user at the UI, tell which generation its session ids belong to, and
 * say which commit it is talking to.
 *
 * The build identity is served rather than baked into the client bundle on
 * purpose. The bundle is built once, but the server it talks to is whatever is
 * listening, and a stale bundle next to a freshly built server would report the
 * wrong commit - which is worse than reporting none, because it looks right.
 */
export function handleServerInfo(server: Bun.Server<undefined>) {
  const store = manager.getSessionStore()
  const description = manager.describeServer()

  return new JsonResponse({
    build: BUILD_INFO,
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
