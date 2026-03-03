# Duron Project Context

> A powerful, type-safe job queue system for Node.js and Bun

## Project Overview

Duron is a modern, type-safe background job processing system built with TypeScript. It provides a robust foundation for executing asynchronous tasks with built-in retry logic, concurrency control, step-based execution, and comprehensive observability.

**Documentation**: https://duron-docs.pages.dev/

## Key Features

- **Type-Safe Actions** - Define actions with Zod schemas for input/output validation
- **Step-Based Execution** - Break down complex workflows into manageable, retryable steps
- **Nested Steps** - Steps can create child steps with proper parent-child tracking and abort signal propagation
- **Intelligent Retry Logic** - Configurable exponential backoff with per-action and per-step options
- **Flexible Sync Patterns** - Pull, push, hybrid, or manual job fetching
- **Advanced Concurrency Control** - Per-action, per-group, and dynamic concurrency limits
- **Multi-Process Support** - Run multiple worker processes sharing the same database
- **Database Adapters** - PostgreSQL (production) and PGLite (development/testing)
- **REST API Server** - Built-in Elysia-based API with advanced filtering and pagination
- **Dashboard UI** - Beautiful React dashboard for real-time job monitoring
- **Telemetry & Observability** - Built-in support for metrics, tracing, and custom observability with pluggable adapters

## Runtime Environment

**This project uses Bun exclusively.** Do not use Node.js, npm, pnpm, yarn, or vite.

### Bun Commands

```bash
# Install dependencies
bun install

# Run a file
bun <file>

# Run tests
bun test

# Run scripts
bun run <script>

# Build
bun build <file>
```

### Bun APIs to Prefer

- `Bun.serve()` - HTTP server with WebSocket support (not express)
- `bun:sqlite` - SQLite (not better-sqlite3)
- `Bun.redis` - Redis (not ioredis)
- `Bun.sql` - Postgres (not pg or postgres.js)
- `Bun.file` - File operations (not node:fs readFile/writeFile)
- `Bun.$` - Shell commands (not execa)
- `bun:test` - Testing framework (not jest or vitest)

### Environment Variables

Bun automatically loads `.env` files. Do not use dotenv.

## Monorepo Structure

```
duron/
├── packages/
│   ├── duron/           # Core library (job queue, actions, adapters, server)
│   ├── duron-dashboard/ # React dashboard UI
│   ├── docs/            # Documentation site (Fumadocs)
│   ├── examples/        # Example implementations
│   ├── shared-actions/  # Shared action definitions for examples
│   └── assets/          # Logo and images
├── biome.jsonc          # Linting configuration
├── package.json         # Workspace root
└── docker-compose.yml   # PostgreSQL for development
```

## Package Details

### `duron` (Core Library)

The main library providing:

- **Client** (`duron/client`) - Main entry point for job processing
- **Actions** (`duron/action`) - Type-safe action definitions with Zod validation
- **Server** (`duron/server`) - Elysia-based REST API server
- **Adapters**:
  - `duron/adapters/postgres` - PostgreSQL adapter for production
  - `duron/adapters/pglite` - PGLite adapter for development/testing
- **Telemetry** - Configured via `telemetry` option on client:
  - `telemetry: { local: true }` - Store spans in the database
  - `telemetry: { traceExporter }` - Export to OpenTelemetry backends
  - No config = telemetry disabled (default)

**Key Dependencies:**
- `zod` - Schema validation
- `drizzle-orm` - Database ORM
- `elysia` - HTTP framework for the server
- `pino` - Logging
- `fastq` - Queue implementation
- `jose` - JWT handling
- `@opentelemetry/api` - OpenTelemetry integration (optional)

### `duron-dashboard` (React Dashboard)

A standalone React dashboard for job monitoring with:

- Real-time job list with filtering and sorting
- Job details with step visualization
- Action execution interface
- Dark/light theme support
- JWT authentication support

**Key Technologies:**
- React 19
- Tailwind CSS 4
- Shadcn/UI components
- TanStack Query & Table
- Motion for animations
- Bun's HTML imports for bundling

### `docs` (Documentation)

Documentation site built with:
- Fumadocs
- TanStack Router
- Vite (exception: docs use Vite for SSR support)

## Development Workflow

### Running the Project

```bash
# Install all dependencies
bun install

# Run tests (duron core)
bun test

# Development modes
bun run dev:duron         # Watch mode for core library
bun run dev:dashboard     # Dashboard dev server
bun run dev:examples:basic # Basic example

# Linting
bun run lint              # Check
bun run lint:fix          # Fix issues

# Type checking
bun run typecheck

# Build all packages
bun run build
```

