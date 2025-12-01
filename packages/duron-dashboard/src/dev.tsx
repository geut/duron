import { serve } from 'bun'

import { getWeather, openaiChat, sendEmail, variables } from '@shared-actions/index'
import { postgresAdapter } from 'duron/adapters/postgres/postgres'
import { createServer, duron } from 'duron/index'

import index from './index.html'

const client = duron({
  id: 'duron-dashboard',
  syncPattern: 'hybrid',
  database: postgresAdapter({
    connection: process.env.DATABASE_URL || 'postgres://duron:duron@localhost:5435/duron',
    migrateOnStart: true,
  }),
  actions: {
    sendEmail,
    openaiChat,
    getWeather,
  },
  variables,
  logger: 'info',
})

const app = createServer({
  client,
  login: {
    onLogin: async ({ email, password }) => {
      return email === 'test@test.com' && password === 'test'
    },
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-key-change-in-production',
    expirationTime: '1d',
  },
})

const server = serve({
  routes: {
    '/': index,
    '/api/*': app.fetch,
  },
  development: {
    hmr: true,
    console: true,
  },
})

client.logger.info(`🚀 Server running at ${server.url}`)
