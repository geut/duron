import type { Adapter } from '../src/adapters/adapter.js'
import { PGLiteAdapter } from '../src/adapters/postgres/pglite.js'
import { PostgresAdapter } from '../src/adapters/postgres/postgres.js'
import { getPostgresConnection } from './docker.js'

export type { Adapter } from '../src/adapters/adapter.js'

export type AdapterInstance = {
  adapter: Adapter
  deleteDb: () => Promise<void>
  connectionUrl: string
}

export interface AdapterFactory {
  name: 'postgres' | 'pglite'
  create: (options?: any) => Promise<AdapterInstance>
}

export const postgresFactory: AdapterFactory = {
  name: 'postgres',
  create: async (options: any = {}) => {
    const { CONNECTION_URL, deleteDb } = await getPostgresConnection({
      containerName: 'duron-postgres-test',
      port: 5440,
    })

    return {
      adapter: new PostgresAdapter({
        connection: CONNECTION_URL,
        migrateOnStart: true,
        ...options,
      }),
      deleteDb,
      connectionUrl: CONNECTION_URL,
    }
  },
}

export const pgliteFactory: AdapterFactory = {
  name: 'pglite',
  create: async (options: any = {}) => {
    return {
      adapter: new PGLiteAdapter({
        connection: ':memory:',
        migrateOnStart: true,
        ...options,
      }),
      deleteDb: () => Promise.resolve(),
      connectionUrl: ':memory:',
    }
  },
}