### Database Setup

Start PostgreSQL with Docker:

```bash
docker-compose up -d
```

Connection string: `postgres://duron:duron@localhost:5435/duron`

### Database Migrations

```bash
# Generate migrations (duron package)
cd packages/duron
bun run generate:postgres
```

## Code Architecture

### Defining Actions

Actions are type-safe job handlers with Zod validation:

```typescript
import { defineAction } from 'duron'
import { z } from 'zod'

const sendEmail = defineAction<typeof variables>()({
  name: 'send-email',
  input: z.object({
    email: z.string().email(),
    subject: z.string(),
    body: z.string(),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  handler: async (ctx) => {
    const { email, subject, body } = ctx.input

    // Steps are retryable units of work
    const result = await ctx.step('send', async ({ signal }) => {
      // Implementation with cancellation support
      return { success: true }
    })

    return result
  },
})
```

### Nested Steps

Steps can create child steps using the `step()` method available in the step handler context. Child steps share abort signals with their parent and are tracked with `parentStepId` in the database.

```typescript
const processOrder = defineAction<typeof variables>()({
  name: 'process-order',
  input: z.object({ orderId: z.string() }),
  output: z.object({ success: z.boolean() }),
  handler: async (ctx) => {
    const result = await ctx.step('process', async ({ step, signal, stepId }) => {
      // stepId is available for the current step
      console.log('Processing step:', stepId)

      // Create child steps - they inherit the parent's abort signal
      const validation = await step('validate', async ({ parentStepId }) => {
        // parentStepId links back to the 'process' step
        return { valid: true }
      })

      // Child steps can also be nested further
      const payment = await step('charge', async ({ step: nestedStep }) => {
        const auth = await nestedStep('authorize', async () => {
          return { authCode: '123' }
        })
        return { charged: true, authCode: auth.authCode }
      })

      return { success: validation.valid && payment.charged }
    })

    return result
  },
})
```

**Important:** All child steps MUST be awaited before the parent step returns. If a parent step completes with unawaited children, Duron will:
1. Abort all pending child steps
2. Wait for them to settle
3. Throw an `UnhandledChildStepsError`

This prevents orphaned processes and ensures proper async patterns.

### Creating a Client

```typescript
import { duron } from 'duron'
import { postgresAdapter } from 'duron/adapters/postgres'

const client = duron({
  id: 'my-worker',
  syncPattern: 'hybrid', // pull | push | hybrid | false
  database: postgresAdapter({
    connection: process.env.DATABASE_URL,
  }),
  actions: { sendEmail },
  variables: { /* shared context */ },
  logger: 'info',
})

await client.start()

// Run an action
const jobId = await client.runAction('send-email', {
  email: 'user@example.com',
  subject: 'Hello',
  body: 'World',
})

// Wait for completion
const job = await client.waitForJob(jobId)
```

### Telemetry & Observability

Duron provides built-in OpenTelemetry support for tracing:

```typescript
import { duron } from 'duron'
import { postgresAdapter } from 'duron/adapters/postgres'

const client = duron({
  database: postgresAdapter({
    connection: process.env.DATABASE_URL,
  }),
  // Enable local telemetry - stores spans in the database
  telemetry: { local: true },
  actions: { sendEmail },
})
```

**Telemetry Configuration Options:**

- `local: true | { flushDelayMs?: number }` - Store spans in the Duron database
- `traceExporter: SpanExporter` - Export to OpenTelemetry-compatible backends (Jaeger, OTLP, etc.)
- `spanProcessors: SpanProcessor[]` - Add custom span processors
- `serviceName: string` - Service name for OpenTelemetry resource (default: `'duron'`)

**Recording Custom Metrics:**

The `telemetry` context is available in action and step handlers for recording custom metrics:

```typescript
const processAI = defineAction()({
  name: 'process-ai',
  handler: async (ctx) => {
    const startTime = Date.now()

    // Record job-level metrics
    ctx.telemetry.recordMetric('ai.request.start', 1)
    const span = ctx.telemetry.getActiveSpan()
    span?.setAttribute('model', 'gpt-4')
    span?.addEvent('processing.started')

    const result = await ctx.step('call-api', async ({ telemetry }) => {
      const response = await callAI(ctx.input)

      // Record step-level metrics
      telemetry.recordMetric('ai.tokens.input', response.inputTokens)
      telemetry.recordMetric('ai.tokens.output', response.outputTokens)
      telemetry.recordMetric('ai.latency.ms', Date.now() - startTime)
      telemetry.getActiveSpan()?.addEvent('api.call.complete', { status: 'success' })

      return response
    })

    return result
  },
})
```

