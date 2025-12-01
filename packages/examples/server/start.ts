import { serve } from 'bun'

import { sendEmail } from '@shared-actions/index'
import { duron } from 'duron'
import { postgresAdapter } from 'duron/adapters/postgres'
import { createServer } from 'duron/server'
import { getHTML } from 'duron-dashboard/get-html'

const client = duron({
  database: postgresAdapter({
    connection: process.env.DATABASE_URL || 'postgres://duron:duron@localhost:5435/duron',
  }),
  actions: {
    sendEmail,
  },
  logger: 'info',
})

const app = createServer({
  client,
  // login: {
  //   onLogin: async ({ email, password }) => {
  //     return email === 'admin@example.com' && password === 'password'
  //   },
  //   jwtSecret: process.env.JWT_SECRET || 'your-secret-key',
  //   expirationTime: '24h',
  // },
})

const server = serve({
  routes: {
    '/': async () => {
      const html = await getHTML({
        url: 'http://localhost:3000/api',
        enableLogin: false,
        showLogo: false,
      })
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' },
      })
    },
    '/api/*': app.fetch,
  },
})

client.logger.info(`Server running at ${server.url}`)
