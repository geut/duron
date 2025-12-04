import { serve } from 'bun'

import { sendEmail, variables } from '@shared-actions/index'
import { duron } from 'duron'
import { postgresAdapter } from 'duron/adapters/postgres'
import { createServer } from 'duron/server'
import { getHTML } from 'duron-dashboard/get-html'

// Parent process: Only serves the dashboard API
// This client is configured with syncPattern: false to prevent job processing
// The workers will handle all job processing
const client = duron({
  id: 'dashboard-server',
  syncPattern: false, // Disable automatic job fetching - workers will handle jobs
  database: postgresAdapter({
    connection: process.env.DATABASE_URL || 'postgres://duron:duron@localhost:5435/duron',
  }),
  actions: {
    sendEmail, // Actions must be defined for the server API to work
  },
  variables,
  logger: 'info',
})

// Initialize the client (this sets up the database connection but doesn't start job processing)
await client.start()

// Create the API server
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

// Spawn worker processes
const workerCount = parseInt(process.env.WORKER_COUNT || '2', 10)
const workers: Bun.Subprocess[] = []

for (let i = 1; i <= workerCount; i++) {
  const worker = Bun.spawn(['bun', 'worker.ts'], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      WORKER_ID: `worker-${i}`,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })

  workers.push(worker)
  client.logger.info(`Started worker ${i} (PID: ${worker.pid})`)
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  client.logger.info('Shutting down...')

  // Stop all workers
  for (const worker of workers) {
    worker.kill()
  }

  // Wait for workers to exit
  await Promise.all(workers.map((worker) => worker.exited))

  // Stop the client
  await client.stop()

  process.exit(0)
})

// Start the server
const port = parseInt(process.env.PORT || '3000', 10)
serve({
  port,
  routes: {
    '/': async () => {
      const html = await getHTML({
        url: `http://localhost:${port}/api`,
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

client.logger.info(`🚀 Dashboard server running at http://localhost:${port}`)
client.logger.info(`📊 Monitoring ${workerCount} worker(s)`)