**Accessing Metrics via API:**

When using `telemetry: { local: true }`, spans are stored in the database and accessible via the REST API:

```
GET /api/jobs/:id/spans
GET /api/steps/:id/spans
```

The dashboard also shows metrics when local telemetry is enabled.

### Creating a Server with Dashboard

```typescript
import { createServer } from 'duron/server'
import { getHTML } from 'duron-dashboard/get-html'

const app = createServer({
  client,
  prefix: '/api',
  login: {
    onLogin: async ({ email, password }) => {
      // Validate credentials
      return email === 'admin@example.com' && password === 'secret'
    },
    jwtSecret: process.env.JWT_SECRET,
  },
})

// Serve dashboard
app.get('/', async () => {
  const html = await getHTML({ url: 'http://localhost:3000/api' })
  return new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  })
})

app.listen(3000)
```

## Testing

Tests are in `packages/duron/test/` and use `bun:test`:

```typescript
import { describe, test, expect } from 'bun:test'

describe('Feature', () => {
  test('should work', () => {
    expect(true).toBe(true)
  })
})
```

Run tests:

```bash
bun test                    # All tests
bun test --watch           # Watch mode
bun test specific.test.ts  # Single file
```

## Linting & Formatting

Uses Biome with `biome-standard-mate` configuration:

```bash
bun run lint       # Check
bun run lint:fix   # Auto-fix
```

Key rules:
- Single quotes, semicolons
- 120 character line width
- Organize imports automatically
- No console warnings (use logger instead)

## Dashboard Development

The dashboard uses Bun's HTML imports for development:

```bash
cd packages/duron-dashboard
bun run dev   # Starts on http://localhost:3001
```

**Important:**
- Do not modify files in `src/components/ui/` - these are managed by Shadcn UI
- Use the existing UI components from `src/components/ui/`
- Follow the established patterns in `src/views/` and `src/components/`

## TypeScript Configuration

### Backend (duron core)

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true
  }
}
```

### Frontend (dashboard)

Uses Bun's bundler mode with:
- JSX for React
- Path aliases: `@/*` → `./src/*`

## Key Files Reference

| Path | Description |
|------|-------------|
| `packages/duron/src/index.ts` | Main exports |
| `packages/duron/src/client.ts` | Job queue client |
| `packages/duron/src/action.ts` | Action definitions |
| `packages/duron/src/server.ts` | REST API server |
| `packages/duron/src/adapters/adapter.ts` | Base adapter class |
| `packages/duron/src/adapters/postgres/` | PostgreSQL adapter |
| `packages/duron/src/step-manager.ts` | Step execution and nested step handling |
| `packages/duron/src/telemetry/` | Telemetry adapters (local, opentelemetry, noop) |
| `packages/duron-dashboard/src/DuronDashboard.tsx` | Dashboard root |
| `packages/duron-dashboard/src/views/` | Dashboard pages |
| `packages/examples/basic/start.ts` | Basic example |

## Common Tasks

### Adding a New Action

1. Define the action with `defineAction()` including input/output schemas
2. Add it to the client's `actions` object
3. Generate migrations if needed

### Adding a Dashboard Feature

1. Create component in `packages/duron-dashboard/src/components/`
2. Use existing UI components from `src/components/ui/`
3. Add to appropriate view in `src/views/`
4. Use TanStack Query for data fetching

### Adding an API Endpoint

1. Modify `packages/duron/src/server.ts`
2. Add Zod schemas for validation
3. Follow existing patterns for error handling

## Error Handling

- Use `NonRetriableError` for errors that should not be retried
- Use `UnhandledChildStepsError` is thrown when parent steps complete with unawaited children
- Steps have built-in retry logic with exponential backoff
- Jobs have timeout/expiration settings

```typescript
import { NonRetriableError, UnhandledChildStepsError } from 'duron'

// For errors that should not be retried
if (!apiKey) {
  throw new NonRetriableError('API key is required')
}

// UnhandledChildStepsError is thrown automatically when:
// - A parent step returns before all child steps are awaited
// - The parent step's callback completes but children are still pending
// This error is non-retriable and will fail the entire job
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for dashboard authentication |
| `OPENAI_API_KEY` | For AI-powered examples |

## Contributing Guidelines

1. Use Bun for all operations
2. Run `bun run lint:fix` before committing
3. Ensure tests pass with `bun test`
4. Follow existing code patterns
5. Use TypeScript strict mode
6. Document public APIs with JSDoc

Always use Context7 MCP when I need library/API documentation, code generation, setup or configuration steps without me having to explicitly ask.
