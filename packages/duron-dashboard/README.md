# Duron Dashboard

A beautiful React dashboard for monitoring and managing Duron jobs in real-time. Duron Dashboard can be used as a React component library or as a standalone HTML application.

## Installation

```bash
# Using bun
bun add duron-dashboard

# Using npm
npm install duron-dashboard

# Using pnpm
pnpm add duron-dashboard

# Using yarn
yarn add duron-dashboard
```

## Usage

### As a React Component

Import and use the `DuronDashboard` component in your React application:

```tsx
import { DuronDashboard } from 'duron-dashboard'
import 'duron-dashboard/index.css'

function App() {
  return <DuronDashboard url="https://api.example.com/api" />
}
```

The `url` prop should point to your Duron server API endpoint (typically `/api`).

### As an Inline HTML Application

Use the `getHTML` function to render a fully inlined HTML application. This is useful for server-side rendering where you want to serve a complete HTML page with all assets inlined.

#### Elysia

```ts
import { Elysia } from 'elysia'
import { getHTML } from 'duron-dashboard/get-html'

const app = new Elysia()

app.get('/', async () => {
  const html = await getHTML({ url: 'http://localhost:3000/api' })
  return new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  })
})

app.listen(3000)
```

#### Hono

```ts
import { Hono } from 'hono'
import { getHTML } from 'duron-dashboard/get-html'

const app = new Hono()

app.get('/dashboard', async (c) => {
  const html = await getHTML({ url: 'https://api.example.com/api' })
  return c.html(html)
})
```

#### Express

```ts
import express from 'express'
import { getHTML } from 'duron-dashboard/get-html'

const app = express()

app.get('/dashboard', async (req, res) => {
  const html = await getHTML({ url: 'https://api.example.com/api' })
  res.send(html)
})
```

#### Fastify

```ts
import Fastify from 'fastify'
import { getHTML } from 'duron-dashboard/get-html'

const app = Fastify()

app.get('/dashboard', async (request, reply) => {
  const html = await getHTML({ url: 'https://api.example.com/api' })
  reply.type('text/html').send(html)
})
```

## Features

- **Real-time Updates** - Automatic polling for job status changes
- **Job Management** - View, filter, search, and manage jobs
- **Step Details** - Inspect individual steps within jobs
- **Action Runner** - Create and run new jobs directly from the dashboard
- **Advanced Filtering** - Filter by status, action name, date ranges, and more
- **Dark Mode** - Built-in dark mode support
- **Responsive Design** - Works on desktop and mobile devices

## Authentication

The dashboard requires authentication if your Duron server has login configured. Users will be prompted to log in when accessing the dashboard.

## Development

```bash
# Install dependencies
bun install

# Start development server
bun dev

# Build
bun run build

# Type check
bun run typecheck
```

## License

MIT
