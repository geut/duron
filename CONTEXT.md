# Duron — Domain Glossary

## Core Concepts

**Job** — A unit of work to be executed. Has a status (`created`, `active`, `completed`, `failed`, `expired`, `archived`), a timeout, optional expiry, and optional variables. Jobs are created via the client and processed by workers.

**Step** — A discrete unit of work within a job's execution. Steps are created by action handlers via `ctx.step()`. Steps can be sequential, parallel, or nested. Each step has its own status and timing.

**Action** — A function registered with a Duron client that processes jobs. Actions receive a context (`ActionContext`) with methods for creating steps, accessing variables, and telemetry.

**Worker** — A process that runs a Duron client, fetching and executing jobs. Multiple workers share the same database for horizontal scaling.

**Client** — The primary interface for interacting with Duron. Manages job fetching, execution, heartbeats, and recovery. Created via `duron()`.

## Execution Model

**Sync Pattern** — How a client fetches jobs: `'push'` (listen for NOTIFY), `'pull'` (poll), or `'hybrid'` (both). Configured per-client.

**Concurrency** — Maximum number of jobs a client processes simultaneously.

**Heartbeat** — A periodic upsert to the `clients` table (`last_seen_at`) proving an instance is alive. Used for dead-client detection in recovery.

**Recovery** — The process of detecting and requeuing jobs owned by dead clients (heartbeat older than `heartbeatTimeout`). Runs periodically and on startup.

## Telemetry

**Telemetry (OpenTelemetry)** — Duron instruments all job and step execution with OTel spans via `@opentelemetry/api`. Users connect external collectors via `telemetry: { traceExporter }`.

**TraceExporter** — An OpenTelemetry `SpanExporter` (or array of exporters) that receives completed spans. Users provide their own (e.g., `OTLPTraceExporter`).

## Data Model

**Archive** — Completed/failed/expired jobs are moved from `jobs_active` to `jobs_archive`. Steps follow their parent job.

**Variables** — Key-value data attached to a job, accessible to action handlers via `ctx.variables`.

**Group Key** — A string used for rate limiting and deduplication. Jobs with the same group key are serialized.

## Infrastructure

**Adapter** — Database abstraction layer. Implementations: `PostgresAdapter` (PostgreSQL), `PGLiteAdapter` (embedded PG).

**Advisory Lock** — PostgreSQL mechanism for coordinating workers. Used for serializing jobs with the same group key.

**Client Liveness Table** — A `clients` table storing `client_id` and `last_seen_at`. Updated by heartbeat, queried by recovery to detect dead instances.
