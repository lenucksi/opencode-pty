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
    /**
     * "What did the program write?", at three levels of fidelity.
     *
     * `raw` is the byte stream, `plain` is that stream with the ANSI escapes
     * stripped, and both are correct answers to that question: `pty_read` reads
     * from them and its tests depend on them. Neither answers "what does it look
     * like?", because the layout of a full-screen program lives in the escape
     * sequences - strip them and every repaint and every colour change stays as
     * text on its own line.
     */
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
    /**
     * "What does it look like?" - the answer to the question the pair above
     * cannot answer.
     *
     * Replays the same retained output through the same VT emulator `pty_screen`
     * uses and returns the resulting grid, so a reader with no terminal and no
     * ghostty renderer of its own (a TUI plugin, an HTTP client) sees a screen
     * rather than a transcript. `?cols`/`?rows` render at another geometry
     * without touching the session; omitted, they mean the session's own size,
     * exactly as `pty_screen` does.
     *
     * Deliberately not a `buffer` flavour: this is a different question, not a
     * lower-fidelity copy of the same one.
     */
    screen: {
      path: '/api/sessions/:id/screen',
      methods: ['GET'] as const,
    },
  },
} as const
