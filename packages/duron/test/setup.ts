/** oxlint-disable no-console */
import { createContainer, waitForContainer } from './docker.js'

console.log('🔄 Creating postgres container...')

await createContainer({
  image: 'postgres:16-alpine',
  containerName: 'duron-postgres-test',
  ports: [5440, 5432],
  environment: {
    POSTGRES_USER: 'duron',
    POSTGRES_PASSWORD: 'duron',
    POSTGRES_DB: 'duron',
  },
})

console.log('✅ Postgres container created')

await waitForContainer('duron-postgres-test', 'PostgreSQL init process complete')

console.log('✅ Postgres container started')
