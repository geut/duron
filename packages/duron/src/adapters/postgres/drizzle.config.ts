import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './migrations/postgres',
  schema: './src/adapters/postgres/schema.default.ts',
  dialect: 'postgresql',
  migrations: {
    schema: 'duron',
    table: 'migrations',
  },
})
