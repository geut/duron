import { drizzle } from 'drizzle-orm/pglite'

import type { PostgresAdapterOptions } from './postgres.js'
import { type DB, PostgresAdapter } from './postgres.js'

type PGLiteDB = ReturnType<typeof drizzle>

/**
 * PGLite adapter implementation for Duron.
 * Extends PostgresAdapter to work with PGLite (in-memory PostgreSQL).
 *
 * @template Options - The adapter options type
 */
export class PGLiteAdapter extends PostgresAdapter {
  override async _stop() {
    await (this.db as unknown as PGLiteDB).$client.close()
  }

  /**
   * Map database query results to the expected format.
   * PGLite returns results in a `rows` property, so we extract that.
   *
   * @param result - The raw database query result
   * @returns The mapped result (result.rows)
   */
  protected override _map(result: any) {
    return result.rows
  }

  /**
   * Initialize the PGLite database connection.
   * Creates a new Drizzle instance without connection options.
   */
  protected override _initDb() {
    let connection = ':memory:'
    // it means that the user is using a file path, so we need to use the file path
    if (typeof this.options.connection === 'string' && !this.options.connection.startsWith('postgres://')) {
      connection = this.options.connection
    }
    if (connection === ':memory:') {
      this.db = drizzle() as unknown as DB
    } else {
      this.db = drizzle(connection) as unknown as DB
    }
  }

  /**
   * Send a PGLite notification.
   *
   * @param event - The event name
   * @param data - The data to send
   * @returns Promise resolving to `void`
   */
  protected override async _notify(event: string, data: any): Promise<void> {
    await (this.db as unknown as PGLiteDB).$client.query(
      `NOTIFY "${this.options.schema}.${event}", '${JSON.stringify(data)}'`,
    )
  }

  /**
   * Listen for PGLite notifications.
   *
   * @param event - The event name to listen for
   * @param callback - Callback function to handle notifications
   * @returns Promise resolving to an object with an `unlisten` function
   */
  protected override async _listen(
    event: string,
    callback: (payload: string) => void,
  ): Promise<{ unlisten: () => void }> {
    const unlisten = await (this.db as unknown as PGLiteDB).$client.listen(
      `"${this.options.schema}.${event}"`,
      (payload: string) => {
        callback(payload)
      },
    )

    return {
      unlisten,
    }
  }
}

export const pgliteAdapter = (options: PostgresAdapterOptions) => {
  return new PGLiteAdapter(options)
}
