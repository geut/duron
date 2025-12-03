import { join } from 'node:path'

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import type { Options as PostgresOptions } from 'postgres'

import { type AdapterOptions, PostgresBaseAdapter } from './base.js'
import type createSchema from './schema.js'

type Schema = ReturnType<typeof createSchema>

// Re-export types for backward compatibility
export type { Job, JobStep } from '../adapter.js'

const noop = () => {
  // do nothing
}

export type DB = ReturnType<typeof drizzle<Schema>>

/**
 * PostgreSQL adapter implementation for Duron.
 * Uses Drizzle ORM to interact with PostgreSQL database.
 *
 * @template Options - The adapter options type
 */
export class PostgresAdapter extends PostgresBaseAdapter<DB, PostgresOptions<any> | string> {
  /**
   * Initialize the database connection and Drizzle instance.
   */
  protected override _initDb() {
    const postgresConnection =
      typeof this.connection === 'string'
        ? {
            url: this.connection,
          }
        : this.connection

    this.db = drizzle({
      connection: {
        ...postgresConnection,
        onnotice: noop,
        debug: (connection: number, query: string, parameters: any[], paramTypes: any[]) => {
          this.logger?.trace({ connection, query, parameters, paramTypes }, `PostgresAdapter query`)
        },
      },
      schema: this.tables,
    })
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Start the adapter.
   * Runs migrations if enabled and sets up database listeners.
   *
   * @returns Promise resolving to `true` if started successfully, `false` otherwise
   */
  protected override async _start() {
    if (this.migrateOnStart) {
      await migrate(this.db, {
        migrationsFolder: join(import.meta.dirname, '..', '..', '..', 'migrations', 'postgres'),
        migrationsTable: 'migrations',
        migrationsSchema: 'duron',
      })
    }
    await super._start()
  }

  /**
   * Stop the adapter.
   * Closes the database connection.
   *
   * @returns Promise resolving to `true` if stopped successfully, `false` otherwise
   */
  protected override async _stop() {
    await this.db.$client.end({
      timeout: 5_000,
    })
  }

  // ============================================================================
  // Protected Methods
  // ============================================================================

  /**
   * Send a PostgreSQL notification.
   *
   * @param event - The event name
   * @param data - The data to send
   * @returns Promise resolving to `void`
   */
  protected override async _notify(event: string, data: any): Promise<void> {
    this.logger?.debug({ event, data }, `[PostgresAdapter] Notify ${event}`)
    await this.db.$client.notify(`${this.schema}.${event}`, JSON.stringify(data)).catch((err: Error) => {
      this.logger?.error({ err, data }, `[PostgresAdapter] Failed to notify ${event}`)
    })
  }

  /**
   * Listen for PostgreSQL notifications.
   *
   * @param event - The event name to listen for
   * @param callback - Callback function to handle notifications
   * @returns Promise resolving to an object with an `unlisten` function
   */
  protected override async _listen(
    event: string,
    callback: (payload: string) => void,
  ): Promise<{ unlisten: () => void }> {
    return await this.db.$client.listen(`${this.schema}.${event}`, (payload: string) => {
      callback(payload)
    })
  }
}

export const postgresAdapter = (options: AdapterOptions<PostgresOptions<any> | string>) => {
  return new PostgresAdapter(options)
}
