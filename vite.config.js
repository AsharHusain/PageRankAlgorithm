import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createApiMiddleware } from './server/api.mjs'
import { ensureAllBinaries } from './server/pagerank-service.mjs'

// The PageRank API runs inside the Vite server itself. That keeps the
// developer workflow to a single command (`npm run dev`) with no proxy,
// no second port and no extra dependency -- while the actual computation
// still happens in a spawned C process, never in JavaScript.
function pagerankApi() {
  return {
    name: 'pagerank-c-api',
    configureServer(server) {
      server.middlewares.use(createApiMiddleware({ logger: server.config.logger }))
      // Warm the binaries so the first request from the browser is fast
      // and so compiler problems surface in the terminal immediately.
      ensureAllBinaries().then((r) => {
        for (const [name, s] of Object.entries(r)) {
          if (!s.ok) server.config.logger.error(`[pagerank] ${name}: ${s.error}`)
          else if (s.rebuilt) server.config.logger.info(`[pagerank] compiled ${name}`)
        }
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use(createApiMiddleware())
    },
  }
}

export default defineConfig({
  plugins: [react(), pagerankApi()],
  server: {
    port: 5173
  }
})
