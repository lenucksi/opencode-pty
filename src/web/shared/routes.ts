export const routes = {
  websocket: {
    path: '/ws',
    methods: ['GET'] as const,
  },
  health: {
    path: '/health',
    methods: ['GET'] as const,
  },
  server: {
    path: '/api/server',
    methods: ['GET'] as const,
  },
  docs: {
    path: '/api/docs',
    methods: ['GET'] as const,
  },
  sessions: {
    path: '/api/sessions',
    methods: ['GET', 'POST', 'DELETE'] as const,
    /**
     * Collection-level removal, as opposed to `DELETE /api/sessions` which
     * removes everything.
     *
     * `bulk` and `restore` are static segments sitting beside `session.path`'s
     * `:id`. Bun prefers a static segment over a parameter, so these two win
     * over `/api/sessions/:id`; a test pins that down, because the day somebody
     * adds `POST /api/sessions/:id` the two start to mean the same thing.
     */
    bulk: {
      path: '/api/sessions/bulk',
      methods: ['POST'] as const,
    },
    restore: {
      path: '/api/sessions/restore',
      methods: ['POST'] as const,
    },
  },
  parentSessions: {
    path: '/api/parent-sessions',
    methods: ['GET'] as const,
  },
  session: {
    path: '/api/sessions/:id',
    methods: ['GET', 'DELETE'] as const,
    input: {
      path: '/api/sessions/:id/input',
      methods: ['POST'] as const,
    },
    cleanup: {
      path: '/api/sessions/:id/cleanup',
      methods: ['DELETE'] as const,
    },
    log: {
      path: '/api/sessions/:id/log',
      methods: ['GET'] as const,
    },
    buffer: {
      raw: {
        path: '/api/sessions/:id/buffer/raw',
        methods: ['GET'] as const,
      },
      plain: {
        path: '/api/sessions/:id/buffer/plain',
        methods: ['GET'] as const,
      },
    },
  },
} as const
