import { sendEmail, variables } from '@shared-actions/index'
import { duron } from 'duron'
import { postgresAdapter } from 'duron/adapters/postgres'

// Worker process: Processes jobs from the database
// Each worker has a unique ID and processes jobs independently
const workerId = process.env.WORKER_ID || `worker-${process.pid}`

const client = duron({
  id: workerId,
  syncPattern: 'hybrid', // Use hybrid sync pattern for efficient job processing
  database: postgresAdapter({
    connection: process.env.DATABASE_URL || 'postgres://duron:duron@localhost:5435/duron',
  }),
  actions: {
    sendEmail,
  },
  variables,
  logger: 'debug',
  recoverJobsOnStart: true,
  heartbeatInterval: 5000, // Heartbeat interval for liveness detection
  heartbeatTimeout: 15000, // Consider dead after 15s
})

await client.start()

client.logger.info(`✅ Worker ${workerId} started and ready to process jobs`)

// Keep the process alive
process.on('SIGINT', async () => {
  client.logger.info(`Shutting down worker ${workerId}...`)
  await client.stop()
  process.exit(0)
})
