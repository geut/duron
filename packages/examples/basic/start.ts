import { sendEmail, variables } from '@shared-actions/index'
import { duron } from 'duron'
import { postgresAdapter } from 'duron/adapters/postgres'

const client = duron({
  id: 'buddy',
  syncPattern: 'hybrid',
  database: postgresAdapter({
    connection: process.env.DATABASE_URL || 'postgres://duron:duron@localhost:5435/duron',
  }),
  actions: {
    sendEmail,
  },
  variables,
  recoverJobsOnStart: true,
  logger: 'info',
})

await client.start()

client.logger.info('Client started with sync pattern hybrid')
