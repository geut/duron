# Multi-Worker Example

This example demonstrates how to run Duron with multiple worker processes, where the parent process only serves the dashboard API and workers handle all job processing.

## Architecture

- **Parent Process** (`parent.ts`):
  - Serves the dashboard UI and API endpoints
  - Spawns and manages worker processes
  - Client configured with `syncPattern: false` to prevent job processing
  - Only handles API requests for the dashboard

- **Worker Processes** (`worker.ts`):
  - Each worker has a unique ID
  - Processes jobs from the shared database
  - Configured with `syncPattern: 'hybrid'` for efficient job processing
  - Uses `multiProcessMode: true` for proper job recovery

## Running the Example

```bash
# From the examples directory
bun run multi-worker

# Or directly
bun multi-worker/parent.ts
```

## Environment Variables

- `DATABASE_URL`: PostgreSQL connection string (default: `postgres://duron:duron@localhost:5435/duron`)
- `PORT`: Port for the dashboard server (default: `3000`)
- `WORKER_COUNT`: Number of worker processes to spawn (default: `2`)
- `WORKER_ID`: Automatically set for each worker process

## How It Works

1. The parent process creates a Duron client with `syncPattern: false`, which means it won't automatically fetch and process jobs
2. The parent spawns multiple worker processes, each running `worker.ts`
3. Each worker has its own Duron client with `syncPattern: 'hybrid'`, which actively processes jobs
4. All processes share the same database, so jobs created through the dashboard API are picked up by any available worker
5. The dashboard shows jobs from all workers in real-time

## Benefits

- **Scalability**: Add more workers to handle increased load
- **Separation of Concerns**: Dashboard server doesn't compete with workers for resources
- **Fault Tolerance**: If a worker crashes, other workers continue processing jobs
- **Resource Management**: Dashboard server can be scaled independently from workers

## Graceful Shutdown

The example handles graceful shutdown:
- On `SIGINT` (Ctrl+C), all workers are terminated
- The parent process waits for all workers to exit
- The client is properly stopped
