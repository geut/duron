# Duron

A powerful, type-safe job queue system for Node.js and Bun.js. Duron provides a robust foundation for executing asynchronous tasks with built-in retry logic, concurrency control, step-based execution, and comprehensive observability.

## Installation

```bash
# Using bun
bun add duron postgres drizzle-orm@beta

# Using npm
npm install duron postgres drizzle-orm@beta

# Using pnpm
pnpm add duron postgres drizzle-orm@beta

# Using yarn
yarn add duron postgres drizzle-orm@beta
```

## Quick Start

### 1. Define an Action

Actions are the building blocks of Duron. They define what work needs to be done:

```typescript
import { defineAction } from 'duron'
import { z } from 'zod'

const sendEmail = defineAction()({
  name: 'send-email',
  input: z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  handler: async (ctx) => {
    const { to, subject, body } = ctx.input

    // Use steps to break down work into retryable units
    const result = await ctx.step('send-email', async ({ signal }) => {
      const response = await fetch('https://api.email.com/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, body }),
        signal, // Pass signal to enable cancellation
      })

      if (!response.ok) {
        throw new Error('Failed to send email')
      }

      return await response.json()
    })

    return { success: result.success ?? true }
  },
})
```

### 2. Create a Client

```typescript
import { duron } from 'duron'
import { postgresAdapter } from 'duron/adapters/postgres'

const client = duron({
  database: postgresAdapter({
    connection: process.env.DATABASE_URL,
  }),
  actions: {
    sendEmail,
  },
  logger: 'info',
})

await client.start()
```

### 3. Run Actions

```typescript
// Run an action
const jobId = await client.runAction('send-email', {
  to: 'user@example.com',
  subject: 'Hello',
  body: 'Welcome!',
})

// Wait for the job to complete
const job = await client.waitForJob(jobId)
console.log('Job completed:', job?.output)
```

## Key Features

- **Type-Safe** - Full TypeScript support with Zod validation
- **Step-Based Execution** - Break down complex workflows into manageable, retryable steps
- **Intelligent Retry Logic** - Configurable exponential backoff with per-action and per-step options
- **Flexible Sync Patterns** - Pull, push, hybrid, or manual job fetching
- **Advanced Concurrency Control** - Per-action, per-group, and dynamic concurrency limits
- **Reliability & Recovery** - Automatic job recovery, multi-process coordination, and stuck job detection
- **Database Adapters** - PostgreSQL (production) and PGLite (development/testing)
- **REST API Server** - Built-in Elysia-based API with advanced filtering and pagination

## Documentation

- [Getting Started](https://duron.dev/docs/getting-started)
- [Actions](https://duron.dev/docs/actions)
- [Jobs and Steps](https://duron.dev/docs/jobs-and-steps)
- [Client API](https://duron.dev/docs/client-api)
- [Server API](https://duron.dev/docs/server-api)
- [Adapters](https://duron.dev/docs/adapters)
- [Retries](https://duron.dev/docs/retries)
- [Error Handling](https://duron.dev/docs/error-handling)
- [Examples](https://duron.dev/docs/examples)

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Build
bun run build

# Type check
bun run typecheck
```

## License

MIT
